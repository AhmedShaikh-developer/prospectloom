// Phase 2/11/12: batch research execution with persistent progress markers and an auditable report.
import { q, nowIso, logActivity, currentDbPath } from '../db/index.js';
import { getNum } from '../lib/settings.js';
import { verifyCompany } from './verification.js';
import { evaluateCompany, getCompany } from './companies.js';
import { inventory } from './inventory.js';
import * as hubspot from '../integrations/hubspot.js';
import { createJob, progressJob, finishJob } from './jobs.js';

// One research run at a time per workspace.
const runs = new Map();
const getRun = () => runs.get(currentDbPath()) || null;

/**
 * Pick the next non-overlapping batch: unscreened first, then least-recently screened.
 * Companies screened within `research_rescreen_hours` are skipped unless edited since.
 */
export function nextBatch(size = getNum('research_batch_size'), excludeIds = []) {
  const hours = getNum('research_rescreen_hours');
  return q.all(`
    SELECT id FROM companies
    WHERE status IN ('RESEARCHING','HOLD_VERIFY')
      AND (next_screen_at IS NULL OR next_screen_at <= :now)
      AND (last_screened_at IS NULL OR julianday('now') - julianday(last_screened_at) >= :h / 24.0 OR updated_at > last_screened_at OR next_screen_at <= :now)
      ${excludeIds.length ? `AND id NOT IN (${excludeIds.map(Number).join(',')})` : ''}
    ORDER BY (last_screened_at IS NULL) DESC, fit_score DESC NULLS LAST, last_screened_at ASC, id ASC
    LIMIT :n`, { h: hours, n: size, now: new Date().toISOString() }).map((r) => r.id);
}

export function isRunning() { return !!getRun(); }

export async function runResearch({ ids, size, concurrency = 4 } = {}) {
  if (getRun()) throw new Error('A research run is already in progress');
  const started = nowIso();
  const runRes = q.run("INSERT INTO runs (kind, started_at, status) VALUES ('research', :now, 'running')", { now: started });
  const runId = Number(runRes.lastInsertRowid);
  const batch = ids?.length ? ids.map(Number) : nextBatch(size);
  const before = Object.fromEntries(batch.map((id) => { const c = getCompany(id); return [id, c ? { status: c.status, rc: !!c.research_completed_at } : null]; }));
  const results = [];
  const errors = [];
  const running = { runId, total: batch.length, done: 0 };
  const wsKey = currentDbPath();
  runs.set(wsKey, running);
  const jobId = createJob('research', `Researching ${batch.length} compan${batch.length === 1 ? 'y' : 'ies'}`, { runId });
  progressJob(jobId, 0, batch.length, 'Scanning websites, finding published emails…');
  try {
    const queue = [...batch];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { results.push(await verifyCompany(id)); } catch (e) { errors.push({ id, error: e.message }); }
        running.done++;
        progressJob(jobId, running.done, batch.length, `${running.done} of ${batch.length} checked`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length || 1) }, worker));
  } finally {
    runs.delete(wsKey);
  }

  // ---- Auditable report (Phase 11) ----
  const after = results.map((r) => ({ ...r, company: getCompany(r.id) }));
  const stats = {
    selected: batch.length,
    screened: results.length,
    errors: errors.length,
    fullyResearched: after.filter((r) => r.company?.research_completed_at).length,
    newlyResearchQualified: after.filter((r) => r.company?.research_completed_at && r.company.fit_score >= 6 && !before[r.id]?.rc).length,
    newlyReady: after.filter((r) => r.after === 'READY' && before[r.id]?.status !== 'READY').length,
    stillHold: after.filter((r) => ['HOLD_VERIFY', 'RESEARCHING'].includes(r.after)).length,
    manualApplication: after.filter((r) => r.after === 'MANUAL_APPLICATION').length,
    excluded: after.filter((r) => ['EXCLUDED', 'DO_NOT_CONTACT'].includes(r.after)).length,
    duplicatesFound: after.filter((r) => (r.evaluation?.conflicts || []).some((c) => ['previously_contacted', 'duplicate_email', 'existing_conversation'].includes(c.type))).length,
    suppressionConflicts: after.filter((r) => (r.evaluation?.conflicts || []).some((c) => ['opt_out', 'complaint', 'bounce', 'do_not_contact', 'competitor'].includes(c.type))).length,
    progressed: after.filter((r) => r.progressed).length,
    crmWritesAttempted: 0,
    crmWritesConfirmed: 0,
    crmWritesBlocked: 0,
    crmNote: hubspot.isConfigured() ? 'Research never writes to HubSpot; propose a sync batch on the HubSpot page.' : 'HubSpot not configured: CRM lookups skipped.',
  };
  const outstanding = after
    .filter((r) => r.after !== 'READY')
    .map((r) => ({ id: r.id, name: r.name, status: r.after, missing: (r.evaluation?.missing || []).slice(0, 6) }));
  const nextIds = nextBatch(getNum('research_batch_size'), batch).slice(0, 50);
  const inv = inventory();
  const shortfallNote = stats.selected < getNum('research_batch_size')
    ? `Only ${stats.selected} companies were eligible for screening (target ${getNum('research_batch_size')}). Import or discover more companies to keep throughput up.`
    : '';
  const lines = [
    `Research run #${runId} — ${started} → ${nowIso()}`,
    `Selected ${stats.selected} | Screened ${stats.screened} | Errors ${stats.errors}`,
    `Fully researched ${stats.fullyResearched} | Newly research-qualified ${stats.newlyResearchQualified} | Newly READY ${stats.newlyReady}`,
    `Still on hold ${stats.stillHold} | Manual application ${stats.manualApplication} | Excluded/DNC ${stats.excluded}`,
    `Duplicates found ${stats.duplicatesFound} | Suppression conflicts ${stats.suppressionConflicts}`,
    `CRM writes attempted ${stats.crmWritesAttempted} / confirmed ${stats.crmWritesConfirmed} / blocked ${stats.crmWritesBlocked} — ${stats.crmNote}`,
    `Inventory: ${inv.eligibleUnsent} eligible unsent READY (${inv.reserveDays ?? 0} days at ${inv.dailyVolume}/day)`,
    shortfallNote,
    `Next batch: ${nextIds.length ? nextIds.join(', ') : 'none eligible'}`,
  ].filter(Boolean);
  q.run("UPDATE runs SET finished_at = :now, status = :status, stats = :stats, report = :report WHERE id = :id", {
    now: nowIso(), status: errors.length ? 'partial' : 'ok',
    stats: JSON.stringify({ ...stats, outstanding: outstanding.slice(0, 100), errorsDetail: errors, nextBatch: nextIds }),
    report: lines.join('\n'), id: runId,
  });
  logActivity(null, 'research_run', { runId, ...stats }, 'automation');
  finishJob(jobId, { runId, stats }, `${stats.screened} checked · ${stats.newlyReady} newly ready to email`);
  return { runId, stats, outstanding, nextBatch: nextIds, report: lines.join('\n') };
}

export function progress() { return getRun(); }

/** Used by the UI to explain why something is not READY. */
export { evaluateCompany };
