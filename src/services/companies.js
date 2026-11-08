import { q, nowIso, logActivity } from '../db/index.js';
import { normalizeDomain, normalizeEmail, normalizeUrl } from '../lib/normalize.js';
import { evaluate } from '../lib/qualification.js';
import { getSetting, getNum, getBool } from '../lib/settings.js';
import { findConflicts } from './suppression.js';
import { STATUS } from '../lib/constants.js';

// Fields a user (or importer) may set directly.
export const EDITABLE_FIELDS = [
  'name', 'website', 'offer', 'lead_origin', 'us_presence', 'us_presence_url', 'industry', 'services', 'description', 'profile_url',
  'employee_count', 'employee_count_url', 'employee_count_date', 'dm_name', 'dm_title', 'dm_url', 'dm_verified', 'portfolio_url', 'portfolio_note',
  'personalization', 'personalization_url', 'fit_score', 'fit_rationale', 'contact_email', 'email_source_url', 'email_evidence_type',
  'email_contact_type', 'email_purpose', 'email_manual_confirmed', 'manual_application_url', 'notes',
];
const URL_FIELDS = new Set(['website', 'us_presence_url', 'profile_url', 'employee_count_url', 'dm_url', 'portfolio_url', 'personalization_url', 'email_source_url', 'manual_application_url']);

function sanitize(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (URL_FIELDS.has(field)) return normalizeUrl(value) || null;
  if (field === 'contact_email') return normalizeEmail(value) || null;
  if (field === 'employee_count' || field === 'fit_score') {
    const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'email_manual_confirmed' || field === 'dm_verified') return value && value !== '0' ? 1 : 0;
  if (field === 'offer') return ['A', 'B', 'C'].includes(String(value).toUpperCase()) ? String(value).toUpperCase() : null;
  return String(value).trim();
}

export function complianceStatus() {
  const missing = [];
  if (!getSetting('sender_name')) missing.push('sender name');
  if (!getSetting('sender_email')) missing.push('sender email');
  if (!getSetting('sender_postal_address')) missing.push('physical postal address');
  if (!getSetting('unsubscribe_text')) missing.push('opt-out instruction');
  return { ok: missing.length === 0, missing };
}

export function getCompany(id) {
  return q.get('SELECT * FROM companies WHERE id = :id', { id });
}

export function getByDomain(domain) {
  return q.get('SELECT * FROM companies WHERE domain = :domain', { domain: normalizeDomain(domain) });
}

/** Evaluate without persisting. */
export function evaluateCompany(company) {
  return evaluate(company, {
    conflicts: findConflicts(company),
    compliance: complianceStatus(),
    settings: { emailRecheckDays: getNum('email_recheck_days'), dedupRecheckDays: getNum('dedup_recheck_days'), mode: getSetting('pipeline_mode'), allowProviderEmails: getBool('allow_provider_emails') },
  });
}

/** Re-run the decision engine and persist status changes. */
export function reevaluate(id, actor = 'system') {
  const c = getCompany(id);
  if (!c) return null;
  const ev = evaluateCompany(c);
  const now = nowIso();
  const patch = {};
  if (ev.status !== c.status || ev.reason !== c.status_reason) {
    patch.status = ev.status;
    patch.status_reason = ev.reason;
  }
  if (ev.researchComplete && !c.research_completed_at) patch.research_completed_at = now;
  if (!ev.researchComplete && c.research_completed_at) patch.research_completed_at = null;
  if (ev.status === STATUS.READY && c.status !== STATUS.READY) patch.ready_at = now;
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
    q.run(`UPDATE companies SET ${sets}, updated_at = :now WHERE id = :id`, { ...patch, now, id });
    if (patch.status) {
      logActivity(id, 'status_changed', { from: c.status, to: ev.status, reason: ev.reason }, actor);
      if (c.status !== ev.status) q.run('UPDATE companies SET last_progress_at = :now WHERE id = :id', { now, id });
    }
  }
  return { ...getCompany(id), evaluation: ev };
}

/**
 * Create a company or merge into the existing one (by normalized domain).
 * Merge only fills blank fields — it never overwrites existing evidence.
 * Returns { company, created, merged, skipped, reason }.
 */
export function upsertCompany(input, { origin = 'manual', actor = 'user' } = {}) {
  const domain = normalizeDomain(input.domain || input.website || (input.contact_email ? input.contact_email.split('@')[1] : ''));
  if (!domain) return { skipped: true, reason: 'No valid domain' };
  const existing = getByDomain(domain);
  const fields = {};
  for (const f of EDITABLE_FIELDS) {
    const v = sanitize(f, input[f]);
    if (v !== undefined && v !== null) fields[f] = v;
  }
  if (fields.contact_email && !fields.email_evidence_type) {
    // Imported emails are never treated as public-source confirmed.
    fields.email_evidence_type = { apollo: 'apollo_database', clay: 'clay_enrichment', hubspot: 'hubspot_existing' }[origin] || (origin === 'csv' ? 'imported_list' : null);
  }
  const now = nowIso();
  if (fields.contact_email) fields.email_checked_at = now;
  if (existing) {
    const fill = {};
    for (const [k, v] of Object.entries(fields)) {
      if (existing[k] === null || existing[k] === '' || existing[k] === undefined) fill[k] = v;
    }
    if (!fill.contact_email) delete fill.email_checked_at;
    if (Object.keys(fill).length) {
      const sets = Object.keys(fill).map((k) => `${k} = :${k}`).join(', ');
      q.run(`UPDATE companies SET ${sets}, updated_at = :now WHERE id = :id`, { ...fill, now, id: existing.id });
      logActivity(existing.id, 'merged', { origin, filled: Object.keys(fill) }, actor);
    }
    reevaluate(existing.id, actor);
    return { company: getCompany(existing.id), merged: true, filledFields: Object.keys(fill) };
  }
  const row = {
    name: fields.name || input.name || domain,
    domain,
    lead_origin: fields.lead_origin || origin,
    research_started_at: now,
    ...fields,
  };
  row.website = row.website || `https://${domain}`;
  const cols = Object.keys(row);
  const res = q.run(`INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`, row);
  const id = Number(res.lastInsertRowid);
  logActivity(id, 'created', { origin }, actor);
  reevaluate(id, actor);
  return { company: getCompany(id), created: true };
}

/** Update evidence fields from the UI. Contact changes reset confirmation flags. */
export function updateCompany(id, input, actor = 'user') {
  const c = getCompany(id);
  if (!c) throw new Error('Company not found');
  const patch = {};
  for (const f of EDITABLE_FIELDS) {
    if (!(f in input)) continue;
    const v = sanitize(f, input[f]);
    if (v === undefined) continue;
    if (String(v ?? '') !== String(c[f] ?? '')) patch[f] = v;
  }
  if (input.domain !== undefined) {
    const d = normalizeDomain(input.domain);
    if (!d) throw new Error('Invalid domain');
    if (d !== c.domain) {
      const other = getByDomain(d);
      if (other) throw new Error(`Domain ${d} already belongs to company #${other.id} (${other.name})`);
      patch.domain = d;
    }
  }
  if (!Object.keys(patch).length) return reevaluate(id, actor);
  const now = nowIso();
  // A human edit means "look again": a new website address clears the old site verdict too.
  patch.next_screen_at = null;
  if ('website' in patch || 'domain' in patch) patch.site_status = null;
  if ('contact_email' in patch || 'email_source_url' in patch) {
    patch.email_source_confirmed = null;
    patch.mx_valid = 'contact_email' in patch ? null : c.mx_valid;
    patch.email_auto_selected = 0;
    if (!('email_manual_confirmed' in patch)) patch.email_manual_confirmed = 0;
    patch.dedup_checked_at = null;
  }
  if (['contact_email', 'email_source_url', 'email_evidence_type', 'email_contact_type', 'email_purpose', 'email_manual_confirmed'].some((k) => k in patch)) {
    patch.email_checked_at = now;
  }
  const sets = Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
  q.run(`UPDATE companies SET ${sets}, updated_at = :now, last_progress_at = :now WHERE id = :id`, { ...patch, now, id });
  logActivity(id, 'updated', Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { from: c[k] ?? null, to: v }])), actor);
  return reevaluate(id, actor);
}

export function setStatusManually(id, status, reason, actor = 'user') {
  const c = getCompany(id);
  if (!c) throw new Error('Company not found');
  const allowed = ['DO_NOT_CONTACT', 'EXCLUDED'];
  if (!allowed.includes(status) && !(status === 'UNLOCK')) throw new Error(`Status ${status} cannot be set manually; it is computed by the decision engine`);
  const now = nowIso();
  if (status === 'UNLOCK') {
    if (c.status === STATUS.DO_NOT_CONTACT) throw new Error('Do-not-contact cannot be unlocked');
    q.run('UPDATE companies SET status_locked = 0, updated_at = :now WHERE id = :id', { now, id });
    logActivity(id, 'status_unlocked', { from: c.status }, actor);
    return reevaluate(id, actor);
  }
  q.run('UPDATE companies SET status = :status, status_reason = :reason, status_locked = 1, updated_at = :now WHERE id = :id', {
    status, reason: reason || (status === 'DO_NOT_CONTACT' ? 'Marked do-not-contact' : 'Excluded manually'), now, id,
  });
  logActivity(id, 'status_set', { from: c.status, to: status, reason }, actor);
  return getCompany(id);
}

export function listCompanies({ status, offer, search, contacted, hasEmail, origin, site, limit = 200, offset = 0, sort = 'updated' } = {}) {
  const where = [];
  const p = { limit: Math.min(Number(limit) || 200, 1000), offset: Number(offset) || 0 };
  if (status) {
    const list = String(status).split(',');
    where.push(`status IN (${list.map((_, i) => ':s' + i).join(',')})`);
    list.forEach((s, i) => { p['s' + i] = s; });
  }
  if (offer) { where.push('offer = :offer'); p.offer = offer; }
  if (contacted === 'yes') where.push("status IN ('SENT','FOLLOW_UP','REPLIED','BOUNCED')");
  if (contacted === 'no') where.push("status NOT IN ('SENT','FOLLOW_UP','REPLIED','BOUNCED','DO_NOT_CONTACT')");
  if (hasEmail === 'yes') where.push('contact_email IS NOT NULL');
  if (hasEmail === 'no') where.push('contact_email IS NULL');
  if (origin) { where.push('lead_origin LIKE :origin'); p.origin = `${origin}%`; }
  if (['blocked', 'offline', 'no_web'].includes(site)) { where.push('site_status = :site'); p.site = site; }
  if (search) { where.push('(name LIKE :search OR domain LIKE :search OR contact_email LIKE :search OR dm_name LIKE :search)'); p.search = `%${search}%`; }
  const order = { updated: 'updated_at DESC', fit: 'fit_score DESC NULLS LAST, updated_at DESC', name: 'name COLLATE NOCASE ASC', created: 'created_at DESC' }[sort] || 'updated_at DESC';
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = q.all(`SELECT * FROM companies ${w} ORDER BY ${order} LIMIT :limit OFFSET :offset`, p);
  const total = q.get(`SELECT COUNT(*) AS n FROM companies ${w}`, p).n;
  return { rows, total };
}

export function deleteCompany(id) {
  const c = getCompany(id);
  if (!c) throw new Error('Company not found');
  const sent = q.get("SELECT COUNT(*) AS n FROM messages WHERE company_id = :id AND status IN ('sent','bounced')", { id }).n;
  if (sent) throw new Error('Companies with sent messages cannot be deleted (keeps send history for dedup). Mark them do-not-contact instead.');
  q.run('DELETE FROM companies WHERE id = :id', { id });
  logActivity(id, 'deleted', { name: c.name, domain: c.domain });
}
