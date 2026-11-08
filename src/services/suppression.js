// Phase 5: deduplication and suppression cross-checks.
import { q, nowIso, logActivity } from '../db/index.js';
import { normalizeEmail, normalizeDomain, emailDomain, rootDomain } from '../lib/normalize.js';
import { getSetting } from '../lib/settings.js';
import { PERMANENT_SUPPRESSIONS } from '../lib/constants.js';

export function addSuppression({ kind, value, reason, source = 'manual', note = '' }) {
  const v = kind === 'email' ? normalizeEmail(value) : normalizeDomain(value);
  if (!v) throw new Error(`Invalid ${kind}: ${value}`);
  q.run(
    `INSERT INTO suppressions (kind, value, reason, source, note) VALUES (:kind, :value, :reason, :source, :note)
     ON CONFLICT(kind, value, reason) DO NOTHING`,
    { kind, value: v, reason, source, note },
  );
  logActivity(null, 'suppression_added', { kind, value: v, reason, source }, source === 'manual' ? 'user' : 'system');
  return v;
}

export function removeSuppression(id) {
  const row = q.get('SELECT * FROM suppressions WHERE id = :id', { id });
  if (!row) throw new Error('Not found');
  if (PERMANENT_SUPPRESSIONS.has(row.reason)) throw new Error('Opt-outs and complaints cannot be removed');
  q.run('DELETE FROM suppressions WHERE id = :id', { id });
  logActivity(null, 'suppression_removed', row);
}

/**
 * Collect every conflict for a company. Hard conflicts block READY.
 * types: opt_out, complaint, bounce, do_not_contact, competitor, previously_contacted, duplicate_email, hubspot_contacted
 */
export function findConflicts(company) {
  const conflicts = [];
  const domain = normalizeDomain(company.domain);
  const root = rootDomain(domain);
  const email = normalizeEmail(company.contact_email);
  const eDomain = email ? emailDomain(email) : '';

  // 1. Suppression list (email + company domain + email domain)
  const supp = q.all(
    `SELECT * FROM suppressions WHERE (kind = 'email' AND value = :email)
       OR (kind = 'domain' AND value IN (:domain, :root, :edomain))`,
    { email: email || '-', domain: domain || '-', root: root || '-', edomain: eDomain || '-' },
  );
  for (const s of supp) {
    const type = s.reason === 'previously_contacted' ? 'previously_contacted' : s.reason;
    conflicts.push({ type, hard: true, detail: `Suppressed ${s.kind} ${s.value}: ${s.reason}${s.note ? ` (${s.note})` : ''}` });
  }

  // 2. Messages already sent from this system to this company/domain/email
  const sent = q.get(
    `SELECT m.id, m.to_email, m.sent_at FROM messages m JOIN companies c ON c.id = m.company_id
     WHERE m.status IN ('sent','bounced') AND m.kind = 'intro' AND (c.domain = :domain OR m.to_email = :email OR c.id = :id) LIMIT 1`,
    { domain, email: email || '-', id: company.id ?? -1 },
  );
  if (sent) conflicts.push({ type: 'previously_contacted', hard: true, detail: `Intro already sent to ${sent.to_email} on ${String(sent.sent_at).slice(0, 10)}` });

  // 3. Hostinger mailbox history (Sent folder synced over IMAP)
  const hist = q.get(
    `SELECT email, date, folder FROM mail_history WHERE direction = 'out' AND (domain IN (:domain, :root) OR email = :email) ORDER BY date DESC LIMIT 1`,
    { domain: domain || '-', root: root || '-', email: email || '-' },
  );
  if (hist && !sent) conflicts.push({ type: 'previously_contacted', hard: true, detail: `Mailbox ${hist.folder} shows mail to ${hist.email} on ${String(hist.date).slice(0, 10)}` });

  const inbound = q.get(
    `SELECT email, date FROM mail_history WHERE direction = 'in' AND (domain IN (:domain, :root) OR email = :email) ORDER BY date DESC LIMIT 1`,
    { domain: domain || '-', root: root || '-', email: email || '-' },
  );
  if (inbound) conflicts.push({ type: 'existing_conversation', hard: true, detail: `Existing inbound conversation from ${inbound.email} on ${String(inbound.date).slice(0, 10)}` });

  // 4. Another company record already uses the same recipient
  if (email) {
    const dup = q.get('SELECT id, name FROM companies WHERE contact_email = :email AND id != :id LIMIT 1', { email, id: company.id ?? -1 });
    if (dup) conflicts.push({ type: 'duplicate_email', hard: true, detail: `Same recipient already used by company #${dup.id} (${dup.name})` });
  }

  // 5. HubSpot stage shows prior outreach
  const contacted = getSetting('hubspot_contacted_stages').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (company.hubspot_stage && contacted.includes(String(company.hubspot_stage).toUpperCase())) {
    const t = ['DO_NOT_CONTACT'].includes(String(company.hubspot_stage).toUpperCase()) ? 'do_not_contact' : 'previously_contacted';
    conflicts.push({ type: t, hard: true, detail: `HubSpot ll_outreach_stage = ${company.hubspot_stage}` });
  }
  return conflicts;
}

/** Run Phase 5 checks for one company and persist the result. */
export function runDedup(company) {
  const conflicts = findConflicts(company);
  q.run('UPDATE companies SET dedup_checked_at = :at, dedup_conflicts = :c, updated_at = :at WHERE id = :id', {
    at: nowIso(), c: JSON.stringify(conflicts), id: company.id,
  });
  return conflicts;
}
