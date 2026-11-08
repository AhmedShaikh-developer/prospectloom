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

export async function verifyConnection() {
  if (getSetting('mail_transport') === 'capture') return { ok: true, detail: 'capture mode (test) — no real email is sent' };
  if (!mailboxPass()) throw new Error('Enter the mailbox password first (Settings → Integrations → Hostinger mailbox), then save.');
  try { await transport().verify(); } catch (e) { throw new Error(friendlyMailError(e, 'SMTP')); }
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

const PAUSE_MINUTES = 30;
export function recordMailError(e) {
  setSetting('mail_last_error', friendlyMailError(e, 'SMTP'));
  setSetting('mail_last_error_at', new Date().toISOString());
  setSetting('mail_paused_until', new Date(Date.now() + PAUSE_MINUTES * 60000).toISOString());
}
export function clearMailError() {
  if (!getSetting('mail_last_error') && !getSetting('mail_paused_until')) return;
  setSetting('mail_last_error', '');
  setSetting('mail_last_error_at', '');
  setSetting('mail_paused_until', '');
}
export function mailPause() {
  const until = getSetting('mail_paused_until');
  const error = getSetting('mail_last_error');
  return { paused: !!until && new Date(until).getTime() > Date.now(), until: until || null, error: error || null, at: getSetting('mail_last_error_at') || null };
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
