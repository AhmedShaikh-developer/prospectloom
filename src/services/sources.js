// Automatic lead sources with credit awareness.
//
// Each paid/limited provider (Apollo, Hunter.io, HubSpot import) has a state row. The autopilot
// pulls from a source while it works. When the provider says "out of credits", "rate limited" or
// "not in your plan", the source waits — until the credit reset date when the provider tells us,
// otherwise it re-checks daily — and then resumes exactly where it stopped (Apollo keeps its page
// cursor per keyword × city, HubSpot keeps its paging cursor, Hunter keeps a per-company marker).
import { q, nowIso, logActivity } from '../db/index.js';
import { getBool, getNum } from '../lib/settings.js';
import * as apollo from '../integrations/apollo.js';
import * as hunter from '../integrations/hunter.js';
import * as hubspot from '../integrations/hubspot.js';
import { SourceError } from '../lib/sourceError.js';
import { importRecords } from './discovery.js';
import { runJob, runningJob } from './jobs.js';
import { getCompany } from './companies.js';
import { verifyCompany } from './verification.js';
import { confirmEmailOnPage } from '../lib/siteScan.js';
import { preferenceScore } from '../lib/emailRules.js';
import { rootDomain, emailDomain, normalizeDomain } from '../lib/normalize.js';

const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const DM_TITLE = /\b(founder|co-?founder|owner|ceo|chief executive|president|managing (director|partner)|principal|partner|director|coo|cto)\b/i;

export const SOURCES = {
  apollo: {
    label: 'Apollo',
    what: 'Finds companies and decision-makers by keyword × city (people search: no credits, no emails). Runs inside the Lead engine.',
    configured: () => apollo.isConfigured(),
    enabled: () => getBool('engine_apollo_enabled') && getBool('apollo_api_search_enabled'),
  },
  hunter: {
    label: 'Hunter.io',
    what: 'Finds the email a company published on the web, for companies whose own website shows none. Confirms it on their site when it can.',
    configured: () => hunter.isConfigured(),
    enabled: () => getBool('source_hunter_enabled'),
    run: runHunter,
  },
  hubspot: {
    label: 'HubSpot',
    what: 'Imports the companies in your HubSpot CRM as leads (read-only, deduplicated by website).',
    configured: () => hubspot.isConfigured(),
    enabled: () => getBool('source_hubspot_import'),
    run: runHubspotImport,
  },
};

// ---------------------------------------------------------------- state
export function getState(name) {
  const row = q.get('SELECT * FROM source_state WHERE source = :s', { s: name });
  const st = row || { source: name, status: 'idle', runs: 0, found: 0, imported: 0 };
  let credits = null; try { credits = st.credits ? JSON.parse(st.credits) : null; } catch { /* ignore */ }
  return { ...st, credits };
}

function save(name, patch) {
  const cur = getState(name);
  const n = { ...cur, ...patch };
  q.run(`INSERT INTO source_state (source, status, message, resume_at, credits, cursor, runs, found, imported, last_run_at, last_ok_at, updated_at)
    VALUES (:source, :status, :message, :resume_at, :credits, :cursor, :runs, :found, :imported, :last_run_at, :last_ok_at, :now)
    ON CONFLICT(source) DO UPDATE SET status = excluded.status, message = excluded.message, resume_at = excluded.resume_at, credits = excluded.credits,
      cursor = excluded.cursor, runs = excluded.runs, found = excluded.found, imported = excluded.imported,
      last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, updated_at = excluded.updated_at`, {
    source: name, status: n.status, message: n.message ?? null, resume_at: n.resume_at ?? null,
    credits: n.credits ? JSON.stringify(n.credits) : null, cursor: n.cursor ?? null, runs: n.runs || 0, found: n.found || 0,
    imported: n.imported || 0, last_run_at: n.last_run_at ?? null, last_ok_at: n.last_ok_at ?? null, now: nowIso(),
  });
}

/** The key or settings changed: forget the old verdict so the source is checked again right away. */
export function resetSource(name) {
  if (!SOURCES[name]) return;
  save(name, { status: 'idle', message: null, resume_at: null });
  if (name === 'apollo') q.run("UPDATE engine_targets SET status = 'pending', error = NULL, next_run_at = NULL WHERE source = 'apollo' AND status = 'waiting'");
}

/** Record a provider problem and decide when to try again. */
export function noteError(name, e) {
  const label = SOURCES[name]?.label || name;
  const now = Date.now();
  let status; let resume;
  switch (e.kind) {
    case 'credits': {
      status = 'waiting_credits';
      const reset = e.resetAt && Date.parse(e.resetAt) > now ? Date.parse(e.resetAt) + 5 * 60_000 : now + 24 * HOUR;
      resume = iso(reset);
      break;
    }
    case 'rate': status = 'rate_limited'; resume = iso(now + Math.max(30, e.retryAfter || 60) * 1000); break;
    case 'plan': status = 'plan'; resume = iso(now + 7 * 24 * HOUR); break;
    case 'auth': status = 'auth'; resume = null; break;
    default: status = 'error'; resume = iso(now + HOUR);
  }
  const when = resume ? new Date(resume).toISOString().replace('T', ' ').slice(0, 16) : null;
  const message = {
    waiting_credits: `Out of credits — waiting. Checks again ${when} UTC and continues where it stopped.`,
    rate_limited: `Rate limit reached — continues automatically at ${when} UTC.`,
    plan: `Your ${label} plan does not include this API — checked again weekly. ${e.message}`,
    auth: `${e.message}`,
    error: `${e.message} — retrying at ${when} UTC.`,
  }[status];
  save(name, { status, message, resume_at: resume, last_run_at: nowIso() });
  if (name === 'apollo') {
    // Every Apollo keyword × city waits too, keeping its page cursor for when credits return.
    q.run(`UPDATE engine_targets SET status = 'waiting', error = :m, next_run_at = :r WHERE source = 'apollo'`,
      { m: message, r: resume || iso(now + 30 * 24 * HOUR) });
  }
  logActivity(null, 'source_waiting', { source: name, status, message }, 'automation');
  return getState(name);
}

/** Apollo ran fine inside the lead engine. */
export function noteSuccess(name, { found = 0, imported = 0 } = {}) {
  const st = getState(name);
  save(name, { status: 'ready', message: null, resume_at: null, runs: (st.runs || 0) + 1, found: (st.found || 0) + found, imported: (st.imported || 0) + imported, last_run_at: nowIso(), last_ok_at: nowIso() });
}

// ---------------------------------------------------------------- run / check
/** Run one batch of a source as a tracked job. */
export function runSource(name) {
  const def = SOURCES[name];
  if (!def?.run) throw new Error(`${def?.label || name} runs inside the Lead engine`);
  if (!def.configured()) throw new Error(`${def.label} is not connected — add the key in Integrations`);
  if (runningJob(`source:${name}`)) throw new Error(`${def.label} is already running`);
  const { id, promise } = runJob(`source:${name}`, `${def.label}: ${name === 'hunter' ? 'finding published emails' : 'importing companies'}`, { source: name }, async (ctx) => {
    const st = getState(name);
    save(name, { status: 'running', message: null });
    const add = (r) => ({ runs: (st.runs || 0) + 1, found: (st.found || 0) + (r.found || 0), imported: (st.imported || 0) + (r.imported || 0) });
    try {
      const r = await def.run(ctx, st);
      save(name, { status: r.done ? 'done' : 'ready', message: r.summary, resume_at: r.resumeAt || null, cursor: r.cursor ?? null, credits: r.credits || st.credits, last_run_at: nowIso(), last_ok_at: nowIso(), ...add(r) });
      return r;
    } catch (e) {
      if (e.partial) save(name, { credits: e.partial.credits || st.credits, ...add(e.partial) });
      noteError(name, e);
      throw e;
    }
  });
  return { jobId: id, promise };
}

/** Ask the provider whether it works and how many credits are left (free calls only). */
export async function checkSource(name) {
  const def = SOURCES[name];
  if (!def) throw new Error('Unknown source');
  if (!def.configured()) throw new Error(`${def.label} is not connected — add the key in Integrations`);
  try {
    if (name === 'hunter') {
      const a = await hunter.account();
      if (a.left <= 0) { noteError(name, new SourceError('No searches left', 'credits', { resetAt: a.resetAt })); save(name, { credits: a }); return getState(name); }
      save(name, { status: 'ready', message: `${a.left} of ${a.available} searches left this month`, resume_at: null, credits: a });
    } else if (name === 'apollo') {
      const r = await apollo.probe();
      save(name, { status: 'ready', message: r.detail, resume_at: null });
      // Credits are back: every waiting keyword × city continues from its page cursor.
      q.run("UPDATE engine_targets SET status = 'pending', error = NULL, next_run_at = NULL WHERE source = 'apollo' AND status = 'waiting'");
    } else if (name === 'hubspot') {
      await hubspot.testConnection();
      save(name, { status: getState(name).status === 'done' ? 'done' : 'ready', message: 'Connected', resume_at: null });
    }
  } catch (e) {
    if (e.kind) noteError(name, e); else noteError(name, Object.assign(e, { kind: 'other' }));
  }
  return getState(name);
}

/** Scheduler entry: run whatever is enabled and due. Waiting sources are re-checked when their time comes. */
export async function tick() {
  const now = new Date().toISOString();
  const out = {};
  for (const [name, def] of Object.entries(SOURCES)) {
    if (!def.configured() || !def.enabled()) continue;
    const st = getState(name);
    if (st.status === 'auth' || st.status === 'running') continue;
    if (st.resume_at && st.resume_at > now) continue;
    if (name === 'apollo') {
      // Apollo itself runs inside the lead engine; here we only re-check it after a pause.
      if (['waiting_credits', 'rate_limited', 'plan', 'error'].includes(st.status)) out.apollo = (await checkSource('apollo')).status;
      continue;
    }
    if (runningJob(`source:${name}`)) continue;
    try { await runSource(name).promise; out[name] = 'ran'; } catch (e) { out[name] = e.kind || 'error'; }
  }
  return out;
}

export function listSources() {
  return Object.entries(SOURCES).map(([name, def]) => {
    const st = getState(name);
    return { name, label: def.label, what: def.what, configured: def.configured(), enabled: def.enabled(), ...st };
  });
}

// ---------------------------------------------------------------- Hunter.io: emails for companies whose site shows none
async function runHunter(ctx) {
  const acct = await hunter.account();
  if (acct.left <= 0) throw new SourceError(`Hunter: no searches left this month — waiting until ${acct.resetAt ? acct.resetAt.slice(0, 10) : 'they renew'}`, 'credits', { resetAt: acct.resetAt });
  const n = Math.min(acct.left, Math.max(1, getNum('hunter_batch_per_run') || 10));
  const rows = q.all(`SELECT id FROM companies WHERE status IN ('HOLD_VERIFY','RESEARCHING') AND (contact_email IS NULL OR contact_email = '')
      AND site_status IS NOT 'offline' AND hunter_checked_at IS NULL AND domain IS NOT NULL AND screen_count >= 1
    ORDER BY (status = 'HOLD_VERIFY') DESC, fit_score DESC NULLS LAST, id ASC LIMIT :n`, { n });
  const r = { found: 0, imported: 0, credits: acct, checked: 0 };
  for (const [i, { id }] of rows.entries()) {
    const c = getCompany(id);
    ctx.progress(i, rows.length, `Looking up ${c.domain}`);
    let emails;
    try { emails = await hunter.domainSearch(c.domain); } catch (e) {
      if (['credits', 'rate', 'auth', 'plan'].includes(e.kind)) { e.partial = r; throw e; }
      continue;
    }
    r.checked++;
    q.run('UPDATE companies SET hunter_checked_at = :now WHERE id = :id', { now: nowIso(), id });
    const pick = emails
      .filter((e) => rootDomain(emailDomain(e.email)) === rootDomain(c.domain) && preferenceScore(e.email, c.domain) > 1)
      .map((e) => ({ ...e, score: preferenceScore(e.email, c.domain) + (DM_TITLE.test(e.position) ? 50 : 0) + e.confidence / 100 }))
      .sort((a, b) => b.score - a.score)[0];
    if (!pick) continue;
    r.found++;
    // Prefer proof on their own website: if Hunter saw the address on one of their pages, check that page ourselves.
    const own = pick.sources.find((s) => rootDomain(normalizeDomain(s.uri)) === rootDomain(c.domain));
    let confirmed = false;
    if (own) confirmed = (await confirmEmailOnPage(pick.email, own.uri).catch(() => ({}))).confirmed === true;
    const isDm = !!pick.name && DM_TITLE.test(pick.position);
    const patch = {
      contact_email: pick.email,
      email_source_url: confirmed ? own.uri : pick.sources[0].uri,
      email_evidence_type: confirmed ? 'official_website' : 'hunter_io',
      email_source_confirmed: confirmed ? 1 : 0,
      email_contact_type: isDm ? 'decision_maker' : 'general',
      email_purpose: isDm ? `${pick.position} — published address found by Hunter.io` : 'Published business address found by Hunter.io',
      email_checked_at: nowIso(), email_auto_selected: 1,
      notes: [c.notes, `Email ${pick.email} found by Hunter.io on ${pick.sources[0].uri}${confirmed ? ' (confirmed on their own site)' : ''}`].filter(Boolean).join('\n'),
    };
    if (isDm && !c.dm_name) Object.assign(patch, { dm_name: pick.name, dm_title: pick.position });
    const sets = Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
    q.run(`UPDATE companies SET ${sets}, updated_at = :__now, last_progress_at = :__now WHERE id = :__id`, { ...patch, __now: nowIso(), __id: id });
    // Full automated checks (MX, source page, dedup, suppression) — not just a re-evaluation.
    const v = await verifyCompany(id, { scan: false, useHubspot: false });
    if (v.after === 'READY') r.imported++;
    logActivity(id, 'hunter_email', { email: pick.email, confirmed }, 'automation');
  }
  r.credits = { ...acct, left: Math.max(0, acct.left - r.found), used: acct.used + r.found };
  r.summary = rows.length ? `${r.checked} companies checked · ${r.found} emails found · ${r.imported} now ready to email` : 'Nothing to look up — every company without an email has been checked';
  r.resumeAt = iso(Date.now() + 30 * 60_000); // pace: one batch every 30 minutes
  return r;
}

// ---------------------------------------------------------------- HubSpot: import CRM companies as leads
async function runHubspotImport(ctx, st) {
  ctx.progress(0, 1, 'Reading companies from HubSpot');
  const { results, next } = await hubspot.listCompanies({ after: st.cursor || undefined, limit: 100 });
  const records = results.map((x) => ({
    name: x.properties?.name, domain: x.properties?.domain || x.properties?.website, website: x.properties?.website,
    industry: x.properties?.industry,
  })).filter((x) => x.name && x.domain);
  const imp = records.length ? importRecords(records, { origin: 'hubspot', label: 'HubSpot import' }) : { created: 0 };
  return {
    found: results.length, imported: imp.created, cursor: next, done: !next,
    resumeAt: next ? iso(Date.now() + 60_000) : iso(Date.now() + 7 * 24 * HOUR), // whole CRM read: look for new companies weekly
    summary: `${results.length} HubSpot companies read · ${imp.created} new leads${next ? '' : ' · all pages imported'}`,
  };
}
