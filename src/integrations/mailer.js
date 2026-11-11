// Phase 9: Hostinger SMTP transport. In test mode ("capture") messages are kept in memory.
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from '../lib/settings.js';

export const captured = [];

// One Hostinger login is used for both sending (SMTP) and reading (IMAP).
// The mailbox email defaults to the sender email from Settings → Sender.
export const mailboxUser = () => getSetting('smtp_user') || getSetting('sender_email');
export const mailboxPass = () => getSetting('smtp_pass');

export function isConfigured() {
  if (getSetting('mail_transport') === 'capture') return true;
  return !!(getSetting('smtp_host') && mailboxUser() && mailboxPass());
}

function transport() {
  if (getSetting('mail_transport') === 'capture') {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  const port = Number(getSetting('smtp_port') || 465);
  return nodemailer.createTransport({
    host: getSetting('smtp_host'),
    port,
    secure: port === 465, // 465 = SSL/TLS; 587 = STARTTLS (required below)
    requireTLS: port !== 465,
    auth: { user: mailboxUser(), pass: mailboxPass() },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
  });
}

/** Turn SMTP/IMAP errors into something a non-technical user can act on. */
export function friendlyMailError(e, kind = 'SMTP') {
  const msg = String(e?.response || e?.message || e || '');
  const code = e?.code || '';
  const host = kind === 'IMAP' ? getSetting('imap_host') : getSetting('smtp_host');
  if (code === 'EAUTH' || e?.authenticationFailed || /\b535\b|authenticat|invalid credentials|AUTHENTICATIONFAILED|login failed/i.test(msg)) {
    return `Hostinger rejected the email or password for ${mailboxUser()}. Use the mailbox password (the one for webmail), not your hPanel login — you can reset it in hPanel → Emails → Email accounts.`;
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(msg)) return `Could not find the server ${host} — check the host name, or your internet connection.`;
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET'].includes(code) || /timeout|ECONNREFUSED|ECONNRESET/i.test(msg)) {
    return kind === 'SMTP'
      ? `Could not connect to ${host}:${getSetting('smtp_port')}. Check your internet connection; if your network blocks it, switch the SMTP port to 587 (STARTTLS).`
      : `Could not connect to ${host}:${getSetting('imap_port')}. Check your internet connection.`;
  }
  return msg.slice(0, 300) || `${kind} connection failed`;
}

/** Log in to the SMTP server without sending anything (raw errors). */
async function probe() {
  if (getSetting('mail_transport') === 'capture') return;
  if (!mailboxPass()) throw Object.assign(new Error('No mailbox password is saved'), { code: 'EAUTH' });
  await transport().verify();
}

export async function verifyConnection() {
  if (getSetting('mail_transport') === 'capture') { clearMailError(); return { ok: true, detail: 'capture mode (test) — no real email is sent' }; }
  if (!mailboxPass()) throw new Error('Enter the mailbox password first (Settings → Integrations → Hostinger mailbox), then save.');
  try { await probe(); } catch (e) { throw new Error(friendlyMailError(e, 'SMTP')); }
  clearMailError();
  return { ok: true, detail: `Sending works — logged in to ${getSetting('smtp_host')} as ${mailboxUser()}` };
}

/**
 * Errors that are about the mailbox/connection (wrong password, network, Hostinger rate limit),
 * not about one recipient. These must not burn through the approved queue.
 */
export function isMailboxError(e) {
  const code = e?.code || '';
  const rc = Number(e?.responseCode || 0);
  if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EGREETING'].includes(code)) return true;
  if ([421, 450, 451, 452, 454, 530, 534, 535].includes(rc)) return true;
  return /too many|rate limit|limit exceeded|quota|try again later/i.test(String(e?.response || e?.message || ''));
}

/** What kind of mailbox problem this is; it decides how soon the connection is tested again. */
export function mailErrorKind(e) {
  const code = e?.code || '';
  const rc = Number(e?.responseCode || 0);
  const msg = String(e?.response || e?.message || '');
  if (code === 'EAUTH' || e?.authenticationFailed || [530, 534, 535].includes(rc) || /authenticat|invalid credentials|login failed/i.test(msg)) return 'auth';
  if ([421, 450, 451, 452, 454].includes(rc) || /too many|rate limit|limit exceeded|quota|try again later/i.test(msg)) return 'limit';
  return 'network';
}

// Minutes until the connection is tested again. A dropped internet connection usually comes back within
// minutes, so it is tested often (1, 2, 3, then every 5 minutes). A wrong password or Hostinger's sending
// limit is tested gently, because repeated failed logins can get the mailbox locked.
const RETRY_MINUTES = { network: [1, 2, 3, 5], limit: [20], auth: [30] };
export function retryMinutes(kind, failures = 1) {
  const steps = RETRY_MINUTES[kind] || RETRY_MINUTES.network;
  return steps[Math.min(Math.max(1, failures), steps.length) - 1];
}

const MAIL_STATE = ['mail_last_error', 'mail_last_error_at', 'mail_paused_until', 'mail_error_kind', 'mail_fail_count', 'mail_down_since'];
export function recordMailError(e) {
  const kind = mailErrorKind(e);
  const failures = Number(getSetting('mail_fail_count') || 0) + 1;
  const now = new Date();
  if (!getSetting('mail_last_error')) setSetting('mail_down_since', now.toISOString());
  setSetting('mail_last_error', friendlyMailError(e, 'SMTP'));
  setSetting('mail_last_error_at', now.toISOString());
  setSetting('mail_error_kind', kind);
  setSetting('mail_fail_count', String(failures));
  setSetting('mail_paused_until', new Date(now.getTime() + retryMinutes(kind, failures) * 60000).toISOString());
}
export function clearMailError() {
  if (!getSetting('mail_last_error') && !getSetting('mail_paused_until')) return;
  for (const k of MAIL_STATE) setSetting(k, '');
}
export function mailPause() {
  const until = getSetting('mail_paused_until');
  const error = getSetting('mail_last_error');
  return {
    paused: !!until && new Date(until).getTime() > Date.now(), until: until || null, error: error || null, at: getSetting('mail_last_error_at') || null,
    kind: getSetting('mail_error_kind') || null, failures: Number(getSetting('mail_fail_count') || 0), since: getSetting('mail_down_since') || null,
  };
}

/**
 * Called by the scheduler every minute. After a mailbox error, once the wait is over, it tests the
 * connection (the same login as "Test connection" in Settings). When it works, the error clears and
 * sending carries on by itself, including the emails that missed their time. When it still fails,
 * it waits a little longer and tests again.
 */
export async function reconnect() {
  if (!getSetting('mail_last_error')) return { ok: true, skipped: 'no mailbox error' };
  if (mailPause().paused) return { ok: false, waiting: getSetting('mail_paused_until') };
  try {
    await probe();
  } catch (e) {
    recordMailError(e);
    return { ok: false, error: friendlyMailError(e, 'SMTP'), next: getSetting('mail_paused_until') };
  }
  const since = getSetting('mail_down_since');
  clearMailError();
  setSetting('mail_last_recovered_at', new Date().toISOString());
  setSetting('mail_last_outage_minutes', String(since ? Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 60000)) : ''));
  return { ok: true, reconnected: true, since };
}

/**
 * Send one message. Returns { messageId, raw } where raw is the RFC822 source
 * (used to append a copy to the IMAP Sent folder).
 */
export async function sendMail({ from, to, subject, text, inReplyTo, references, listUnsubscribe, messageId }) {
  const msg = {
    from, to, subject, text,
    messageId,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    headers: listUnsubscribe ? { 'List-Unsubscribe': listUnsubscribe } : undefined,
  };
  const info = await transport().sendMail(msg);
  if (getSetting('mail_transport') === 'capture') captured.push({ ...msg, sentAt: new Date().toISOString() });
  // Build the raw message for the Sent folder copy.
  let raw = null;
  try {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    raw = (await stream.sendMail(msg)).message;
  } catch { /* optional */ }
  return { messageId: info.messageId || messageId, accepted: info.accepted || [to], rejected: info.rejected || [], raw };
}
