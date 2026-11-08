// Phase 5/10: Hostinger IMAP — read Sent (dedup history) and INBOX (replies/bounces).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSetting } from '../lib/settings.js';
import { mailboxUser, mailboxPass, friendlyMailError } from './mailer.js';

// Same Hostinger login as SMTP unless a separate IMAP login is entered.
const imapUser = () => getSetting('imap_user') || mailboxUser();
const imapPass = () => getSetting('imap_pass') || mailboxPass();

export function isConfigured() {
  return !!(getSetting('imap_host') && imapUser() && imapPass()) && getSetting('mail_transport') !== 'capture';
}

function client() {
  return new ImapFlow({
    host: getSetting('imap_host'),
    port: Number(getSetting('imap_port') || 993),
    secure: true,
    auth: { user: imapUser(), pass: imapPass() },
    logger: false,
  });
}

export async function testConnection() {
  if (!imapPass()) throw new Error('Enter the mailbox password first (Settings → Integrations → Hostinger mailbox), then save.');
  const c = client();
  try {
    await c.connect();
    const sent = await findSent(c);
    const boxes = await c.list();
    await c.logout();
    return { ok: true, sentFolder: sent, mailboxes: boxes.map((b) => b.path), detail: `Reading works — inbox and “${sent}” folder found` };
  } catch (e) {
    await c.logout().catch(() => {});
    throw new Error(friendlyMailError(e, 'IMAP'));
  }
}

async function findSent(c) {
  const boxes = await c.list();
  return boxes.find((b) => b.specialUse === '\\Sent')?.path || boxes.find((b) => /^(INBOX\.)?sent( items| messages)?$/i.test(b.path))?.path || 'Sent';
}

/**
 * Fetch messages with UID > sinceUid from a folder.
 * Returns [{ uid, messageId, inReplyTo, references, from, to[], subject, date, text, headers }]
 */
export async function fetchFolder(which, sinceUid = 0, { max = 500 } = {}) {
  const c = client();
  await c.connect();
  const out = [];
  let folder;
  try {
    folder = which === 'sent' ? await findSent(c) : 'INBOX';
    const lock = await c.getMailboxLock(folder);
    try {
      const range = `${Number(sinceUid) + 1}:*`;
      for await (const msg of c.fetch(range, { uid: true, envelope: true, source: which === 'inbox', headers: ['auto-submitted', 'x-autoreply', 'in-reply-to', 'references'] }, { uid: true })) {
        if (msg.uid <= sinceUid) continue;
        const env = msg.envelope || {};
        const item = {
          uid: msg.uid,
          folder,
          messageId: env.messageId,
          inReplyTo: env.inReplyTo,
          from: env.from?.[0]?.address?.toLowerCase(),
          to: (env.to || []).map((a) => a.address?.toLowerCase()).filter(Boolean),
          subject: env.subject || '',
          date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
          headers: msg.headers ? msg.headers.toString() : '',
          text: '',
        };
        if (msg.source) {
          const parsed = await simpleParser(msg.source);
          item.text = (parsed.text || '').slice(0, 20000);
          item.references = parsed.references;
          item.inReplyTo = item.inReplyTo || parsed.inReplyTo;
        }
        out.push(item);
        if (out.length >= max) break;
      }
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
  return { folder, messages: out };
}

/** Append a copy of a sent message to the Sent folder (Hostinger SMTP doesn't). */
export async function appendToSent(raw) {
  if (!raw || !isConfigured()) return false;
  const c = client();
  await c.connect();
  try {
    const folder = await findSent(c);
    await c.append(folder, raw, ['\\Seen']);
    return true;
  } finally { await c.logout().catch(() => {}); }
}
