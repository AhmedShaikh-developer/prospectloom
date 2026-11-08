// Phase 8: send-ready inventory and reserve math. Phase 12: blockers & stall detection.
import { q } from '../db/index.js';
import { getNum, getBool, getSetting } from '../lib/settings.js';
import { complianceStatus } from './companies.js';
import * as hubspot from '../integrations/hubspot.js';
import * as mailer from '../integrations/mailer.js';
import * as imap from '../integrations/imap.js';
import * as apollo from '../integrations/apollo.js';
import * as ai from '../integrations/ai.js';
import { listSources } from './sources.js';
import { quotaStatus, bounceGuard, sendPlan, warmupPlan } from './outreach.js';

export const MILESTONES = [30, 100, 140, 300, 600];

export function inventory() {
  const byStatus = Object.fromEntries(q.all('SELECT status, COUNT(*) AS n FROM companies GROUP BY status').map((r) => [r.status, r.n]));
  const total = q.get('SELECT COUNT(*) AS n FROM companies').n;
  // Research-qualified = all Phase 3 facts verified and fit >= 6 (regardless of contact clearance).
  const researchQualified = q.get("SELECT COUNT(*) AS n FROM companies WHERE research_completed_at IS NOT NULL AND fit_score >= 6 AND status != 'EXCLUDED'").n;
  const ready = byStatus.READY || 0;
  // Eligible unsent = READY with no intro sent and no pending send already consuming it.
  const eligibleUnsent = q.get(`SELECT COUNT(*) AS n FROM companies c WHERE c.status = 'READY'
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.company_id = c.id AND m.kind = 'intro' AND m.status IN ('sent','bounced'))`).n;
  const contacted = (byStatus.SENT || 0) + (byStatus.FOLLOW_UP || 0) + (byStatus.REPLIED || 0) + (byStatus.BOUNCED || 0);
  const hold = (byStatus.HOLD_VERIFY || 0) + (byStatus.RESEARCHING || 0) + (byStatus.MANUAL_APPLICATION || 0);
  const excluded = (byStatus.EXCLUDED || 0) + (byStatus.DO_NOT_CONTACT || 0);
  const hubspotReady = q.get("SELECT COUNT(*) AS n FROM companies WHERE hubspot_stage = :s", { s: JSON.parse(getSetting('hubspot_stage_map') || '{}').READY || 'READY' }).n;

  const daily = quotaStatus().limit;
  const reserve = (days) => {
    const demand = daily * days;
    return { days, demand, shortfall: Math.max(0, demand - eligibleUnsent), covered: eligibleUnsent >= demand };
  };
  const nextMilestone = MILESTONES.find((m) => eligibleUnsent < m) ?? null;
  const reserveUsed = q.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'intro' AND status IN ('sent','bounced')").n;
  return {
    total, researchQualified, ready, eligibleUnsent, hubspotReady, contacted, hold, excluded, byStatus,
    dailyVolume: daily,
    reserveDays: daily ? +(eligibleUnsent / daily).toFixed(1) : null,
    reserve14: reserve(14), reserve30: reserve(30), forecast60: reserve(60),
    reserveUsed,
    milestones: MILESTONES.map((m) => ({ target: m, reached: eligibleUnsent >= m })),
    nextMilestone,
    qualifiedTarget: getNum('qualified_target'),
  };
}

export function funnel() {
  const one = (sql) => q.get(sql).n;
  return {
    sent: one("SELECT COUNT(*) AS n FROM messages WHERE status IN ('sent','bounced')"),
    introsSent: one("SELECT COUNT(*) AS n FROM messages WHERE kind='intro' AND status IN ('sent','bounced')"),
    followupsSent: one("SELECT COUNT(*) AS n FROM messages WHERE kind='follow_up' AND status IN ('sent','bounced')"),
    bounced: one("SELECT COUNT(*) AS n FROM messages WHERE status = 'bounced'"),
    replies: one("SELECT COUNT(*) AS n FROM replies WHERE classification IN ('positive','negative','neutral','opt_out')"),
    positive: one("SELECT COUNT(*) AS n FROM replies WHERE classification = 'positive'"),
    negative: one("SELECT COUNT(*) AS n FROM replies WHERE classification = 'negative'"),
    optOuts: one("SELECT COUNT(*) AS n FROM replies WHERE classification = 'opt_out'"),
    meetings: one("SELECT COUNT(*) AS n FROM opportunities WHERE stage NOT IN ('qualified_conversation','lost')"),
    paidDiscovery: one("SELECT COUNT(*) AS n FROM opportunities WHERE stage IN ('paid_discovery','proposal','development','retainer','won')"),
    proposals: one("SELECT COUNT(*) AS n FROM opportunities WHERE stage IN ('proposal','development','retainer','won')"),
    won: one("SELECT COUNT(*) AS n FROM opportunities WHERE stage IN ('development','retainer','won')"),
    lost: one("SELECT COUNT(*) AS n FROM opportunities WHERE stage = 'lost'"),
    revenue: q.get("SELECT COALESCE(SUM(value),0) AS n FROM opportunities WHERE stage IN ('development','retainer','won')").n,
  };
}

export function integrationStatus() {
  return {
    hubspot: { configured: hubspot.isConfigured() },
    smtp: { configured: mailer.isConfigured(), mode: getSetting('mail_transport'), user: mailer.mailboxUser() || null, error: mailer.mailPause().error },
    imap: { configured: imap.isConfigured(), lastSync: getSetting('imap_last_sync') || null },
    apollo: { configured: apollo.isConfigured(), apiSearchEnabled: getBool('apollo_api_search_enabled') },
    clay: { configured: !!getSetting('clay_webhook_secret') },
    ai: { configured: ai.isConfigured(), enabled: ai.isEnabled(), model: getSetting('groq_model') },
  };
}

/** Phase 12: what is blocking inventory growth right now. */
export function blockers() {
  const out = [];
  const comp = complianceStatus();
  if (!comp.ok) out.push({ severity: 'critical', area: 'Compliance', message: `Nothing can become READY until these are set in Settings: ${comp.missing.join(', ')}`, link: '#/settings' });
  const ints = integrationStatus();
  if (!ints.smtp.configured) out.push({ severity: 'critical', area: 'Hostinger mailbox', message: 'Mailbox password missing — enter it in Settings → Integrations so emails can be sent', link: '#/settings?tab=integrations' });
  else if (!ints.imap.configured && getSetting('mail_transport') !== 'capture') out.push({ severity: 'high', area: 'Hostinger mailbox', message: 'Mailbox reading is off — Sent-folder history, replies and bounces are not being checked', link: '#/settings?tab=integrations' });
  const mp = mailer.mailPause();
  if (mp.error) out.push({ severity: 'critical', area: 'Hostinger mailbox', message: `Last send failed: ${mp.error}${mp.paused ? ' Sending retries automatically in a few minutes.' : ''}`, link: '#/settings?tab=integrations' });
  if (!ints.ai.configured) out.push({ severity: 'low', area: 'AI writing', message: 'No Groq key — emails use your templates instead of being written for each lead', link: '#/settings' });
  // Research only flags what a human can act on. Expired websites are excluded automatically; companies
  // with no published email are re-checked every 14 days by themselves.
  const botBlocked = q.get("SELECT COUNT(*) AS n FROM companies WHERE status IN ('RESEARCHING','HOLD_VERIFY') AND site_status = 'blocked'").n;
  if (botBlocked) out.push({ severity: 'low', area: 'Research', message: `${botBlocked} websites block automated visits (bot protection) — research them by hand if they look valuable, otherwise ignore`, link: '#/companies?site=blocked' });
  const stalled = q.get(`SELECT COUNT(*) AS n FROM companies WHERE status IN ('RESEARCHING','HOLD_VERIFY') AND screen_count >= 3 AND site_status IS NULL
    AND (last_progress_at IS NULL OR last_progress_at < last_screened_at)`).n;
  if (stalled) out.push({ severity: 'low', area: 'Research', message: `${stalled} companies screened 3+ times without progress (usually no email published on their website) — re-checked every 14 days automatically; add details by hand if you know them`, link: '#/companies?status=RESEARCHING,HOLD_VERIFY&stalled=1' });
  const inv = inventory();
  if (inv.eligibleUnsent < inv.dailyVolume * 14) out.push({ severity: 'high', area: 'Inventory', message: `Reserve covers ${inv.reserveDays ?? 0} days — below the 14-day minimum (${inv.reserve14.shortfall} short)`, link: '#/companies?status=HOLD_VERIFY' });
  if (getBool('autopilot_review')) {
    const waiting = q.get("SELECT COUNT(*) AS n FROM messages WHERE status = 'draft'").n;
    if (waiting) out.push({ severity: 'high', area: 'Outreach', message: `${waiting} email(s) written and waiting for your approval — nothing goes out until you approve`, link: '#/outreach' });
  }
  for (const s of listSources().filter((x) => x.configured && x.enabled)) {
    if (s.status === 'auth') out.push({ severity: 'high', area: s.label, message: s.message || 'API key rejected', link: '#/integrations' });
    else if (['waiting_credits', 'plan', 'rate_limited'].includes(s.status)) out.push({ severity: 'low', area: s.label, message: s.message, link: '#/integrations' });
  }
  const pendingOps = q.get("SELECT COUNT(*) AS n FROM hubspot_ops WHERE status IN ('proposed','approved')").n;
  if (pendingOps) out.push({ severity: 'low', area: 'HubSpot', message: `${pendingOps} CRM write(s) awaiting approval — not synchronized yet`, link: '#/hubspot' });
  const bg = bounceGuard();
  if (bg.paused) out.push({ severity: 'critical', area: 'Deliverability', message: `Automatic sending paused: ${bg.rate}% of the last 7 days' emails bounced (${bg.bounced}/${bg.sent}). Remove bad emails or turn off provider emails, then it resumes as the rate drops.`, link: '#/outreach' });
  const unhandled = q.get("SELECT COUNT(*) AS n FROM replies WHERE handled = 0 AND classification IN ('positive','neutral','negative')").n;
  if (unhandled) out.push({ severity: 'high', area: 'Replies', message: `${unhandled} repl${unhandled === 1 ? 'y' : 'ies'} waiting for you`, link: '#/replies' });
  const blocked = q.get("SELECT COUNT(*) AS n FROM messages WHERE status = 'blocked'").n;
  if (blocked) out.push({ severity: 'low', area: 'Outreach', message: `${blocked} message(s) blocked by pre-send checks`, link: '#/outreach' });
  return out;
}

/** Most common missing requirements across HOLD/RESEARCHING (to focus effort). */
export function topMissing(evaluateFn, limit = 400) {
  const rows = q.all("SELECT * FROM companies WHERE status IN ('RESEARCHING','HOLD_VERIFY') ORDER BY fit_score DESC NULLS LAST LIMIT :limit", { limit });
  const counts = {};
  for (const c of rows) for (const m of evaluateFn(c).missing) { const k = m.replace(/\s*\(.*\)$/, ''); counts[k] = (counts[k] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([item, count]) => ({ item, count }));
}

export function todayStatus() {
  return { ...quotaStatus(), plan: sendPlan(), warmup: warmupPlan(), autoSend: getBool('auto_send_enabled') || getBool('autopilot_enabled'), autopilot: getBool('autopilot_enabled'), approved: q.get("SELECT COUNT(*) AS n FROM messages WHERE status = 'approved'").n, drafts: q.get("SELECT COUNT(*) AS n FROM messages WHERE status = 'draft'").n };
}
