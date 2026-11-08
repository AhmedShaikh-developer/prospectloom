// Lead engine: finds new leads around the clock. It works through every (business type × city)
// target from OpenStreetMap — plus Apollo keyword searches when an Apollo key is enabled —
// one search at a time at a polite pace, imports businesses with their own website, and
// re-visits each target after N days to pick up new businesses. Research then runs on them.
import { q, nowIso, logActivity } from '../db/index.js';
import { getSetting, getNum, getBool, setSetting } from '../lib/settings.js';
import * as osm from '../integrations/osm.js';
import * as apollo from '../integrations/apollo.js';
import { importLocal, importRecords } from './discovery.js';
import { dropDeadSites } from '../lib/dns.js';
import { runJob, runningJob } from './jobs.js';

const lines = (s) => [...new Set(String(s || '').split(/\n|;/).map((x) => x.trim()).filter(Boolean))];
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function config() {
  return {
    enabled: getBool('engine_enabled'),
    categories: list(getSetting('engine_categories')),
    locations: lines(getSetting('engine_locations')),
    perHour: Math.max(1, Math.min(60, getNum('engine_searches_per_hour') || 20)),
    rescanDays: getNum('engine_rescan_days') || 30,
    dailyCap: getNum('engine_daily_cap') || 1500,
    apollo: getBool('engine_apollo_enabled') && apollo.isConfigured() && getBool('apollo_api_search_enabled'),
    apolloKeywords: lines(getSetting('engine_apollo_keywords')),
    apolloTitles: getSetting('engine_apollo_titles'),
    apolloWanted: getBool('engine_apollo_enabled'),
    apolloReady: apollo.isConfigured() && getBool('apollo_api_search_enabled'),
  };
}

/** Make the target table match the configuration (keeps history for targets that stay). */
export function syncTargets() {
  const c = config();
  const wanted = [];
  for (const loc of c.locations) for (const cat of c.categories) wanted.push(['osm', cat, loc]);
  if (c.apollo) for (const loc of c.locations) for (const kw of c.apolloKeywords) wanted.push(['apollo', kw, loc]);
  for (const [source, category, location] of wanted) {
    q.run('INSERT INTO engine_targets (source, category, location) VALUES (:source, :category, :location) ON CONFLICT DO NOTHING', { source, category, location });
  }
  const keep = new Set(wanted.map((w) => w.join('|')));
  const all = q.all('SELECT id, source, category, location, runs FROM engine_targets');
  let removed = 0;
  for (const t of all) {
    if (!keep.has(`${t.source}|${t.category}|${t.location}`)) { q.run('DELETE FROM engine_targets WHERE id = :id', { id: t.id }); removed++; }
  }
  return { targets: wanted.length, removed };
}

export function importedToday() {
  return q.get("SELECT COUNT(*) AS n FROM companies WHERE lead_origin IN ('openstreetmap','apollo') AND date(created_at, 'localtime') = date('now', 'localtime')").n;
}

/** Next due target: never-run first, then oldest whose re-scan date has passed. */
export function nextTarget() {
  return q.get(`SELECT * FROM engine_targets WHERE (next_run_at IS NULL OR next_run_at <= :now)
    ORDER BY (last_run_at IS NULL) DESC, last_run_at ASC, id ASC LIMIT 1`, { now: nowIso() });
}

function plusHours(h) { return new Date(Date.now() + h * 3600_000).toISOString(); }

async function runOsm(t, ctx) {
  const cat = osm.CATEGORIES.find((c) => c.id === t.category);
  if (!cat) throw new Error('Unknown business type');
  ctx.progress(0, 1, `Searching ${cat.label} in ${t.location}`);
  const r = await osm.findBusinesses({ categoryId: t.category, location: t.location, limit: 150 });
  const known = new Set(q.all(`SELECT domain FROM companies WHERE domain IN (${r.results.map((_, i) => ':d' + i).join(',') || "''"})`,
    Object.fromEntries(r.results.map((x, i) => ['d' + i, x.domain]))).map((x) => x.domain));
  const candidates = r.results.filter((x) => !known.has(x.domain));
  // Map listings are often years old: skip businesses whose website domain no longer exists.
  if (candidates.length) ctx.progress(0, 1, `Checking ${candidates.length} websites still exist`);
  const { results: fresh, dead } = await dropDeadSites(candidates);
  const imp = fresh.length ? importLocal(fresh) : { created: 0 };
  return { found: r.results.length, imported: imp.created, deadSites: dead, label: `${cat.label} in ${t.location}` };
}

async function runApollo(t, ctx) {
  ctx.progress(0, 1, `Apollo: "${t.category}" in ${t.location} (page ${t.cursor})`);
  const people = await apollo.searchPeople({ keywords: t.category, locations: [t.location.replace(/, USA$/, ', United States')], page: t.cursor, perPage: 100,
    titles: list(getSetting('engine_apollo_titles')) });
  const imp = people.length ? importRecords(people.map((p) => ({ name: p.name, domain: p.domain, website: p.website, industry: p.industry })), { origin: 'apollo', label: 'Lead engine (Apollo)' }) : { created: 0 };
  return { found: people.length, imported: imp.created, exhausted: people.length === 0, label: `Apollo "${t.category}" in ${t.location}` };
}

/** Run one target now (as a tracked job). */
export function runTarget(t) {
  setSetting('engine_last_run', nowIso());
  const { id, promise } = runJob('engine', 'Lead engine search', { targetId: t.id }, async (ctx) => {
    const now = nowIso();
    try {
      const r = t.source === 'apollo' ? await runApollo(t, ctx) : await runOsm(t, ctx);
      const rescanH = getNum('engine_rescan_days') * 24 || 720;
      const apolloNext = t.source === 'apollo' && !r.exhausted;
      q.run(`UPDATE engine_targets SET status = 'done', error = NULL, runs = runs + 1, found = found + :found, imported = imported + :imported,
        last_run_at = :now, cursor = :cursor, next_run_at = :next WHERE id = :id`, {
        found: r.found, imported: r.imported, now, id: t.id,
        cursor: t.source === 'apollo' ? (r.exhausted ? 1 : t.cursor + 1) : 1,
        next: apolloNext ? now : plusHours(rescanH),
      });
      return { ...r, summary: `${r.label}: ${r.found} found, ${r.imported} new${r.deadSites ? `, ${r.deadSites} skipped (website no longer exists)` : ''}` };
    } catch (e) {
      // Busy/timeout errors: retry in an hour. Bad location: retry much later.
      const permanent = /Could not find|whole/.test(e.message);
      q.run("UPDATE engine_targets SET status = 'error', error = :err, runs = runs + 1, last_run_at = :now, next_run_at = :next WHERE id = :id",
        { err: e.message, now, next: plusHours(permanent ? 24 * 30 : 1), id: t.id });
      throw e;
    }
  });
  return { jobId: id, promise };
}

/** Scheduler entry point: run the next due target if the pace and daily cap allow. */
export async function tick({ force = false } = {}) {
  const c = config();
  if (!force && !c.enabled) return { skipped: 'engine off' };
  if (runningJob('engine')) return { skipped: 'a search is already running' };
  if (!force) {
    const last = getSetting('engine_last_run');
    if (last && Date.now() - new Date(last).getTime() < (60 / c.perHour) * 60_000) return { skipped: 'pacing' };
    if (importedToday() >= c.dailyCap) return { skipped: 'daily cap reached' };
  }
  syncTargets();
  const t = nextTarget() || (force ? q.get('SELECT * FROM engine_targets ORDER BY last_run_at ASC LIMIT 1') : null);
  if (!t) return { skipped: 'nothing due — every target was searched recently' };
  const { jobId, promise } = runTarget(t);
  try { return { jobId, ...(await promise) }; } catch (e) { return { jobId, error: e.message }; }
}

export function status() {
  const c = config();
  const t = q.get(`SELECT COUNT(*) AS total, SUM(last_run_at IS NOT NULL) AS searched, SUM(status = 'error') AS errors,
    COALESCE(SUM(found), 0) AS found, COALESCE(SUM(imported), 0) AS imported FROM engine_targets`);
  const leads = q.get(`SELECT COUNT(*) AS total, SUM(contact_email IS NOT NULL) AS withEmail, SUM(status = 'READY') AS ready,
    SUM(status IN ('SENT','FOLLOW_UP','REPLIED','BOUNCED')) AS contacted FROM companies`);
  const remaining = (t.total || 0) - (t.searched || 0);
  return {
    ...c, targets: t.total || 0, searched: t.searched || 0, errors: t.errors || 0, found: t.found, imported: t.imported,
    importedToday: importedToday(), lastRun: getSetting('engine_last_run') || null,
    etaHours: remaining > 0 ? Math.ceil(remaining / c.perHour) : 0, leads,
    recent: q.all('SELECT * FROM engine_targets WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 25'),
    running: runningJob('engine'),
  };
}

export function logEngine(detail) { logActivity(null, 'lead_engine', detail, 'engine'); }
