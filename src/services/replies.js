// Phase 10: reply handling, bounces, opt-outs and the local sales pipeline.
import { q, nowIso, logActivity } from '../db/index.js';
import { normalizeEmail, emailDomain, rootDomain } from '../lib/normalize.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { addSuppression, runDedup } from './suppression.js';
import { getCompany, reevaluate } from './companies.js';
import * as imap from '../integrations/imap.js';
import { PIPELINE_STAGES } from '../lib/constants.js';

const OPT_OUT = /\b(unsubscribe|remove me|take me off|opt[\s-]?out|stop (emailing|contacting|sending)|do not (contact|email)|don't (contact|email)|no more emails|remove (us|our)|please remove)\b/i;
const NEGATIVE = /\b(not interested|no thanks|no thank you|not a (good )?fit|we('re| are) (all )?set|not at this time|not right now|pass on this|we('re| are) good|already have (a|an|our))\b/i;
const POSITIVE = /\b(interested|let'?s (talk|chat|connect)|happy to (chat|talk|connect)|schedule|book a|calendar|calendly|sounds good|tell me more|send (me )?(over|more)|pricing|rates|availability|available (on|next|this)|set up a (call|time)|hop on a call|would love to)\b/i;
const AUTO = /^(automatic reply|auto(-|matic)? ?reply|out of (the )?office|ooo\b|away from|on vacation|autoreply|abwesenheit)/i;
const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|bounce)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|mail delivery (failed|subsystem)|returned mail|delivery failure|failure notice|could not be delivered|message not delivered)/i;

/** Strip quoted history so we classify only what the person wrote. */
export function latestText(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .+wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From: .+/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

export function classify({ from = '', subject = '', text = '', headers = '' }) {
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject)) return 'bounce';
  if (/auto-submitted:\s*auto-(replied|generated)/i.test(headers) || /x-autoreply/i.test(headers) || AUTO.test(subject.trim())) return 'auto_reply';
  const body = latestText(text);
  const s = `${subject.replace(/^(re|fw|fwd):\s*/i, '')}\n${body}`;
  if (OPT_OUT.test(body) || /^\s*unsubscribe\s*$/i.test(subject)) return 'opt_out';
  if (NEGATIVE.test(s)) return 'negative';
  if (POSITIVE.test(body)) return 'positive';
  return 'neutral';
}

export function extractBouncedRecipient(text) {
  const t = String(text || '');
  const m = t.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i) || t.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i);
  if (m) return normalizeEmail(m[1]);
  const ours = getSetting('sender_email').toLowerCase();
  const candidates = [...t.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((x) => x[0].toLowerCase()).filter((e) => e !== ours && !/mailer-daemon|postmaster/.test(e));
  return normalizeEmail(candidates[0] || '');
}

function matchMessage({ inReplyTo, references, from }) {
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : String(references || '').split(/\s+/))].filter(Boolean);
  for (const id of ids) {
    const m = q.get('SELECT * FROM messages WHERE message_id = :id', { id });
    if (m) return m;
  }
  if (from) {
    const m = q.get("SELECT * FROM messages WHERE to_email = :e AND status IN ('sent','bounced') ORDER BY sent_at DESC LIMIT 1", { e: from });
    if (m) return m;
    const d = emailDomain(from);
    if (d) {
      const byDomain = q.get(`SELECT m.* FROM messages m JOIN companies c ON c.id = m.company_id WHERE c.domain IN (:d, :r) AND m.status IN ('sent','bounced') ORDER BY m.sent_at DESC LIMIT 1`, { d, r: rootDomain(d) });
      if (byDomain) return byDomain;
    }
  }
  return null;
}

/** Process one inbound message (used by IMAP sync and by tests). */
const SYSTEM_SENDER = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|news(letter)?|mailer|updates?|billing|security|accounts?|team|support|marketing|info|hello)@/i;

/**
 * Is this inbox message related to your outreach? True when it answers one of your sent emails
 * (In-Reply-To / References) or comes from someone you emailed before it arrived.
 * Welcome emails, login codes, newsletters and your own tests are not replies.
 */
export function relatedToOutreach({ from, date, inReplyTo, references, subject }) {
  const ours = getSetting('sender_email').toLowerCase();
  if (!from || from === ours) return false;
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : String(references || '').split(/\s+/))].filter(Boolean);
  for (const id of ids) {
    if (q.get("SELECT 1 FROM mail_history WHERE direction = 'out' AND message_id = :id", { id })) return true;
    if (q.get('SELECT 1 FROM messages WHERE message_id = :id', { id })) return true;
  }
  if (SYSTEM_SENDER.test(from) && !/^re:/i.test(subject || '')) return false;
  const at = date || nowIso();
  return !!q.get("SELECT 1 FROM mail_history WHERE direction = 'out' AND email = :e AND (date IS NULL OR date <= :at) LIMIT 1", { e: from, at });
}

/** Re-check older unmatched inbox messages with the rule above (keeps the 'waiting' count honest). */
export function reclassifyUnmatched() {
  let changed = 0;
  for (const r of q.all("SELECT * FROM replies WHERE company_id IS NULL AND classification IN ('positive','neutral','negative') AND handled = 0")) {
    if (!relatedToOutreach({ from: r.from_email, date: r.received_at, subject: r.subject })) {
      q.run("UPDATE replies SET classification = 'other', handled = 1 WHERE id = :id", { id: r.id });
      changed++;
    }
  }
  return changed;
}

export function processInbound(msg) {
  const messageId = msg.messageId || `${msg.from}-${msg.date}-${msg.subject}`;
  if (q.get('SELECT id FROM replies WHERE message_id = :id', { id: messageId })) return { duplicate: true };
  const from = normalizeEmail(msg.from);
  let classification = classify({ from, subject: msg.subject, text: msg.text, headers: msg.headers });
  let target = null;
  let bouncedEmail = '';
  if (classification === 'bounce') {
    bouncedEmail = extractBouncedRecipient(msg.text);
    if (bouncedEmail) target = q.get("SELECT * FROM messages WHERE to_email = :e AND status = 'sent' ORDER BY sent_at DESC LIMIT 1", { e: bouncedEmail });
    if (!target) target = matchMessage({ inReplyTo: msg.inReplyTo, references: msg.references });
  } else {
    target = matchMessage({ inReplyTo: msg.inReplyTo, references: msg.references, from });
  }
  const companyId = target?.company_id ?? null;
  if (!companyId && classification !== 'bounce' && classification !== 'auto_reply'
    && !relatedToOutreach({ from, date: msg.date, inReplyTo: msg.inReplyTo, references: msg.references, subject: msg.subject })) {
    classification = 'other'; // not about your outreach: kept, but not "waiting for you"
  }
  const res = q.run(`INSERT INTO replies (company_id, message_ref, from_email, subject, snippet, classification, message_id, received_at, handled)
    VALUES (:cid, :mref, :from, :subject, :snippet, :cls, :mid, :at, :handled)`, {
    cid: companyId, mref: target?.id ?? null, from: from || msg.from, subject: msg.subject, snippet: latestText(msg.text).slice(0, 1200),
    cls: classification, mid: messageId, at: msg.date || nowIso(), handled: ['auto_reply', 'other'].includes(classification) ? 1 : 0,
  });
  const replyId = Number(res.lastInsertRowid);
  if (from && classification !== 'bounce') {
    q.run(`INSERT INTO mail_history (direction, folder, uid, message_id, email, domain, subject, date) VALUES ('in', :folder, :uid, :mid, :e, :d, :s, :date) ON CONFLICT DO NOTHING`, {
      folder: msg.folder || 'INBOX', uid: msg.uid ?? null, mid: messageId, e: from, d: emailDomain(from), s: msg.subject, date: msg.date || nowIso(),
    });
  }
  if (!companyId) return { replyId, classification, matched: false };

  const now = nowIso();
  const cancelPending = (why) => q.run("UPDATE messages SET status = 'cancelled', status_reason = :why WHERE company_id = :cid AND status IN ('draft','approved')", { why, cid: companyId });
  switch (classification) {
    case 'bounce':
      q.run("UPDATE messages SET status = 'bounced', status_reason = 'Bounce received' WHERE id = :id", { id: target.id });
      q.run("UPDATE companies SET status = 'BOUNCED', status_reason = :r, updated_at = :now WHERE id = :cid", { r: `Bounce for ${bouncedEmail || target.to_email}`, now, cid: companyId });
      addSuppression({ kind: 'email', value: bouncedEmail || target.to_email, reason: 'bounce', source: 'imap' });
      cancelPending('Address bounced');
      break;
    case 'opt_out':
      addSuppression({ kind: 'email', value: from, reason: 'opt_out', source: 'reply' });
      q.run("UPDATE companies SET status = 'DO_NOT_CONTACT', status_reason = 'Opt-out reply received', status_locked = 1, updated_at = :now WHERE id = :cid", { now, cid: companyId });
      cancelPending('Recipient opted out');
      break;
    case 'auto_reply':
      break; // out-of-office: keep follow-up schedule
    default:
      q.run("UPDATE companies SET status = 'REPLIED', status_reason = :r, updated_at = :now WHERE id = :cid", { r: `Reply received (${classification})`, now, cid: companyId });
      cancelPending('Prospect replied');
      if (classification === 'positive' && !q.get('SELECT id FROM opportunities WHERE company_id = :cid', { cid: companyId })) {
        q.run("INSERT INTO opportunities (company_id, stage, notes) VALUES (:cid, 'qualified_conversation', :n)", { cid: companyId, n: `Positive reply from ${from} on ${now.slice(0, 10)}` });
      }
  }
  logActivity(companyId, `reply_${classification}`, { from, subject: msg.subject, replyId }, 'imap');
  return { replyId, classification, matched: true, companyId };
}

/** Sync Sent + INBOX from Hostinger. Progress markers (last UID) are persisted. */
export async function syncMailbox() {
  if (!imap.isConfigured()) throw new Error('IMAP is not configured (Settings → Hostinger mailbox)');
  reclassifyUnmatched();
  const stats = { sentScanned: 0, sentRecipients: 0, inboxScanned: 0, replies: 0, bounces: 0, optOuts: 0, unmatched: 0 };
  const sent = await imap.fetchFolder('sent', Number(getSetting('imap_last_uid_sent') || 0));
  const ours = getSetting('sender_email').toLowerCase();
  let maxSent = Number(getSetting('imap_last_uid_sent') || 0);
  const recipients = new Set();
  for (const m of sent.messages) {
    stats.sentScanned++;
    maxSent = Math.max(maxSent, m.uid);
    for (const to of m.to) {
      if (!to || to === ours) continue;
      q.run(`INSERT INTO mail_history (direction, folder, uid, message_id, email, domain, subject, date) VALUES ('out', :folder, :uid, :mid, :e, :d, :s, :date) ON CONFLICT DO NOTHING`, {
        folder: sent.folder, uid: m.uid, mid: m.messageId, e: to, d: emailDomain(to), s: m.subject, date: m.date,
      });
      recipients.add(to);
      stats.sentRecipients++;
    }
  }
  setSetting('imap_last_uid_sent', maxSent);
  // Companies you already emailed from this mailbox are marked as contacted right away
  // (sending re-checks this too, so nobody gets a second intro either way).
  const touched = new Set();
  for (const to of recipients) {
    q.all(`SELECT id FROM companies WHERE (contact_email = :e OR domain = :d) AND status NOT IN ('SENT','FOLLOW_UP','REPLIED','BOUNCED','DO_NOT_CONTACT')`, { e: to, d: emailDomain(to) })
      .forEach((r) => touched.add(r.id));
  }
  for (const id of touched) { runDedup(getCompany(id)); reevaluate(id, 'mailbox_sent_folder'); }
  stats.markedContacted = touched.size;
  const inbox = await imap.fetchFolder('inbox', Number(getSetting('imap_last_uid_inbox') || 0));
  let maxIn = Number(getSetting('imap_last_uid_inbox') || 0);
  for (const m of inbox.messages) {
    stats.inboxScanned++;
    maxIn = Math.max(maxIn, m.uid);
    const r = processInbound(m);
    if (r.duplicate) continue;
    if (!r.matched) { stats.unmatched++; continue; }
    if (r.classification === 'bounce') stats.bounces++;
    else if (r.classification === 'opt_out') stats.optOuts++;
    else if (r.classification !== 'auto_reply') stats.replies++;
  }
  setSetting('imap_last_uid_inbox', maxIn);
  setSetting('imap_last_sync', nowIso());
  q.run(`INSERT INTO runs (kind, started_at, finished_at, status, stats, report) VALUES ('imap', :now, :now, 'ok', :stats, :report)`, {
    now: nowIso(), stats: JSON.stringify(stats),
    report: `Mailbox sync: ${stats.sentScanned} sent msgs (${stats.sentRecipients} recipients), ${stats.inboxScanned} inbox msgs → ${stats.replies} replies, ${stats.bounces} bounces, ${stats.optOuts} opt-outs, ${stats.unmatched} unmatched`,
  });
  return stats;
}

export function listReplies({ classification, handled, other } = {}) {
  const where = []; const p = {};
  if (classification) { where.push('r.classification = :cls'); p.cls = classification; }
  else if (other !== '1') where.push("r.classification != 'other'");
  if (handled !== undefined && handled !== '') { where.push('r.handled = :h'); p.h = Number(handled); }
  return q.all(`SELECT r.*, c.name AS company_name, c.domain FROM replies r LEFT JOIN companies c ON c.id = r.company_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.received_at DESC LIMIT 300`, p);
}

export function updateReply(id, { classification, handled }) {
  const r = q.get('SELECT * FROM replies WHERE id = :id', { id });
  if (!r) throw new Error('Reply not found');
  if (classification && classification !== r.classification) {
    q.run('UPDATE replies SET classification = :c WHERE id = :id', { c: classification, id });
    if (classification === 'opt_out' && r.from_email) {
      addSuppression({ kind: 'email', value: r.from_email, reason: 'opt_out', source: 'manual_reclassify' });
      if (r.company_id) q.run("UPDATE companies SET status = 'DO_NOT_CONTACT', status_reason = 'Opt-out (reclassified)', status_locked = 1 WHERE id = :id", { id: r.company_id });
    }
    if (classification === 'positive' && r.company_id && !q.get('SELECT id FROM opportunities WHERE company_id = :cid', { cid: r.company_id })) {
      q.run("INSERT INTO opportunities (company_id, stage, notes) VALUES (:cid, 'qualified_conversation', 'Created from reclassified reply')", { cid: r.company_id });
    }
    logActivity(r.company_id, 'reply_reclassified', { from: r.classification, to: classification });
  }
  if (handled !== undefined) q.run('UPDATE replies SET handled = :h WHERE id = :id', { h: handled ? 1 : 0, id });
}

export function suggestedResponse(replyId) {
  const r = q.get('SELECT r.*, c.name, c.dm_name, c.offer FROM replies r LEFT JOIN companies c ON c.id = r.company_id WHERE r.id = :id', { id: replyId });
  if (!r) throw new Error('Reply not found');
  const first = (r.dm_name || '').split(' ')[0] || 'there';
  const name = getSetting('sender_name');
  if (r.classification === 'positive') {
    return `Hi ${first},\n\nThanks for getting back to me — glad this is relevant. The easiest next step is a free 20–30 minute qualification call where we map the workflow and see whether a small paid discovery/technical planning phase makes sense.\n\nWould any of these work for you? [propose 2–3 times]\n\nBest,\n${name}`;
  }
  if (r.classification === 'negative') return `Hi ${first},\n\nUnderstood — thanks for letting me know. I won't follow up on this.\n\nBest,\n${name}`;
  return `Hi ${first},\n\nThanks for your reply. [respond to their question]\n\nBest,\n${name}`;
}

// ---- Pipeline ----
export function listOpportunities() {
  return q.all('SELECT o.*, c.name AS company_name, c.domain, c.offer FROM opportunities o JOIN companies c ON c.id = o.company_id ORDER BY o.updated_at DESC');
}

export function upsertOpportunity({ id, company_id, stage, value, notes }) {
  if (stage && !PIPELINE_STAGES.some(([k]) => k === stage)) throw new Error('Invalid stage');
  if (id) {
    q.run('UPDATE opportunities SET stage = COALESCE(:stage, stage), value = COALESCE(:value, value), notes = COALESCE(:notes, notes), updated_at = :now WHERE id = :id', {
      stage, value: value === '' || value == null ? null : Number(value), notes, now: nowIso(), id,
    });
    logActivity(company_id ?? null, 'opportunity_updated', { id, stage, value });
    return q.get('SELECT * FROM opportunities WHERE id = :id', { id });
  }
  const res = q.run('INSERT INTO opportunities (company_id, stage, value, notes) VALUES (:cid, :stage, :value, :notes)', {
    cid: company_id, stage: stage || 'qualified_conversation', value: value ? Number(value) : null, notes,
  });
  return q.get('SELECT * FROM opportunities WHERE id = :id', { id: Number(res.lastInsertRowid) });
}
