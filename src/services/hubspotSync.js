// Phase 7: HubSpot synchronization with an auditable propose -> approve -> execute -> confirm flow.
import { q, nowIso, today, logActivity } from '../db/index.js';
import * as hubspot from '../integrations/hubspot.js';
import { getStageMap } from '../lib/settings.js';
import { getCompany, upsertCompany, reevaluate } from './companies.js';
import { normalizeDomain } from '../lib/normalize.js';

/** The evidence-backed property values we would write for a company. */
export function desiredProperties(c) {
  const stageMap = getStageMap();
  const props = {};
  const stage = stageMap[c.status];
  if (stage) props.ll_outreach_stage = stage;
  // Only push email fields that are public-source confirmed.
  if (c.contact_email && (c.email_source_confirmed === 1 || c.email_manual_confirmed === 1)) {
    props.ll_public_contact_email = c.contact_email;
    if (c.email_source_url) props.ll_email_source_url = c.email_source_url;
    if (c.email_evidence_type) props.ll_email_evidence_type = c.email_evidence_type;
    if (c.email_checked_at) props.ll_last_verified_date = String(c.email_checked_at).slice(0, 10);
  }
  if (['DO_NOT_CONTACT', 'BOUNCED', 'EXCLUDED'].includes(c.status) && c.status_reason) props.ll_suppression_reason = c.status_reason.slice(0, 250);
  if (c.last_sent_date) props.ll_last_sent_date = String(c.last_sent_date).slice(0, 10);
  return props;
}

/**
 * Build proposed operations by reading HubSpot's current values first.
 * Never executes writes. Returns the list of proposals created.
 */
export async function proposeSync(companyIds) {
  if (!hubspot.isConfigured()) throw new Error('HubSpot is not configured');
  const proposals = [];
  for (const id of companyIds) {
    const c = getCompany(id);
    if (!c) continue;
    const pending = q.get("SELECT id FROM hubspot_ops WHERE company_id = :id AND status IN ('proposed','approved')", { id });
    if (pending) { proposals.push({ companyId: id, skipped: 'already has a pending proposal', opId: pending.id }); continue; }
    const desired = desiredProperties(c);
    let existing = null;
    try {
      existing = c.hubspot_id ? await hubspot.getCompanyById(c.hubspot_id).catch(() => null) : null;
      if (!existing) existing = await hubspot.findCompanyByDomain(c.domain);
    } catch (e) {
      proposals.push({ companyId: id, error: e.message });
      continue;
    }
    if (existing) {
      const before = {};
      const diff = {};
      for (const [k, v] of Object.entries(desired)) {
        const cur = existing.properties?.[k] ?? null;
        before[k] = cur;
        // Preserve existing history: never overwrite a recorded suppression reason.
        if (k === 'll_suppression_reason' && cur) continue;
        if (String(cur ?? '') !== String(v ?? '')) diff[k] = v;
      }
      q.run('UPDATE companies SET hubspot_id = :hid, hubspot_stage = :stage, hubspot_checked_at = :now WHERE id = :id', {
        hid: existing.id, stage: existing.properties?.ll_outreach_stage || null, now: nowIso(), id,
      });
      if (!Object.keys(diff).length) { proposals.push({ companyId: id, skipped: 'HubSpot already up to date' }); continue; }
      const res = q.run(`INSERT INTO hubspot_ops (company_id, operation, hubspot_id, payload, before) VALUES (:cid, 'update', :hid, :payload, :before)`, {
        cid: id, hid: existing.id, payload: JSON.stringify(diff), before: JSON.stringify(before),
      });
      proposals.push({ companyId: id, opId: Number(res.lastInsertRowid), operation: 'update', diff });
    } else {
      const payload = { name: c.name, domain: c.domain, website: c.website, ...desired };
      const res = q.run(`INSERT INTO hubspot_ops (company_id, operation, payload, before) VALUES (:cid, 'create', :payload, '{}')`, {
        cid: id, payload: JSON.stringify(payload),
      });
      proposals.push({ companyId: id, opId: Number(res.lastInsertRowid), operation: 'create', diff: payload });
    }
  }
  logActivity(null, 'hubspot_proposed', { count: proposals.filter((p) => p.opId && !p.skipped).length }, 'system');
  return proposals;
}

export function listOps(status) {
  const rows = status
    ? q.all('SELECT o.*, c.name, c.domain FROM hubspot_ops o LEFT JOIN companies c ON c.id = o.company_id WHERE o.status = :status ORDER BY o.id DESC LIMIT 500', { status })
    : q.all('SELECT o.*, c.name, c.domain FROM hubspot_ops o LEFT JOIN companies c ON c.id = o.company_id ORDER BY o.id DESC LIMIT 500');
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}'), before: JSON.parse(r.before || '{}'), response: r.response ? JSON.parse(r.response) : null }));
}

export function setOpStatus(ids, status) {
  if (!['approved', 'discarded', 'proposed'].includes(status)) throw new Error('Invalid status');
  let n = 0;
  for (const id of ids) {
    const r = q.run("UPDATE hubspot_ops SET status = :status WHERE id = :id AND status IN ('proposed','approved')", { status, id });
    n += Number(r.changes);
  }
  logActivity(null, `hubspot_ops_${status}`, { ids }, 'user');
  return n;
}

/** Execute approved operations. A write counts as confirmed only after a re-read matches. */
export async function executeApproved() {
  const ops = q.all("SELECT * FROM hubspot_ops WHERE status = 'approved' ORDER BY id");
  const stats = { attempted: 0, confirmed: 0, failed: 0, blocked: 0 };
  for (const op of ops) {
    stats.attempted++;
    const payload = JSON.parse(op.payload);
    try {
      // Re-check for duplicates right before creating.
      if (op.operation === 'create') {
        const c = getCompany(op.company_id);
        const dupe = c ? await hubspot.findCompanyByDomain(c.domain) : null;
        if (dupe) {
          q.run("UPDATE hubspot_ops SET status = 'blocked', response = :r, executed_at = :now WHERE id = :id", {
            r: JSON.stringify({ reason: `Company already exists in HubSpot (${dupe.id}); re-propose as update` }), now: nowIso(), id: op.id,
          });
          q.run('UPDATE companies SET hubspot_id = :hid WHERE id = :cid', { hid: dupe.id, cid: op.company_id });
          stats.blocked++;
          continue;
        }
      }
      const result = op.operation === 'create' ? await hubspot.createCompany(payload) : await hubspot.updateCompany(op.hubspot_id, payload);
      const hid = result.id || op.hubspot_id;
      const check = await hubspot.getCompanyById(hid);
      const mismatched = Object.entries(payload).filter(([k, v]) => k.startsWith('ll_') && String(check.properties?.[k] ?? '') !== String(v ?? ''));
      if (mismatched.length) {
        q.run("UPDATE hubspot_ops SET status = 'failed', response = :r, executed_at = :now WHERE id = :id", {
          r: JSON.stringify({ reason: 'Re-read did not match', mismatched: mismatched.map(([k]) => k) }), now: nowIso(), id: op.id,
        });
        stats.failed++;
        continue;
      }
      q.run("UPDATE hubspot_ops SET status = 'confirmed', hubspot_id = :hid, response = :r, executed_at = :now WHERE id = :id", {
        hid, r: JSON.stringify({ id: hid, confirmedAt: nowIso() }), now: nowIso(), id: op.id,
      });
      q.run('UPDATE companies SET hubspot_id = :hid, hubspot_stage = :stage, hubspot_checked_at = :now WHERE id = :cid', {
        hid, stage: check.properties?.ll_outreach_stage ?? null, now: nowIso(), cid: op.company_id,
      });
      logActivity(op.company_id, 'hubspot_write_confirmed', { op: op.id, operation: op.operation, properties: Object.keys(payload) }, 'system');
      stats.confirmed++;
    } catch (e) {
      q.run("UPDATE hubspot_ops SET status = 'failed', response = :r, executed_at = :now WHERE id = :id", {
        r: JSON.stringify({ error: e.message }), now: nowIso(), id: op.id,
      });
      stats.failed++;
    }
  }
  q.run(`INSERT INTO runs (kind, started_at, finished_at, status, stats, report) VALUES ('hubspot', :now, :now, :status, :stats, :report)`, {
    now: nowIso(), status: stats.failed ? 'partial' : 'ok', stats: JSON.stringify(stats),
    report: `HubSpot sync ${today()}: attempted ${stats.attempted}, confirmed ${stats.confirmed}, failed ${stats.failed}, blocked ${stats.blocked}`,
  });
  return stats;
}

/** Import companies from HubSpot into the local inventory (read-only). */
export async function importFromHubspot({ maxPages = 20 } = {}) {
  const stats = { read: 0, created: 0, merged: 0, skipped: 0 };
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const { results, next } = await hubspot.listCompanies({ after });
    for (const r of results) {
      stats.read++;
      const p = r.properties || {};
      const domain = normalizeDomain(p.domain || p.website);
      if (!domain) { stats.skipped++; continue; }
      const res = upsertCompany({
        name: p.name, domain, website: p.website, industry: p.industry,
        contact_email: p.ll_public_contact_email, email_source_url: p.ll_email_source_url,
        email_evidence_type: p.ll_public_contact_email ? 'hubspot_existing' : undefined,
      }, { origin: 'hubspot', actor: 'import' });
      if (res.skipped) { stats.skipped++; continue; }
      q.run('UPDATE companies SET hubspot_id = :hid, hubspot_stage = :stage, hubspot_checked_at = :now WHERE id = :id', {
        hid: r.id, stage: p.ll_outreach_stage || null, now: nowIso(), id: res.company.id,
      });
      if (p.ll_suppression_reason) q.run("UPDATE companies SET notes = COALESCE(notes || char(10), '') || :n WHERE id = :id", { n: `HubSpot suppression reason: ${p.ll_suppression_reason}`, id: res.company.id });
      reevaluate(res.company.id, 'import');
      if (res.created) stats.created++; else stats.merged++;
    }
    if (!next) break;
    after = next;
  }
  return stats;
}
