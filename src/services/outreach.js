// Phase 9: outreach handoff. Drafts -> human approval -> scheduled send with
// pre-send eligibility re-check, daily quota and spacing. Research never sends.
import crypto from 'node:crypto';
import { q, nowIso, today, logActivity } from '../db/index.js';
import { getSetting, getNum, getBool } from '../lib/settings.js';
import { getCompany, reevaluate, complianceStatus } from './companies.js';
import { runDedup } from './suppression.js';
import { sendMail, isMailboxError, recordMailError, clearMailError, mailPause, friendlyMailError } from '../integrations/mailer.js';
import { appendToSent } from '../integrations/imap.js';
import { emailDomain } from '../lib/normalize.js';
import { config } from '../config.js';
import { STATUS } from '../lib/constants.js';
import { angleFor } from '../lib/angles.js';
import { suggestions } from '../lib/personalization.js';
import * as ai from '../integrations/ai.js';
import { offerKey } from '../lib/offers.js';

export function render(template, vars) {
  return String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k] ?? '').toString());
}

function firstName(c) {
  const n = String(c.dm_name || '').trim().split(/\s+/)[0];
  // Only address the person by name when the recipient IS the decision-maker.
  return c.email_contact_type === 'decision_maker' && n ? n : 'there';
}

export function footer(token) {
  const lines = [
    '—',
    [getSetting('sender_name'), getSetting('sender_title')].filter(Boolean).join(', '),
    [getSetting('sender_company'), getSetting('sender_website')].filter(Boolean).join(' · '),
    getSetting('sender_postal_address'),
    getSetting('unsubscribe_text'),
  ];
  if (config.publicBaseUrl && token) lines.push(`Unsubscribe: ${config.publicBaseUrl.replace(/\/$/, '')}/u/${token}`);
  return lines.filter(Boolean).join('\n');
}

export function buildIntro(c) {
  const offer = offerKey(c.offer);
  const vars = {
    first_name: firstName(c),
    company: c.name,
    personalization: c.personalization || '',
    offer_pitch: getSetting(`offer_${offer}_pitch`),
    offer_name: getSetting(`offer_${offer}_name`),
    sender_name: getSetting('sender_name'),
    sender_company: getSetting('sender_company'),
    dm_title: c.dm_title || '',
    angle: angleFor(c),
  };
  return {
    subject: render(getSetting(`template_${offer}_subject`), vars).trim(),
    body: render(getSetting(`template_${offer}_body`), vars).trim(),
  };
}

/** Full pre-send eligibility re-check (Phase 9 step 2). */
export function checkEligibility(message) {
  const reasons = [];
  const c0 = getCompany(message.company_id);
  if (!c0) return { ok: false, reasons: ['Company deleted'] };
  runDedup(c0);
  const c = reevaluate(c0.id, 'pre-send');
  const ev = c.evaluation;
  if (message.kind === 'intro') {
    if (c.status !== STATUS.READY) reasons.push(`Company status is ${c.status}: ${c.status_reason}`);
    const prior = q.get("SELECT id FROM messages WHERE company_id = :cid AND kind = 'intro' AND status IN ('sent','bounced') AND id != :id", { cid: c.id, id: message.id });
    if (prior) reasons.push('An intro was already sent to this company');
  } else {
    if (![STATUS.SENT, STATUS.FOLLOW_UP].includes(c.status)) reasons.push(`Follow-up not allowed in status ${c.status}`);
    const reply = q.get('SELECT id FROM replies WHERE company_id = :cid', { cid: c.id });
    if (reply) reasons.push('Company already replied — handle the conversation manually');
    const hard = (ev.conflicts || []).filter((x) => ['opt_out', 'complaint', 'bounce', 'do_not_contact'].includes(x.type));
    if (hard.length) reasons.push(hard.map((x) => x.detail).join('; '));
  }
  if (message.to_email !== c.contact_email && message.kind === 'intro') reasons.push('Recipient differs from the verified contact email');
  const supp = q.get("SELECT reason FROM suppressions WHERE (kind='email' AND value=:e) OR (kind='domain' AND value=:d)", { e: message.to_email, d: emailDomain(message.to_email) });
  if (supp) reasons.push(`Recipient suppressed (${supp.reason})`);
  const comp = complianceStatus();
  if (!comp.ok) reasons.push(`Compliance settings missing: ${comp.missing.join(', ')}`);
  return { ok: reasons.length === 0, reasons, company: c };
}

/** Create intro drafts for the top-N READY companies (does not send). */
export function generateDrafts({ limit, companyIds } = {}) {
  const n = limit ?? quotaStatus().limit;
  const only = (companyIds || []).map(Number).filter(Boolean);
  const rows = q.all(`
    SELECT c.* FROM companies c
    WHERE c.status = 'READY'
      ${only.length ? `AND c.id IN (${only.join(',')})` : ''}
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.company_id = c.id AND m.kind = 'intro' AND m.status IN ('draft','approved','blocked','sent','bounced'))
    ORDER BY c.fit_score DESC, c.ready_at ASC LIMIT :n`, { n: only.length ? only.length : n });
  const created = [];
  for (const c of rows) {
    const { subject, body } = buildIntro(c);
    const token = crypto.randomBytes(12).toString('hex');
    const res = q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, unsubscribe_token) VALUES (:cid, 'intro', :to, :subject, :body, :token)`, {
      cid: c.id, to: c.contact_email, subject, body, token,
    });
    created.push(Number(res.lastInsertRowid));
    logActivity(c.id, 'draft_created', { messageId: Number(res.lastInsertRowid) }, 'system');
  }
  return { created: created.length, ids: created };
}

/** Follow-up drafts for sent intros without reply after N days (same thread). */
export function generateFollowups() {
  if (!getBool('followup_enabled')) return { created: 0, ids: [] };
  const days = getNum('followup_after_days');
  const max = getNum('max_followups');
  const rows = q.all(`
    SELECT m.*, c.status AS cstatus FROM messages m JOIN companies c ON c.id = m.company_id
    WHERE m.kind = 'intro' AND m.status = 'sent' AND c.status IN ('SENT','FOLLOW_UP')
      AND julianday('now') - julianday(m.sent_at) >= :days
      AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.company_id = c.id)
      AND (SELECT COUNT(*) FROM messages f WHERE f.company_id = c.id AND f.kind = 'follow_up' AND f.status NOT IN ('cancelled','blocked','failed')) < :max
      AND NOT EXISTS (SELECT 1 FROM messages f WHERE f.company_id = c.id AND f.kind = 'follow_up' AND f.status IN ('draft','approved'))
      AND NOT EXISTS (SELECT 1 FROM messages f WHERE f.company_id = c.id AND f.kind = 'follow_up' AND f.status = 'sent' AND julianday('now') - julianday(f.sent_at) < :days)`,
  { days, max });
  const ids = [];
  for (const m of rows) {
    const c = getCompany(m.company_id);
    const body = render(getSetting('template_followup_body'), { first_name: firstName(c), company: c.name, sender_name: getSetting('sender_name') });
    const res = q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, in_reply_to, unsubscribe_token) VALUES (:cid, 'follow_up', :to, :subject, :body, :irt, :token)`, {
      cid: c.id, to: m.to_email, subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`, body, irt: m.message_id, token: m.unsubscribe_token,
    });
    ids.push(Number(res.lastInsertRowid));
    if (c.status === STATUS.SENT) q.run("UPDATE companies SET status = 'FOLLOW_UP', status_reason = 'Follow-up drafted', updated_at = :now WHERE id = :id", { now: nowIso(), id: c.id });
  }
  return { created: ids.length, ids };
}

export function listMessages({ status, kind, limit = 300 } = {}) {
  const where = []; const p = { limit };
  if (status) { where.push(`m.status IN (${status.split(',').map((_, i) => ':s' + i).join(',')})`); status.split(',').forEach((s, i) => { p['s' + i] = s; }); }
  if (kind) { where.push('m.kind = :kind'); p.kind = kind; }
  return q.all(`SELECT m.*, c.name AS company_name, c.domain, c.fit_score, c.offer FROM messages m JOIN companies c ON c.id = m.company_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT :limit`, p);
}

export function updateDraft(id, { subject, body, to_email }) {
  const m = q.get('SELECT * FROM messages WHERE id = :id', { id });
  if (!m) throw new Error('Message not found');
  if (!['draft', 'approved', 'blocked'].includes(m.status)) throw new Error(`Cannot edit a ${m.status} message`);
  if (to_email && to_email !== m.to_email) throw new Error('Recipient cannot be changed here; update the verified contact on the company');
  q.run("UPDATE messages SET subject = COALESCE(:subject, subject), body = COALESCE(:body, body), status = 'draft', approved_at = NULL WHERE id = :id", { subject, body, id });
  logActivity(m.company_id, 'draft_edited', { messageId: id });
}

export function approveMessages(ids) {
  const out = { approved: [], blocked: [] };
  for (const id of ids) {
    const m = q.get('SELECT * FROM messages WHERE id = :id', { id });
    if (!m || m.status !== 'draft') continue;
    const el = checkEligibility(m);
    if (!el.ok) {
      q.run("UPDATE messages SET status = 'blocked', status_reason = :r WHERE id = :id", { r: el.reasons.join('; '), id });
      out.blocked.push({ id, reasons: el.reasons });
      continue;
    }
    q.run("UPDATE messages SET status = 'approved', approved_at = :now, status_reason = NULL WHERE id = :id", { now: nowIso(), id });
    logActivity(m.company_id, 'message_approved', { messageId: id });
    out.approved.push(id);
  }
  return out;
}

export function cancelMessages(ids) {
  let n = 0;
  for (const id of ids) n += Number(q.run("UPDATE messages SET status = 'cancelled' WHERE id = :id AND status IN ('draft','approved','blocked')", { id }).changes);
  return n;
}

/** "Today" is the recipients' day (send timezone), not the server's — a US window can cross midnight in Pakistan. */
export function sentToday(d = new Date()) {
  return q.get("SELECT COUNT(*) AS n FROM messages WHERE status IN ('sent','bounced') AND sent_at >= :start", { start: zonedDayStart(d).toISOString() }).n;
}

// ---------------------------------------------------------------- warm-up: the daily limit grows by itself
/**
 * Days 1..hold: the starting limit (daily_send_limit). After that +step every N days, up to the maximum.
 * Day 1 is the first day this app sent an email (or warmup_start_date). If more than 3% of the last
 * 7 days' emails bounced (20+ sent), the limit falls back to the starting level until that improves.
 */
export function warmupPlan(d = new Date()) {
  const base = Math.max(1, getNum('daily_send_limit'));
  if (!getBool('warmup_enabled')) return { enabled: false, limit: base, base };
  const first = getSetting('warmup_start_date') || q.get("SELECT MIN(sent_at) AS t FROM messages WHERE status IN ('sent','bounced')").t;
  const firstAt = first ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(first) ? `${first}T12:00:00Z` : first) : null; // a plain date = that calendar day
  const day = firstAt ? Math.max(1, Math.round((zonedDayStart(d) - zonedDayStart(firstAt)) / 86400_000) + 1) : 1;
  const hold = Math.max(1, getNum('warmup_hold_days') || 14);
  const step = Math.max(0, getNum('warmup_step'));
  const every = Math.max(1, getNum('warmup_every_days') || 7);
  const max = Math.max(base, getNum('warmup_max') || base);
  const levelOn = (n) => (n <= hold ? base : Math.min(max, base + step * (1 + Math.floor((n - hold - 1) / every))));
  let limit = levelOn(day);
  let nextDay = null;
  if (limit < max && step > 0) { nextDay = day + 1; while (levelOn(nextDay) <= limit) nextDay++; }
  const g = bounceGuard();
  const braked = g.sent >= 20 && g.rate > 3 && limit > base;
  if (braked) limit = base;
  const nextDate = nextDay ? new Date(d.getTime() + (nextDay - day) * 86400_000).toISOString().slice(0, 10) : null;
  return { enabled: true, base, limit, day, hold, step, every, max, braked, started: !!first, nextLimit: nextDay ? levelOn(nextDay) : null, nextDate };
}

export function quotaStatus(d = new Date()) {
  const limit = warmupPlan(d).limit;
  const sent = sentToday(d);
  return { limit, sent, remaining: Math.max(0, limit - sent) };
}

// ---------------------------------------------------------------- rounds: spread the day's emails out
// Deterministic per day, so a restart never changes today's plan.
function seeded(key, i) {
  let h = 2166136261;
  for (const ch of `${key}#${i}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

/**
 * Today's sending plan: the limit is split into N rounds spread across the send window
 * (e.g. 10 → 5 at 09:00 and 5 at ~12:40), with a random gap between emails inside a round.
 */
export function sendPlan(d = new Date()) {
  const { limit } = quotaStatus(d);
  const clock = zonedClock(d);
  const start = getNum('send_window_start') * 60;
  const end = Math.max(start + 60, getNum('send_window_end') * 60);
  const n = Math.min(6, Math.max(1, getNum('send_rounds') || 1, 1));
  const rounds = Math.min(n, limit);
  const slot = (end - start) / rounds;
  const list = [];
  for (let i = 0; i < rounds; i++) {
    const jitter = i === 0 ? 0 : Math.round(seeded(clock.key, i) * Math.min(40, slot * 0.3));
    const at = Math.round(start + i * slot + jitter);
    const upto = Math.floor((limit * (i + 1)) / rounds);
    list.push({ round: i + 1, at: hhmm(at), atMin: at, count: upto - (list.length ? list[list.length - 1].upto : 0), upto });
  }
  const now = clock.hour * 60 + clock.minute;
  let current = -1;
  list.forEach((r, i) => { if (now >= r.atMin) current = i; });
  const sent = sentToday(d);
  const next = list.find((r) => r.atMin > now) || null;
  return { limit, sent, rounds: list, current: current + 1, allowedNow: current >= 0 ? list[current].upto : 0, nextRound: next ? next.at : null, timezone: getSetting('send_timezone') };
}

/** Gap before the k-th email of the day: random between the min and max minutes (stable per day). */
export function gapMinutes(k, d = new Date()) {
  const lo = Math.max(0, getNum('min_minutes_between_sends'));
  const hi = Math.max(lo, getNum('max_minutes_between_sends'));
  return lo + Math.round(seeded(zonedClock(d).key, `gap${k}`) * (hi - lo));
}

function zonedParts(d = new Date(), tz = getSetting('send_timezone')) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return { y: +p.year, mo: +p.month, d: +p.day, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: +p.hour % 24, minute: +p.minute, second: +p.second };
  } catch { return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), day: d.getDay(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }; }
}

/** Day of week (0=Sun) and hour in the configured send timezone (your recipients' time). */
export function zonedNow(d = new Date(), tz = getSetting('send_timezone')) {
  const z = zonedParts(d, tz);
  return { day: z.day, hour: z.hour };
}

/** Clock in the send timezone, plus the date key (YYYY-MM-DD) of the recipients' day. */
export function zonedClock(d = new Date(), tz = getSetting('send_timezone')) {
  const z = zonedParts(d, tz);
  return { ...z, key: `${z.y}-${String(z.mo).padStart(2, '0')}-${String(z.d).padStart(2, '0')}` };
}

/** The UTC instant at which the current day started in the send timezone. */
export function zonedDayStart(d = new Date(), tz = getSetting('send_timezone')) {
  const z = zonedParts(d, tz);
  const offset = Date.UTC(z.y, z.mo - 1, z.d, z.hour, z.minute, z.second) - Math.floor(d.getTime() / 1000) * 1000;
  return new Date(Date.UTC(z.y, z.mo - 1, z.d) - offset);
}

export function inSendWindow(d = new Date()) {
  const days = getSetting('send_days').split(',').map(Number);
  const { day, hour } = zonedNow(d);
  return days.includes(day) && hour >= getNum('send_window_start') && hour < getNum('send_window_end');
}

/** Send one approved message (re-checking everything first). */
export async function sendOne(id, { actor = 'user' } = {}) {
  const m = q.get('SELECT * FROM messages WHERE id = :id', { id });
  if (!m) throw new Error('Message not found');
  if (m.status !== 'approved') throw new Error(`Only approved messages can be sent (status: ${m.status})`);
  const quota = quotaStatus();
  if (quota.remaining <= 0) return { ok: false, reason: `Daily limit reached (${quota.limit})` };
  const el = checkEligibility(m);
  if (!el.ok) {
    q.run("UPDATE messages SET status = 'blocked', status_reason = :r WHERE id = :id", { r: el.reasons.join('; '), id });
    logActivity(m.company_id, 'send_blocked', el.reasons, actor);
    return { ok: false, reason: el.reasons.join('; ') };
  }
  const from = `"${getSetting('sender_name')}" <${getSetting('sender_email')}>`;
  const text = `${m.body}\n\n${footer(m.unsubscribe_token)}`;
  const domain = (getSetting('sender_email').split('@')[1]) || 'localhost';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  try {
    const info = await sendMail({
      from, to: m.to_email, subject: m.subject, text, messageId,
      inReplyTo: m.in_reply_to, references: m.in_reply_to,
      listUnsubscribe: `<mailto:${getSetting('sender_email')}?subject=unsubscribe>`,
    });
    if (info.rejected?.length) throw new Error(`Rejected by server: ${info.rejected.join(', ')}`);
    const now = nowIso();
    q.run("UPDATE messages SET status = 'sent', sent_at = :now, message_id = :mid WHERE id = :id", { now, mid: info.messageId, id });
    const newStatus = m.kind === 'intro' ? STATUS.SENT : STATUS.FOLLOW_UP;
    q.run('UPDATE companies SET status = :st, status_reason = :r, last_sent_date = :d, updated_at = :now WHERE id = :cid', {
      st: newStatus, r: m.kind === 'intro' ? 'Intro sent' : 'Follow-up sent', d: today(), now, cid: m.company_id,
    });
    logActivity(m.company_id, 'message_sent', { messageId: id, to: m.to_email, kind: m.kind }, actor);
    clearMailError();
    appendToSent(info.raw).catch(() => {});
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    if (isMailboxError(e)) {
      // Mailbox/connection problem — keep the email approved and pause sending for a while.
      recordMailError(e);
      const reason = friendlyMailError(e, 'SMTP');
      logActivity(m.company_id, 'send_deferred', reason, actor);
      return { ok: false, retry: true, reason: `Not sent yet — ${reason} The email stays approved and is retried automatically.` };
    }
    q.run("UPDATE messages SET status = 'failed', status_reason = :r WHERE id = :id", { r: e.message, id });
    logActivity(m.company_id, 'send_failed', e.message, actor);
    return { ok: false, reason: e.message };
  }
}

/** Bounce rate over the last 7 days. Automatic sending pauses above 5% (once 20+ were sent). */
export function bounceGuard() {
  const r = q.get(`SELECT COUNT(*) AS sent, COALESCE(SUM(status = 'bounced'), 0) AS bounced FROM messages
    WHERE kind = 'intro' AND status IN ('sent','bounced') AND sent_at >= datetime('now', '-7 days')`);
  const rate = r.sent ? r.bounced / r.sent : 0;
  return { ...r, rate: Math.round(rate * 1000) / 10, paused: getBool('bounce_guard_enabled') && r.sent >= 20 && rate > 0.05 };
}

/** Scheduler tick: send at most one approved message, honouring window, quota and spacing. */
export async function autoSendTick() {
  if (!getBool('auto_send_enabled') && !getBool('autopilot_enabled')) return { skipped: 'auto-send disabled' };
  if (bounceGuard().paused) return { skipped: 'bounce guard' };
  if (mailPause().paused) return { skipped: 'mailbox error' };
  if (!inSendWindow()) return { skipped: 'outside send window' };
  if (quotaStatus().remaining <= 0) return { skipped: 'daily limit reached' };
  const plan = sendPlan();
  if (plan.current === 0) return { skipped: 'waiting for the first round', next: plan.rounds[0]?.at };
  if (plan.sent >= plan.allowedNow) return { skipped: 'round complete', next: plan.nextRound };
  const last = q.get("SELECT MAX(sent_at) AS t FROM messages WHERE status IN ('sent','bounced')").t;
  if (last && Date.now() - new Date(last).getTime() < gapMinutes(plan.sent) * 60000) return { skipped: 'spacing' };
  const next = q.get("SELECT id FROM messages WHERE status = 'approved' ORDER BY kind = 'follow_up' DESC, approved_at ASC LIMIT 1");
  if (!next) return { skipped: 'nothing approved' };
  return sendOne(next.id, { actor: 'scheduler' });
}

export function unsubscribeByToken(token) {
  const m = q.get('SELECT * FROM messages WHERE unsubscribe_token = :token LIMIT 1', { token });
  if (!m) return false;
  q.run("INSERT INTO suppressions (kind, value, reason, source) VALUES ('email', :v, 'opt_out', 'unsubscribe_link') ON CONFLICT DO NOTHING", { v: m.to_email });
  q.run("UPDATE companies SET status = 'DO_NOT_CONTACT', status_reason = 'Unsubscribed via link', status_locked = 1, updated_at = :now WHERE id = :id", { now: nowIso(), id: m.company_id });
  q.run("UPDATE messages SET status = 'cancelled', status_reason = 'Recipient unsubscribed' WHERE company_id = :id AND status IN ('draft','approved')", { id: m.company_id });
  logActivity(m.company_id, 'unsubscribed', { email: m.to_email }, 'recipient');
  return true;
}

// ---------------------------------------------------------------- Email studio (per-lead writing)

/** Verified facts the writer (human or local AI) is allowed to use. */
export function verifiedFacts(c) {
  const f = [];
  f.push(`Company: ${c.name} (${c.domain})`);
  if (c.industry) f.push(`Industry: ${c.industry}`);
  if (c.description && c.profile_url) f.push(`Their own description: ${c.description}`);
  if (c.services) f.push(`Services: ${c.services}`);
  if (c.us_presence && c.us_presence_url) f.push(`Location: ${c.us_presence}`);
  if (c.portfolio_note && c.portfolio_url) f.push(`Portfolio/workflow: ${c.portfolio_note}`);
  if (c.personalization && c.personalization_url) f.push(`Verified personalization: ${c.personalization}`);
  try {
    const facts = JSON.parse(c.scan_facts || '{}');
    (facts.caseStudies || []).slice(0, 3).forEach((x) => f.push(`Case study on their site: ${x.text}`));
    (facts.hiring || []).slice(0, 2).forEach((x) => f.push(`They are hiring: ${x.text}`));
    (facts.tech || []).filter((t) => t.name !== 'Google Analytics').forEach((t) => f.push(`Their website uses ${t.name}`));
  } catch { /* none */ }
  return f;
}

export function studio(companyId) {
  const c = getCompany(companyId);
  if (!c) throw new Error('Company not found');
  const intro = buildIntro(c);
  const existing = q.get("SELECT id, status FROM messages WHERE company_id = :id AND kind = 'intro' AND status != 'cancelled' ORDER BY id DESC LIMIT 1", { id: companyId });
  return {
    suggestions: suggestions(c),
    angle: angleFor(c),
    facts: verifiedFacts(c),
    draft: intro,
    aiEnabled: ai.isEnabled(),
    mode: getSetting('pipeline_mode'),
    canDraft: c.status === STATUS.READY && !existing,
    existing: existing || null,
    footer: footer(null),
  };
}

export async function aiDraft(companyId) {
  if (!ai.isEnabled()) throw new Error('AI writing is off. Add your free Groq API key in Settings → AI writing.');
  const c = getCompany(companyId);
  if (!c) throw new Error('Company not found');
  if (!c.personalization || !c.personalization_url) throw new Error('Set a verified personalization line first — the AI may only use verified facts.');
  const offer = offerKey(c.offer);
  return ai.draftEmail({
    company: c, facts: verifiedFacts(c), angle: angleFor(c), b2c: c.offer === 'C',
    offerPitch: getSetting(`offer_${offer}_pitch`), senderName: getSetting('sender_name'), senderCompany: getSetting('sender_company'),
  });
}

/** Automatic quality gate for AI-written emails sent without a human edit. Returns a list of problems. */
export function validateDraft({ subject, body }, c = {}) {
  const problems = [];
  const s = String(subject || '').trim(); const b = String(body || '').trim();
  const words = b.split(/\s+/).filter(Boolean).length;
  if (!s || s.length > 90) problems.push('subject missing or too long');
  if (words < 35 || words > 180) problems.push(`body length ${words} words`);
  if (/\{\{|\}\}|\[[^\]]{1,40}\]|<[^>]+>/.test(s + b)) problems.push('placeholder or markup left in text');
  if (/https?:\/\/|www\./i.test(b)) problems.push('contains a link');
  if (/unsubscribe|opt[- ]out/i.test(b)) problems.push('contains its own opt-out line (added automatically)');
  if (/!/.test(b)) problems.push('contains an exclamation mark');
  if (/\b(as an ai|language model|i cannot)\b/i.test(b)) problems.push('model meta-text');
  if (/\$\s?\d|\d+\s?%/.test(b) && !/\$\s?\d|\d+\s?%/.test(`${c.description || ''} ${c.personalization || ''}`)) problems.push('mentions a number/percentage not in the facts');
  const sender = String(getSetting('sender_name') || '').split(' ')[0];
  if (sender && !b.includes(sender)) problems.push('missing sign-off');
  return problems;
}

/**
 * Autopilot: for today's free quota, create intros for READY companies, rewrite them with AI
 * (when a Groq key is set and the result passes the quality gate), and approve them. Every
 * message is still re-checked right before sending, and sending stays paced and within the limit.
 */
export async function runAutopilot({ actor = 'autopilot', onProgress } = {}) {
  const queued = q.get("SELECT COUNT(*) AS n FROM messages WHERE status = 'approved' AND kind = 'intro'").n;
  const room = Math.max(0, quotaStatus().remaining - queued);
  const out = { drafted: 0, aiWritten: 0, aiRejected: 0, approved: 0, blocked: 0, followups: 0, notes: [] };
  // Approve any drafts already waiting (e.g. written in Email studio), then fill the rest of today's room.
  const waiting = q.all("SELECT id FROM messages WHERE status = 'draft' AND kind = 'intro' ORDER BY id LIMIT :n", { n: room }).map((r) => r.id);
  const fresh = room - waiting.length > 0 ? generateDrafts({ limit: room - waiting.length }).ids : [];
  out.drafted = fresh.length;
  if (fresh.length && ai.isEnabled()) {
    for (const [i, id] of fresh.entries()) {
      onProgress?.(i, fresh.length, `Writing email ${i + 1} of ${fresh.length} with AI`);
      const m = q.get('SELECT * FROM messages WHERE id = :id', { id });
      const c = getCompany(m.company_id);
      try {
        const d = await aiDraft(c.id);
        const problems = validateDraft(d, c);
        if (problems.length) { out.aiRejected++; out.notes.push(`${c.name}: AI draft rejected (${problems.join(', ')}) — template used`); continue; }
        q.run('UPDATE messages SET subject = :subject, body = :body WHERE id = :id', { subject: d.subject, body: d.body, id });
        out.aiWritten++;
      } catch (e) {
        out.notes.push(`${c.name}: AI unavailable (${e.message}) — template used`);
        if (/rate limit|reach Groq|rejected the API key/.test(e.message)) break; // don't hammer the API
      }
    }
  } else if (fresh.length) out.notes.push('No Groq key — emails use your templates');
  const appr = approveMessages([...waiting, ...fresh]);
  out.approved = appr.approved.length; out.blocked = appr.blocked.length;
  if (getBool('followup_enabled')) {
    const fu = generateFollowups();
    out.followups = approveMessages(fu.ids).approved.length;
  }
  logActivity(null, 'autopilot', out, actor);
  return out;
}

/** Save a hand-edited (or AI-drafted, human-reviewed) intro as a draft. Still needs approval. */
export function createCustomDraft(companyId, { subject, body }) {
  const c = getCompany(companyId);
  if (!c) throw new Error('Company not found');
  if (c.status !== STATUS.READY) throw new Error(`Only READY companies can get an intro draft (status: ${c.status})`);
  if (q.get("SELECT id FROM messages WHERE company_id = :id AND kind = 'intro' AND status IN ('draft','approved','blocked','sent','bounced')", { id: companyId })) {
    throw new Error('This company already has an intro message');
  }
  subject = String(subject || '').trim(); body = String(body || '').trim();
  if (!subject || !body) throw new Error('Subject and body are required');
  if (/\{\{|\}\}/.test(subject + body)) throw new Error('Unfilled {{variables}} remain in the email');
  if (body.length > 2500) throw new Error('Email body is too long (max 2500 characters)');
  const token = crypto.randomBytes(12).toString('hex');
  const res = q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, unsubscribe_token) VALUES (:cid, 'intro', :to, :subject, :body, :token)`, {
    cid: c.id, to: c.contact_email, subject, body, token,
  });
  logActivity(c.id, 'draft_created', { messageId: Number(res.lastInsertRowid), custom: true });
  return { id: Number(res.lastInsertRowid) };
}
