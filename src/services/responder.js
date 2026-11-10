// Answers to people who write back. When someone replies to one of your emails (interested, or asking
// something), the AI writes an answer from the conversation and the facts about them, and it goes out in
// the same thread after a human-like pause (15–45 minutes, never at night in their timezone).
// It hands the conversation to you instead when a person should answer: prices, contracts, complaints,
// anything the notes don't cover, or after 2 automatic answers in one conversation.
import crypto from 'node:crypto';
import { q, nowIso, logActivity } from '../db/index.js';
import { getSetting, getNum } from '../lib/settings.js';
import { getCompany } from './companies.js';
import * as ai from '../integrations/ai.js';
import { verifiedFacts, sendOne, zonedClock, parseAudit } from './outreach.js';
import { offerKey } from '../lib/offers.js';
import { mailPause } from '../integrations/mailer.js';

export const MODES = { auto: 'Answer automatically', review: 'Write the answer, I approve it', off: 'Off — I answer myself' };
export const mode = () => (MODES[getSetting('auto_reply_mode')] ? getSetting('auto_reply_mode') : 'auto');
const maxAnswers = () => Math.max(0, getNum('auto_reply_max') || 2);
const rand = (a, b) => a + Math.random() * (b - a);

/** A human-like moment to send: 15–45 min after their message, but between 8:00 and 20:00 in their timezone. */
export function answerTime(received, now = new Date()) {
  const lo = Math.max(1, getNum('auto_reply_delay_min') || 15);
  const hi = Math.max(lo + 1, getNum('auto_reply_delay_max') || 45);
  let t = new Date(Math.max(now.getTime(), new Date(received).getTime()) + rand(lo, hi) * 60_000);
  const z = zonedClock(t);
  const mins = z.hour * 60 + z.minute;
  if (mins < 8 * 60) t = new Date(t.getTime() + (8 * 60 - mins + rand(5, 50)) * 60_000);
  else if (mins >= 20 * 60) t = new Date(t.getTime() + (24 * 60 - mins + 8 * 60 + rand(5, 50)) * 60_000);
  return t;
}

/** Replies from people (interested or asking something) that have no answer yet. */
export function unanswered({ days = 3 } = {}) {
  return q.all(`SELECT r.* FROM replies r JOIN companies c ON c.id = r.company_id
    WHERE r.classification IN ('positive','neutral') AND r.answer_state IS NULL
      AND c.status NOT IN ('DO_NOT_CONTACT','BOUNCED')
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.reply_ref = r.id)
      AND julianday('now') - julianday(r.received_at) <= :days
    ORDER BY r.received_at ASC LIMIT 5`, { days });
}

const handoff = (r, note) => {
  q.run("UPDATE replies SET answer_state = 'handoff', answer_note = :n, handled = 0 WHERE id = :id", { n: note, id: r.id });
  logActivity(r.company_id, 'reply_handoff', { replyId: r.id, reason: note }, 'responder');
  return { handoff: note };
};

/** Quality check for an answer (same rules as first emails, shorter). */
export function validateAnswer(body, { bookingLink = '' } = {}) {
  const b = String(body || '').trim();
  const words = b.split(/\s+/).filter(Boolean).length;
  const p = [];
  if (words < 20 || words > 150) p.push(`length ${words} words`);
  if (/\{\{|\}\}|\[[^\]]{1,40}\]/.test(b)) p.push('placeholder left in text');
  const links = b.match(/https?:\/\/\S+|www\.\S+/gi) || [];
  const host = (() => { try { return new URL(bookingLink).host; } catch { return ''; } })();
  if (links.some((l) => !host || !l.includes(host))) p.push('contains a link');
  if (/[—–;]/.test(b)) p.push('dashes or semicolons');
  if (/!/.test(b)) p.push('exclamation mark');
  if (/\$\s?\d|\d+\s?%/.test(b)) p.push('mentions a price or percentage');
  if (/\b(as an ai|language model)\b/i.test(b)) p.push('model meta-text');
  const first = String(getSetting('sender_name') || '').split(' ')[0];
  if (first && !b.includes(first)) p.push('missing sign-off');
  return p;
}

/** Write the answer to one reply (queued to send automatically, or held for your approval). */
export async function answer(replyId, { force = false } = {}) {
  const r = q.get('SELECT * FROM replies WHERE id = :id', { id: replyId });
  if (!r) throw new Error('Reply not found');
  if (!r.company_id) throw new Error('This message is not linked to anyone you emailed');
  if (!['positive', 'neutral'].includes(r.classification)) throw new Error(`No answer is written for ${r.classification.replace('_', ' ')} messages`);
  if (!ai.isEnabled()) throw new Error('AI writing is off. Add your free Groq API key in Settings → AI writing.');
  const c = getCompany(r.company_id);
  const previous = q.get("SELECT COUNT(*) AS n FROM messages WHERE company_id = :cid AND kind = 'reply' AND status IN ('sent','approved')", { cid: c.id }).n;
  if (!force && previous >= maxAnswers()) return handoff(r, `Already answered ${previous} time${previous === 1 ? '' : 's'} automatically in this conversation, so the next answer is yours`);
  const ours = (r.message_ref && q.get('SELECT * FROM messages WHERE id = :id', { id: r.message_ref }))
    || q.get("SELECT * FROM messages WHERE company_id = :cid AND status = 'sent' AND kind != 'reply' ORDER BY sent_at DESC LIMIT 1", { cid: c.id });
  if (!ours) return handoff(r, 'Could not find the email they answered');
  const audit = parseAudit(c);
  const facts = [...verifiedFacts(c), ...(audit?.findings || []).slice(0, 3).map((f) => `Noticed on their site: ${f.observed}`)];
  const bookingLink = String(getSetting('booking_link') || '').trim();
  const offer = offerKey(c.offer);
  const res = await ai.draftReply({
    company: c, ourEmail: ours, theirReply: { from: r.from_email, subject: r.subject, text: r.snippet },
    senderName: getSetting('sender_name'), senderCompany: getSetting('sender_company'), senderWebsite: getSetting('sender_website'),
    offerPitch: getSetting(`offer_${offer}_pitch`), bookingLink, freeOffer: getSetting(audit?.profile === 'agency' ? 'email_free_offer_agency' : 'email_free_offer'),
    facts, previousAnswers: previous,
  });
  if (res.handoff) return handoff(r, `The AI left this one for you: ${res.handoff}`);
  const problems = validateAnswer(res.body, { bookingLink });
  if (problems.length) return handoff(r, `The AI answer did not pass the check (${problems.join(', ')}), so it is yours to answer`);
  const auto = mode() === 'auto';
  const at = answerTime(r.received_at);
  const subject = /^re:/i.test(r.subject || '') ? r.subject : `Re: ${r.subject || ours.subject}`;
  const ins = q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, status, approved_at, in_reply_to, refs, reply_ref, send_after, unsubscribe_token, writer)
    VALUES (:cid, 'reply', :to, :subject, :body, :status, :appr, :irt, :refs, :ref, :at, :token, 'ai')`, {
    cid: c.id, to: r.from_email, subject, body: res.body, status: auto ? 'approved' : 'draft', appr: auto ? nowIso() : null,
    irt: r.message_id, refs: [ours.message_id, r.message_id].filter(Boolean).join(' '), ref: r.id, at: at.toISOString(),
    token: ours.unsubscribe_token || crypto.randomBytes(12).toString('hex'),
  });
  q.run('UPDATE replies SET answer_state = :s, answer_note = NULL WHERE id = :id', { s: auto ? 'queued' : 'review', id: r.id });
  logActivity(c.id, 'reply_answer_written', { replyId: r.id, messageId: Number(ins.lastInsertRowid), sendAt: at.toISOString(), auto }, 'responder');
  return { messageId: Number(ins.lastInsertRowid), sendAt: at.toISOString(), auto };
}

/** Send answers whose time has come. */
export async function sendDue() {
  if (mailPause().paused) return { skipped: 'mailbox error' };
  const due = q.all("SELECT id, reply_ref FROM messages WHERE kind = 'reply' AND status = 'approved' AND (send_after IS NULL OR send_after <= :now) ORDER BY send_after LIMIT 3", { now: nowIso() });
  const out = [];
  for (const m of due) {
    const r = await sendOne(m.id, { actor: 'responder' });
    if (r.ok) {
      const rep = q.get('SELECT classification FROM replies WHERE id = :id', { id: m.reply_ref });
      // A question that got its answer is done; an interested person stays on your list until you take it from here.
      q.run("UPDATE replies SET answer_state = 'sent', handled = :h WHERE id = :id", { h: rep?.classification === 'neutral' ? 1 : 0, id: m.reply_ref });
    }
    out.push({ id: m.id, ...r });
  }
  return { sent: out.filter((x) => x.ok).length, results: out };
}

/** Scheduler entry: write answers for new replies, then send the ones that are due. */
export async function tick() {
  if (mode() === 'off') return { skipped: 'answering replies is off' };
  const written = [];
  if (ai.isEnabled()) {
    for (const r of unanswered()) {
      try { written.push({ replyId: r.id, ...(await answer(r.id)) }); } catch (e) { written.push({ replyId: r.id, error: e.message }); if (/rate limit|reach Groq|API key/.test(e.message)) break; }
    }
  }
  const sent = await sendDue();
  return { written, ...sent };
}

/** Send a queued or reviewed answer now (from the Replies page). */
export async function sendNow(messageId) {
  const m = q.get("SELECT * FROM messages WHERE id = :id AND kind = 'reply'", { id: messageId });
  if (!m) throw new Error('Answer not found');
  if (!['draft', 'approved'].includes(m.status)) throw new Error(`This answer is already ${m.status}`);
  q.run("UPDATE messages SET status = 'approved', approved_at = COALESCE(approved_at, :now), send_after = :now WHERE id = :id", { now: nowIso(), id: messageId });
  const r = await sendOne(messageId, { actor: 'user' });
  if (r.ok) q.run("UPDATE replies SET answer_state = 'sent' WHERE id = :id", { id: m.reply_ref });
  return r;
}

export function editAnswer(messageId, body) {
  const m = q.get("SELECT * FROM messages WHERE id = :id AND kind = 'reply' AND status IN ('draft','approved')", { id: messageId });
  if (!m) throw new Error('Only answers that were not sent yet can be edited');
  if (!String(body || '').trim()) throw new Error('The answer is empty');
  q.run("UPDATE messages SET body = :b, writer = 'human' WHERE id = :id", { b: String(body).trim(), id: messageId });
  return { ok: true };
}

export function cancelAnswer(messageId) {
  const m = q.get("SELECT * FROM messages WHERE id = :id AND kind = 'reply' AND status IN ('draft','approved')", { id: messageId });
  if (!m) throw new Error('Only answers that were not sent yet can be cancelled');
  q.run("UPDATE messages SET status = 'cancelled', status_reason = 'Cancelled by you' WHERE id = :id", { id: messageId });
  q.run("UPDATE replies SET answer_state = 'skipped', answer_note = 'You chose to answer yourself', handled = 0 WHERE id = :id", { id: m.reply_ref });
  return { ok: true };
}

/** For the Automation schedule page. */
export function status() {
  const queued = q.get("SELECT COUNT(*) AS n, MIN(send_after) AS next FROM messages WHERE kind = 'reply' AND status = 'approved'");
  return {
    mode: mode(), aiEnabled: ai.isEnabled(), queued: queued.n, next: queued.next,
    review: q.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'reply' AND status = 'draft'").n,
    handoff: q.get("SELECT COUNT(*) AS n FROM replies WHERE answer_state = 'handoff' AND handled = 0").n,
    sent: q.get("SELECT COUNT(*) AS n FROM messages WHERE kind = 'reply' AND status = 'sent'").n,
    lastSent: q.get("SELECT MAX(sent_at) AS t FROM messages WHERE kind = 'reply' AND status = 'sent'").t,
  };
}
