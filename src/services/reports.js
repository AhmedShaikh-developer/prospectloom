// Phase 11: daily summary and run history.
import { q, nowIso, today } from '../db/index.js';
import { inventory, funnel, blockers, integrationStatus } from './inventory.js';

export function dailySummary(date = today()) {
  const inv = inventory();
  const f = funnel();
  const dayRuns = q.all("SELECT kind, stats FROM runs WHERE date(started_at) = :d AND kind = 'research'", { d: date });
  const newReady = q.get('SELECT COUNT(*) AS n FROM companies WHERE date(ready_at) = :d', { d: date }).n;
  const sentToday = q.get("SELECT COUNT(*) AS n FROM messages WHERE status IN ('sent','bounced') AND date(sent_at) = :d", { d: date }).n;
  const screenedToday = dayRuns.reduce((s, r) => s + (JSON.parse(r.stats || '{}').screened || 0), 0);
  const hubspotOps = Object.fromEntries(q.all('SELECT status, COUNT(*) AS n FROM hubspot_ops GROUP BY status').map((r) => [r.status, r.n]));
  const summary = {
    date,
    cumulativeUniqueCompanies: inv.total,
    cumulativeResearchQualified: inv.researchQualified,
    qualifiedTarget: inv.qualifiedTarget,
    verifiedUnsentReserve: inv.eligibleUnsent,
    reserveUsedTotal: inv.reserveUsed,
    reserveUsedToday: sentToday,
    reserveRemaining: inv.eligibleUnsent,
    demand14: inv.reserve14, demand30: inv.reserve30, forecast60: inv.forecast60,
    newReadyToday: newReady,
    researchRunsToday: dayRuns.length,
    companiesScreenedToday: screenedToday,
    hubspot: hubspotOps,
    funnel: f,
    integrations: integrationStatus(),
    blockers: blockers(),
  };
  const text = [
    `Daily summary ${date}`,
    `Unique companies: ${summary.cumulativeUniqueCompanies} | Research-qualified: ${summary.cumulativeResearchQualified} / ${summary.qualifiedTarget}`,
    `Verified unsent reserve: ${summary.verifiedUnsentReserve} | Used today: ${sentToday} | Used total: ${summary.reserveUsedTotal}`,
    `14-day demand ${inv.reserve14.demand} → shortfall ${inv.reserve14.shortfall} | 30-day demand ${inv.reserve30.demand} → shortfall ${inv.reserve30.shortfall} | 60-day forecast ${inv.forecast60.demand} → shortfall ${inv.forecast60.shortfall}`,
    `New READY today: ${newReady} | Research runs: ${dayRuns.length} (${screenedToday} screened)`,
    `HubSpot ops: ${Object.entries(hubspotOps).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `Funnel: sent ${f.sent}, bounced ${f.bounced}, replies ${f.replies} (positive ${f.positive}), meetings ${f.meetings}, won ${f.won}, revenue ${f.revenue}`,
    `Blockers: ${summary.blockers.map((b) => `[${b.severity}] ${b.area}: ${b.message}`).join(' | ') || 'none'}`,
  ].join('\n');
  return { ...summary, text };
}

export function saveDailySummary() {
  const s = dailySummary();
  q.run("INSERT INTO runs (kind, started_at, finished_at, status, stats, report) VALUES ('daily_summary', :now, :now, 'ok', :stats, :report)", {
    now: nowIso(), stats: JSON.stringify(s), report: s.text,
  });
  return s;
}

export function listRuns({ kind, limit = 100 } = {}) {
  const rows = kind
    ? q.all('SELECT * FROM runs WHERE kind = :kind ORDER BY id DESC LIMIT :limit', { kind, limit })
    : q.all('SELECT * FROM runs ORDER BY id DESC LIMIT :limit', { limit });
  return rows.map((r) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null }));
}
