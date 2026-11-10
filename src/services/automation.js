// "What runs when": every automatic job, its state right now, why it is waiting, when it last ran
// and when it runs next — plus today's hour-by-hour activity, in the user's own timezone.
// Nothing here changes anything; it only explains what the scheduler (scheduler.js) is doing.
import { q } from '../db/index.js';
import { getSetting, getNum, getBool } from '../lib/settings.js';
import { reportTimezone, parseTs, dayStartIn, nextDayStartIn } from '../lib/clock.js';
import * as engine from './engine.js';
import { isRunning as researchRunning, progress as researchProgress } from './research.js';
import { sendPlan, quotaStatus, zonedDayStart, zonedNow, inSendWindow, bounceGuard } from './outreach.js';
import { mailPause } from '../integrations/mailer.js';
import * as imap from '../integrations/imap.js';
import { listSources } from './sources.js';
import { runningJob } from './jobs.js';
import * as responder from './responder.js';
import * as ai from '../integrations/ai.js';

const MIN = 60_000; const HOUR = 60 * MIN;
const fmt = (v) => Number(v || 0).toLocaleString('en-US');
const plural = (k, one, many = `${one}s`) => `${fmt(k)} ${k === 1 ? one : many}`;
const later = (iso, minutes) => (iso ? new Date(parseTs(iso).getTime() + minutes * MIN).toISOString() : null);
const iso = (d) => (d ? d.toISOString() : null);
const every = (m) => (Number.isInteger(m) ? m : Math.round(m * 10) / 10);
const count = (sql, p = {}) => q.get(sql, p).n;
const city = (tz) => String(tz || '').split('/').pop().replace(/_/g, ' ');

// ---------------------------------------------------------------- sending hours (recipients' timezone)
const sendDays = () => String(getSetting('send_days') || '0,1,2,3,4,5,6').split(',').map(Number);
/** Start instants of `n` consecutive recipients' days, beginning with the one that contains `from`. */
function sendDayStarts(from, n) {
  const out = [zonedDayStart(from)];
  while (out.length < n) out.push(zonedDayStart(new Date(out[out.length - 1].getTime() + 36 * HOUR)));
  return out;
}
function windowOf(dayStart) {
  const ws = getNum('send_window_start'); const we = Math.max(ws + 1, getNum('send_window_end'));
  return {
    start: new Date(dayStart.getTime() + ws * HOUR), end: new Date(dayStart.getTime() + we * HOUR),
    open: sendDays().includes(zonedNow(new Date(dayStart.getTime() + 12 * HOUR)).day),
  };
}
/** When the next sending window opens after `d` (skipping days that are not send days). */
export function nextWindowStart(d = new Date(), { afterToday = false } = {}) {
  const today = zonedDayStart(d).getTime();
  for (const ds of sendDayStarts(d, 9)) {
    if (afterToday && ds.getTime() === today) continue;
    const w = windowOf(ds);
    if (w.open && w.start > d) return w.start;
  }
  return null;
}

// ---------------------------------------------------------------- one row per automatic job
function engineRow(now) {
  const c = engine.config();
  const today = engine.importedToday();
  const row = { key: 'engine', label: 'Finding new leads', href: '#/engine', last: getSetting('engine_last_run') || null, progress: { value: today, max: c.dailyCap, label: 'new leads today' } };
  if (!c.enabled) return { ...row, state: 'off', reason: 'The lead engine is off. Turn it on to find new businesses around the clock.', fix: { href: '#/engine', text: 'Turn on' } };
  const job = runningJob('engine');
  if (job) return { ...row, state: 'running', reason: job.message || job.label };
  const p = engine.pauseReason();
  if (p?.code === 'cap') {
    return { ...row, state: 'paused', reason: `Daily limit reached: ${fmt(today)} of ${fmt(c.dailyCap)} new leads were added today. It starts again by itself at midnight, your time.`,
      next: p.resumesAt, nextLabel: 'Starts again', fix: { href: '#/engine', text: 'Raise the daily limit' } };
  }
  if (p?.code === 'done') return { ...row, state: 'waiting', reason: p.text, next: q.get('SELECT MIN(next_run_at) AS t FROM engine_targets').t, nextLabel: 'Next re-check' };
  const gap = every(60 / c.perHour);
  return { ...row, state: 'active', reason: `One search (a business type in a city) every ${gap} min, up to ${fmt(c.dailyCap)} new leads a day.`,
    next: row.last ? later(row.last, gap) : iso(now), nextLabel: 'Next search' };
}

function researchRow(now) {
  const engineOn = getBool('engine_enabled');
  const on = getBool('research_auto_enabled') || getBool('autopilot_enabled') || engineOn;
  const gap = engineOn ? Math.min(5, getNum('research_interval_minutes')) : getNum('research_interval_minutes');
  const row = { key: 'research', label: 'Researching leads', href: '#/research', last: getSetting('last_research_run') || null };
  if (researchRunning()) {
    const p = researchProgress();
    return { ...row, state: 'running', reason: `Checking ${plural(p.total, 'company', 'companies')} now: website, published email and fit.`, progress: { value: p.done, max: p.total, label: 'checked' } };
  }
  if (!on) return { ...row, state: 'off', reason: 'Automatic research is off. Turn on autopilot or the lead engine, or run a batch yourself.', fix: { href: '#/research', text: 'Run a batch' } };
  const h = getNum('research_rescreen_hours') || 24;
  const p = { now: iso(now), h };
  const waiting = count(`SELECT COUNT(*) AS n FROM companies WHERE status IN ('RESEARCHING','HOLD_VERIFY')
      AND (next_screen_at IS NULL OR next_screen_at <= :now)
      AND (last_screened_at IS NULL OR julianday('now') - julianday(last_screened_at) >= :h / 24.0 OR updated_at > last_screened_at OR next_screen_at <= :now)`, p);
  const nextRun = row.last ? later(row.last, gap) : iso(now);
  if (waiting) return { ...row, state: 'active', reason: `${plural(waiting, 'lead')} waiting to be checked, ${fmt(getNum('research_batch_size'))} every ${gap} min.`, next: nextRun, nextLabel: 'Next batch' };
  const back = q.get(`SELECT MIN(MAX(COALESCE(next_screen_at, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', julianday(last_screened_at) + :h / 24.0), ''))) AS t
      FROM companies WHERE status IN ('RESEARCHING','HOLD_VERIFY')`, { h }).t;
  return { ...row, state: 'waiting', reason: `Nothing to check right now: every lead was checked in the last ${h} hours. Leads still missing an email are checked again when their time comes.`,
    next: back || nextRun, nextLabel: back ? 'Next lead due' : 'Next look' };
}

function writingRow(now) {
  const row = { key: 'writing', label: 'Writing emails', href: '#/outreach', last: getSetting('last_autopilot_topup') || null };
  const job = runningJob('autopilot');
  if (job) return { ...row, state: 'running', reason: job.message || "Writing today's emails." };
  if (!getBool('autopilot_enabled')) return { ...row, state: 'off', reason: 'Autopilot is off: you write and approve each email yourself in Outreach.', fix: { href: '#/', text: 'Turn on autopilot' } };
  const approved = count("SELECT COUNT(*) AS n FROM messages WHERE status = 'approved' AND kind != 'reply'");
  const held = count("SELECT COUNT(*) AS n FROM messages WHERE status = 'draft' AND kind = 'intro' AND writer IN ('ai','human')");
  const aiWait = count("SELECT COUNT(*) AS n FROM messages WHERE status = 'draft' AND kind = 'intro' AND ai_error IS NOT NULL AND (writer IS NULL OR writer = 'template')");
  const ready = count("SELECT COUNT(*) AS n FROM companies WHERE status = 'READY'");
  const { remaining } = quotaStatus(now);
  const next = { next: row.last ? later(row.last, 60) : iso(now), nextLabel: 'Next top-up' };
  if (getBool('autopilot_review') && held) return { ...row, ...next, state: 'attention', reason: `${plural(held, 'email')} written and waiting for your approval.`, fix: { href: '#/outreach', text: 'Approve them' } };
  if (aiWait) {
    const err = q.get("SELECT ai_error AS e FROM messages WHERE status = 'draft' AND kind = 'intro' AND ai_error IS NOT NULL ORDER BY id DESC LIMIT 1")?.e || '';
    return { ...row, ...next, state: 'paused', reason: `${plural(aiWait, 'email')} waiting for the AI writer (${err.slice(0, 140)}). Template emails are never sent instead; it tries again every hour.`, fix: /API key/.test(err) ? { href: '#/settings?tab=ai', text: 'Check the Groq key' } : null };
  }
  if (approved && approved >= remaining) return { ...row, ...next, state: 'done', reason: `${plural(approved, 'email')} written and approved, enough for the next sends. It checks every hour for more.` };
  if (!ready) return { ...row, ...next, state: 'waiting', reason: 'No lead is ready to email yet. Research finds more; this checks every hour.' };
  return { ...row, ...next, state: 'active', reason: `Writes one personal email per ready lead (${fmt(ready)} ready) and approves it, every hour.` };
}

function sendingRow(now) {
  const plan = sendPlan(now);
  const ds = zonedDayStart(now); const w = windowOf(ds);
  const tz = getSetting('send_timezone');
  const row = {
    key: 'sending', label: 'Sending emails', href: '#/outreach',
    last: q.get("SELECT MAX(sent_at) AS t FROM messages WHERE status IN ('sent','bounced')").t,
    progress: { value: plan.sent, max: plan.limit, label: `sent for ${plan.dayLabel}` },
    window: { start: iso(w.start), end: iso(w.end), from: plan.windowStart, to: plan.windowEnd, timezone: tz, city: city(tz) },
  };
  if (!getBool('auto_send_enabled') && !getBool('autopilot_enabled')) return { ...row, state: 'off', reason: 'Automatic sending is off. Approved emails wait until you press Send.' };
  const bg = bounceGuard();
  if (bg.paused) return { ...row, state: 'paused', reason: `Paused to protect your domain: ${bg.rate}% of last week's emails bounced (the limit is 5%). It restarts once that drops.`, fix: { href: '#/replies', text: 'See bounces' } };
  const mp = mailPause();
  if (mp.paused) return { ...row, state: 'paused', reason: `Paused after a mailbox error: ${mp.error || 'the mail server refused the connection'}`, next: mp.until, nextLabel: 'Tries again', fix: { href: '#/integrations', text: 'Check the mailbox' } };
  const approved = count("SELECT COUNT(*) AS n FROM messages WHERE status = 'approved'");
  const hours = `Sending hours are ${plan.windowStart}–${plan.windowEnd} in ${row.window.city}, while your recipients are at work.`;
  if (plan.sent >= plan.limit) {
    return { ...row, state: 'done', reason: `All ${plan.limit} emails for ${plan.dayLabel} are sent (your warm-up limit). ${hours}`, next: iso(nextWindowStart(now, { afterToday: true })), nextLabel: 'Next sending day' };
  }
  if (!inSendWindow(now)) {
    return { ...row, state: 'waiting', reason: `Outside sending hours. ${hours}${approved ? ` ${plural(approved, 'email')} ready to go.` : ' Nothing is approved yet.'}`, next: iso(nextWindowStart(now)), nextLabel: 'Sending starts' };
  }
  if (!approved) return { ...row, state: 'waiting', reason: 'Inside sending hours, but no email is approved yet. Autopilot writes more within the hour.' };
  const slot = plan.slots[Math.max(plan.sent, plan.due)];
  const at = slot ? new Date(ds.getTime() + slot.atMin * MIN) : now;
  return { ...row, state: 'active', reason: `Sending at random, human-like times (${getNum('min_minutes_between_sends')}–${getNum('max_minutes_between_sends')} min apart, with breaks). ${plan.sent} of ${plan.limit} sent.`,
    next: iso(at > now ? at : now), nextLabel: 'Next email' };
}

function answersRow(now) {
  const st = responder.status();
  const row = { key: 'answers', label: 'Answering replies', href: '#/replies', last: st.lastSent || null };
  if (st.mode === 'off') return { ...row, state: 'off', reason: 'Off: you answer every reply yourself.', fix: { href: '#/replies', text: 'Turn on' } };
  if (!ai.isEnabled()) return { ...row, state: 'blocked', reason: 'Needs the Groq AI key to write answers.', fix: { href: '#/settings?tab=ai', text: 'Add the key' } };
  if (st.review) return { ...row, state: 'attention', reason: `${plural(st.review, 'answer')} written and waiting for your approval.`, fix: { href: '#/replies', text: 'Review' } };
  if (st.queued) return { ...row, state: 'active', reason: `${plural(st.queued, 'answer')} written and waiting for a natural moment to send (15 to 45 minutes after their message, 8 AM to 8 PM their time).`, next: st.next, nextLabel: 'Next answer' };
  if (st.handoff) return { ...row, state: 'attention', reason: `${plural(st.handoff, 'reply', 'replies')} need you (a price, a meeting time or something the AI should not answer).`, fix: { href: '#/replies', text: 'Answer them' } };
  return { ...row, state: 'waiting', reason: `${st.mode === 'review' ? 'Writes an answer for you to approve' : 'Answers'} anyone who writes back interested or with a question. Out-of-office and "not interested" replies are never answered.` };
}

function mailboxRow(now) {
  const row = { key: 'mailbox', label: 'Checking replies', href: '#/replies', last: getSetting('imap_last_sync') || null };
  if (!imap.isConfigured()) return { ...row, state: 'off', reason: 'Connect your mailbox so replies, bounces and opt-outs are picked up.', fix: { href: '#/integrations', text: 'Connect' } };
  if (runningJob('mailbox')) return { ...row, state: 'running', reason: 'Reading your inbox now.' };
  const gap = getNum('imap_sync_minutes') || 10;
  return { ...row, state: 'active', reason: `Reads your inbox every ${gap} min for replies, bounces and opt-outs.`, next: row.last ? later(row.last, gap) : iso(now), nextLabel: 'Next check' };
}

const SOURCE_STATE = { waiting_credits: 'paused', rate_limited: 'paused', plan: 'blocked', auth: 'blocked', error: 'waiting', running: 'running', done: 'done', ready: 'active', idle: 'active' };
function sourceRows() {
  return listSources().filter((s) => s.configured && (s.enabled || s.status === 'auth')).map((s) => ({
    key: `source-${s.name}`, label: s.label, href: '#/integrations', last: s.last_run_at || null,
    state: SOURCE_STATE[s.status] || 'active', reason: s.message || s.what,
    next: s.resume_at || null, nextLabel: s.resume_at ? 'Tries again' : null,
    fix: ['auth', 'plan'].includes(s.status) ? { href: '#/integrations', text: 'Update the key' } : null,
  }));
}

// ---------------------------------------------------------------- today, hour by hour (your timezone)
function timeline(now, rows) {
  const tz = reportTimezone();
  const start = dayStartIn(now, tz); const end = nextDayStartIn(now, tz);
  const span = Math.round((end - start) / MIN); const hours = Math.round(span / 60);
  const s = iso(start);
  const minOf = (t) => (parseTs(t).getTime() - start.getTime()) / MIN;
  const perHour = () => Array(hours).fill(0);
  const bin = (arr, m, v = 1) => { const h = Math.floor(m / 60); if (h >= 0 && h < hours) arr[h] += v; };
  const nowMin = (now - start) / MIN;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  const searches = perHour();
  for (const j of q.all("SELECT started_at AS t FROM jobs WHERE kind = 'engine' AND started_at >= :s", { s })) bin(searches, minOf(j.t));
  const checked = perHour();
  for (const j of q.all("SELECT started_at AS t, done FROM jobs WHERE kind = 'research' AND done > 0 AND started_at >= :s", { s })) bin(checked, minOf(j.t), j.done);
  const marks = q.all("SELECT sent_at AS t FROM messages WHERE status IN ('sent','bounced') AND sent_at >= :s", { s }).map((r) => Math.round(minOf(r.t)));
  const sent = perHour(); marks.forEach((m) => bin(sent, m));

  // Sending hours that fall on your day (a US window can straddle your midnight).
  const windows = [];
  for (const ds of sendDayStarts(new Date(start.getTime() - 12 * HOUR), 4)) {
    const w = windowOf(ds); if (!w.open) continue;
    const a = Math.max(0, (w.start - start) / MIN); const b = Math.min(span, (w.end - start) / MIN);
    if (b > a) windows.push([Math.round(a), Math.round(b)]);
  }
  const sending = byKey.sending;
  const planned = ['off', 'paused'].includes(sending.state) ? [] : sendPlan(now).slots.filter((x) => !x.sent)
    .map((x) => Math.round((zonedDayStart(now).getTime() + x.atMin * MIN - start.getTime()) / MIN)).filter((m) => m >= 0 && m <= span);

  // When the lead engine stopped today, and why.
  const eng = byKey.engine; const paused = [];
  if (eng.state === 'paused' && eng.next) {
    const cap = engine.config().dailyCap;
    const hit = q.get(`SELECT created_at AS t FROM companies WHERE lead_origin IN ('openstreetmap','apollo') AND datetime(created_at) >= datetime(:s)
      ORDER BY datetime(created_at) LIMIT 1 OFFSET :o`, { s, o: Math.max(0, cap - 1) })?.t;
    paused.push([Math.max(0, Math.round(hit ? minOf(hit) : nowMin)), span, 'daily limit reached']);
  } else if (eng.state === 'off') paused.push([Math.max(0, Math.round(nowMin)), span, 'turned off']);
  else if (eng.state === 'waiting') paused.push([Math.max(0, Math.round(nowMin)), Math.min(span, eng.next ? Math.round(minOf(eng.next)) : span), 'every search done']);

  return {
    tz, start: s, span, hours, nowMin: Math.round(nowMin),
    rows: [
      { key: 'engine', label: 'Finding leads', unit: 'searches', values: searches, paused },
      { key: 'research', label: 'Researching', unit: 'leads checked', values: checked },
      { key: 'sending', label: 'Sending', unit: 'emails sent', values: sent, windows, marks, planned },
    ],
  };
}

/** Everything the "Automation schedule" card shows. */
export function automationStatus(now = new Date()) {
  const rows = [engineRow(now), researchRow(now), writingRow(now), sendingRow(now), mailboxRow(now), answersRow(now), ...sourceRows()];
  return { now: iso(now), timezone: reportTimezone(), sendTimezone: getSetting('send_timezone'), rows, timeline: timeline(now, rows) };
}
