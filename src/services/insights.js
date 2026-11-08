// Time series and summaries for the dashboard charts. Read-only.
import { q } from '../db/index.js';
import { warmupPlan, bounceGuard, sendPlan } from './outreach.js';
import { listSources } from './sources.js';
import { report, platformOf } from './performance.js';

const PLATFORM_KEY = { 'Map listings': 'osm', Apollo: 'apollo', HubSpot: 'hubspot', Clay: 'clay', 'Added by hand': 'manual', 'Other list': 'csv' };

const ORIGIN = `CASE
  WHEN lead_origin = 'openstreetmap' THEN 'osm'
  WHEN lead_origin LIKE 'csv%' THEN 'csv'
  WHEN lead_origin = 'apollo' THEN 'apollo'
  WHEN lead_origin = 'hubspot' THEN 'hubspot'
  WHEN lead_origin LIKE 'clay%' THEN 'clay'
  ELSE 'manual' END`;
export const ORIGIN_LABELS = { osm: 'Map listings (OpenStreetMap)', csv: 'Your CSV files', apollo: 'Apollo', hubspot: 'HubSpot', clay: 'Clay webhook', manual: 'Added by hand' };

function dayKeys(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function perDay(sql, keys, params = {}) {
  const map = Object.fromEntries(q.all(sql, { since: keys[0], ...params }).map((r) => [r.d, r.n]));
  return keys.map((k) => map[k] || 0);
}

/** Daily counts for the last `days` days (server-local dates). */
export function series(days = 14) {
  const n = Math.min(180, Math.max(7, Number(days) || 14));
  const keys = dayKeys(n);
  const leadsBy = {};
  for (const r of q.all(`SELECT date(created_at, 'localtime') AS d, ${ORIGIN} AS g, COUNT(*) AS n FROM companies
      WHERE date(created_at, 'localtime') >= :since GROUP BY d, g`, { since: keys[0] })) {
    (leadsBy[r.g] ||= Object.fromEntries(keys.map((k) => [k, 0])))[r.d] = r.n;
  }
  const leads = Object.fromEntries(Object.entries(leadsBy).map(([g, m]) => [g, keys.map((k) => m[k] || 0)]));
  const total = keys.map((_, i) => Object.values(leads).reduce((a, arr) => a + arr[i], 0));
  // Same-length window before this one, for the "vs previous period" delta.
  const prevSince = new Date(new Date(keys[0]).getTime() - n * 86400_000).toISOString().slice(0, 10);
  const prevTotal = q.get(`SELECT COUNT(*) AS n FROM companies WHERE date(created_at, 'localtime') >= :a AND date(created_at, 'localtime') < :b`, { a: prevSince, b: keys[0] }).n;
  return {
    days: keys,
    leads, leadsTotal: total, prevTotal,
    ready: perDay(`SELECT date(ready_at, 'localtime') AS d, COUNT(*) AS n FROM companies WHERE ready_at IS NOT NULL AND date(ready_at, 'localtime') >= :since GROUP BY d`, keys),
    sent: perDay(`SELECT date(sent_at, 'localtime') AS d, COUNT(*) AS n FROM messages WHERE status IN ('sent','bounced') AND date(sent_at, 'localtime') >= :since GROUP BY d`, keys),
    replies: perDay(`SELECT date(received_at, 'localtime') AS d, COUNT(*) AS n FROM replies WHERE classification IN ('positive','neutral','negative') AND date(received_at, 'localtime') >= :since GROUP BY d`, keys),
  };
}

/** Where companies stand, where they came from, the warm-up ramp and deliverability. */
export function overview() {
  const c = q.get(`SELECT
      COUNT(*) AS total,
      SUM(status = 'READY') AS ready,
      SUM(status IN ('SENT','FOLLOW_UP','REPLIED')) AS contacted,
      SUM(status = 'RESEARCHING' AND COALESCE(site_status, '') != 'blocked') AS researching,
      SUM(status = 'HOLD_VERIFY' AND (contact_email IS NULL OR contact_email = '') AND COALESCE(site_status, '') != 'blocked') AS no_email,
      SUM(status = 'HOLD_VERIFY' AND contact_email IS NOT NULL AND contact_email != '' AND COALESCE(site_status, '') != 'blocked') AS checks,
      SUM(site_status = 'blocked' AND status IN ('RESEARCHING','HOLD_VERIFY')) AS blocked,
      SUM(status IN ('EXCLUDED','DO_NOT_CONTACT','BOUNCED','MANUAL_APPLICATION')) AS out
    FROM companies`);
  // Lead sources by platform (imported files count under the platform you labelled them with)
  const perf = report();
  const days = series(14).days;
  const recent = q.all(`SELECT lead_origin, date(created_at, 'localtime') AS d, COUNT(*) AS n FROM companies WHERE date(created_at, 'localtime') >= :since GROUP BY lead_origin, d`, { since: days[0] });
  const sources = perf.byPlatform.map((g) => {
    const spark = days.map((d) => recent.filter((r) => r.d === d && platformOf(r.lead_origin) === g.key).reduce((t, r) => t + r.n, 0));
    return { g: PLATFORM_KEY[g.key] || 'manual', label: g.key, total: g.leads, ready: g.ready, contacted: g.emailed, replied: g.replied, replyRate: g.replyRate, spark };
  });
  const ramp = [];
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.now() + i * 86400_000);
    const w = warmupPlan(d);
    ramp.push({ date: d.toISOString().slice(0, 10), limit: w.limit });
  }
  const totals = q.get(`SELECT
      (SELECT COUNT(*) FROM messages WHERE status IN ('sent','bounced')) AS sent,
      (SELECT COUNT(*) FROM messages WHERE status = 'bounced') AS bounced,
      (SELECT COUNT(*) FROM replies WHERE classification IN ('positive','neutral','negative')) AS replies,
      (SELECT COUNT(*) FROM replies WHERE classification = 'positive') AS positive,
      (SELECT COUNT(*) FROM replies WHERE classification IN ('positive','neutral','negative') AND message_ref IS NOT NULL) AS repliesToSent`);
  const offline = q.get("SELECT COUNT(*) AS n FROM companies WHERE site_status = 'offline'").n;
  return {
    composition: { ...c, offline },
    sources, sourceStates: listSources(),
    ramp, warmup: warmupPlan(), plan: sendPlan(), bounce: bounceGuard(), totals,
    // Only replies to emails this app sent count toward the rate.
    replyRate: totals.sent ? Math.round((totals.repliesToSent / totals.sent) * 1000) / 10 : 0,
  };
}
