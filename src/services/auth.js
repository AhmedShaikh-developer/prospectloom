// Accounts, sessions and two-factor authentication (TOTP, RFC 6238).
// - Passwords: scrypt with a per-user salt. Sessions: random 32-byte tokens; only their SHA-256 is stored.
// - 2FA: authenticator-app codes (Google Authenticator, 1Password, Authy…) + one-time recovery codes.
// - Each account has its own workspace (its own leads, emails and settings). Signing up with the
//   primary workspace's owner email claims the existing data — after confirming a code sent to that mailbox.
import crypto from 'node:crypto';
import qrcode from 'qrcode-generator';
import { accounts as q, nowIso, withWorkspace } from '../db/index.js';
import { config } from '../config.js';
import * as workspaces from './workspaces.js';
import { sendMail } from '../integrations/mailer.js';
import { getSetting } from '../lib/settings.js';

const DAY = 86400_000;
export const COOKIE = 'pl_session';
let enabled = config.authEnabled;
export const isEnabled = () => enabled;
export const setEnabled = (v) => { enabled = !!v; }; // tests only

// ---------------------------------------------------------------- passwords
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored || '').split('$');
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters';
  if (!/[a-z]/i.test(s) || !/\d/.test(s)) return 'Use letters and at least one number';
  return null;
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------- TOTP
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 30) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  // allow one step of clock drift either way
  return [-1, 0, 1].some((w) => crypto.timingSafeEqual(Buffer.from(totp(secret, Date.now() + w * 30_000)), Buffer.from(c)));
}

// ---------------------------------------------------------------- brute-force protection
const attempts = new Map(); // key -> { n, until }
function tooMany(key) {
  const a = attempts.get(key);
  return a && a.until && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 60000) : 0;
}
function fail(key) {
  const a = attempts.get(key) || { n: 0 };
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 15 * 60_000; a.n = 0; }
  attempts.set(key, a);
}
const ok = (key) => attempts.delete(key);

// ---------------------------------------------------------------- users & sessions
export const userCount = () => q.get('SELECT COUNT(*) AS n FROM users').n;
export const signupsOpen = () => config.signupsOpen || userCount() === 0;
const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, twoFactor: !!u.totp_enabled, createdAt: u.created_at, workspaceId: u.workspace_id } : null);

function insertUser({ name, email, passwordHash, workspaceId }) {
  const r = q.run('INSERT INTO users (email, name, password_hash, workspace_id, role, created_at) VALUES (:e, :n, :h, :w, :role, :now)', {
    e: email, n: String(name || '').trim() || email.split('@')[0], h: passwordHash, w: workspaceId, role: 'owner', now: nowIso(),
  });
  const id = Number(r.lastInsertRowid);
  workspaces.setOwner(workspaceId, id);
  return publicUser(q.get('SELECT * FROM users WHERE id = :id', { id }));
}

const claims = new Map(); // ticket -> pending claim of the primary workspace

/**
 * New account. With the primary workspace's owner email (and the primary not yet claimed), the existing
 * data is claimed — but only after a 6-digit code sent to that mailbox is entered: { verify: true, ticket }.
 * Any other email gets a new, empty workspace: { user }.
 */
export async function signup({ name, email, password }) {
  const e = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if (q.get('SELECT id FROM users WHERE email = :e', { e })) throw new Error('An account with this email already exists — sign in instead');
  const main = workspaces.primary();
  if (!main.owner_user_id && e === workspaces.claimEmail()) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const ticket = crypto.randomBytes(24).toString('hex');
    claims.set(ticket, { name, email: e, passwordHash: hashPassword(password), codeHash: sha(code), until: Date.now() + 15 * 60_000, tries: 0 });
    let sent = false;
    try {
      await withWorkspace(workspaces.resolvePath(workspaces.PRIMARY), () => sendMail({
        from: `"ProspectLoom" <${getSetting('sender_email') || getSetting('smtp_user')}>`, to: e,
        subject: `Your ProspectLoom code: ${code}`,
        text: `Your code to open your existing ProspectLoom workspace is ${code}\n\nIt expires in 15 minutes. If you did not just sign up, ignore this email — nobody can open your data without this code.`,
        messageId: `<${crypto.randomUUID()}@prospectloom.local>`,
      }));
      sent = true;
    } catch { /* mailbox not set up yet: the code is in the server log instead */ }
    if (!sent) console.log(`[sign-up] code for ${e}: ${code} (mailbox not available, so it is shown here)`);
    return { verify: true, ticket, sentTo: e, viaEmail: sent };
  }
  if (!signupsOpen()) throw new Error('Sign-ups are closed on this server.');
  const ws = workspaces.create(`${String(name || '').trim() || e} workspace`);
  return { user: insertUser({ name, email: e, passwordHash: hashPassword(password), workspaceId: ws.id }) };
}

/** Step 2 of claiming the existing data: the code from the email. */
export function verifySignup({ ticket, code }) {
  const c = claims.get(ticket);
  if (!c || c.until < Date.now()) { claims.delete(ticket); throw new Error('This code has expired — sign up again to get a new one'); }
  if (c.tries >= 5) { claims.delete(ticket); throw new Error('Too many wrong codes — sign up again to get a new one'); }
  if (sha(String(code || '').trim()) !== c.codeHash) { c.tries++; throw new Error('That code is not right — check the email we sent'); }
  claims.delete(ticket);
  const main = workspaces.primary();
  if (main.owner_user_id) throw new Error('This workspace has already been claimed — sign in instead');
  if (q.get('SELECT id FROM users WHERE email = :e', { e: c.email })) throw new Error('An account with this email already exists — sign in instead');
  return { user: insertUser({ name: c.name, email: c.email, passwordHash: c.passwordHash, workspaceId: main.id }) };
}

/** Database file of a signed-in user's workspace. */
export function workspacePathOf(user) {
  return user?.workspaceId ? workspaces.pathOf(user.workspaceId) : null;
}

const pending = new Map(); // 2FA login tickets: ticket -> { userId, until }

/** Step 1: email + password. Returns { user } or { mfa: true, ticket } when 2FA is on. */
export function login({ email, password }, ip = '') {
  const e = normEmail(email);
  const key = `${ip}|${e}`;
  const wait = tooMany(key);
  if (wait) throw new Error(`Too many attempts — try again in ${wait} minute${wait === 1 ? '' : 's'}`);
  const u = q.get('SELECT * FROM users WHERE email = :e', { e });
  if (!u || !checkPassword(password, u.password_hash)) { fail(key); throw new Error('Wrong email or password'); }
  ok(key);
  if (u.totp_enabled) {
    const ticket = crypto.randomBytes(24).toString('hex');
    pending.set(ticket, { userId: u.id, until: Date.now() + 5 * 60_000 });
    return { mfa: true, ticket };
  }
  return { user: publicUser(u) };
}

/** Step 2: the 6-digit code (or a recovery code). */
export function loginSecondFactor({ ticket, code }, ip = '') {
  const p = pending.get(ticket);
  if (!p || p.until < Date.now()) { pending.delete(ticket); throw new Error('Sign-in expired — enter your password again'); }
  const key = `${ip}|2fa|${p.userId}`;
  const wait = tooMany(key);
  if (wait) throw new Error(`Too many attempts — try again in ${wait} minute${wait === 1 ? '' : 's'}`);
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: p.userId });
  const c = String(code || '').trim();
  let good = verifyTotp(u.totp_secret, c);
  if (!good && /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(c)) {
    // one-time recovery code
    const codes = JSON.parse(u.recovery_codes || '[]');
    const h = sha(c.toLowerCase().replace('-', ''));
    if (codes.includes(h)) {
      q.run('UPDATE users SET recovery_codes = :c WHERE id = :id', { c: JSON.stringify(codes.filter((x) => x !== h)), id: u.id });
      good = true;
    }
  }
  if (!good) { fail(key); throw new Error('That code is not right — check the time on your phone and try again'); }
  ok(key); pending.delete(ticket);
  return { user: publicUser(u) };
}

export function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (:h, :u, :now, :exp, :ip, :ua)', {
    h: sha(token), u: userId, now: nowIso(), exp: new Date(Date.now() + 30 * DAY).toISOString(), ip: req.ip || '', ua: String(req.get('user-agent') || '').slice(0, 200),
  });
  q.run('UPDATE users SET last_login_at = :now WHERE id = :id', { now: nowIso(), id: userId });
  return token;
}
export function sessionUser(token) {
  if (!token) return null;
  const row = q.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = :h AND s.expires_at > :now', { h: sha(token), now: nowIso() });
  return publicUser(row);
}
export function endSession(token) { if (token) q.run('DELETE FROM sessions WHERE id_hash = :h', { h: sha(token) }); }

export function cookieHeader(token, req, maxAgeDays = 30) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? maxAgeDays * 86400 : 0}${secure ? '; Secure' : ''}`;
}
export function readCookie(req) {
  const m = String(req.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- 2FA management
export function startTwoFactor(userId) {
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: userId });
  if (u.totp_enabled) throw new Error('Two-factor authentication is already on');
  const secret = base32Encode(crypto.randomBytes(20));
  q.run('UPDATE users SET totp_secret = :s WHERE id = :id', { s: secret, id: userId });
  const uri = `otpauth://totp/${encodeURIComponent(`ProspectLoom:${u.email}`)}?secret=${secret}&issuer=ProspectLoom&algorithm=SHA1&digits=6&period=30`;
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true }) };
}
export function enableTwoFactor(userId, code) {
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: userId });
  if (!u.totp_secret) throw new Error('Start the setup first');
  if (!verifyTotp(u.totp_secret, code)) throw new Error('That code is not right — scan the QR code again or check the time on your phone');
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').slice(0, 8).replace(/(.{4})/, '$1-'));
  q.run('UPDATE users SET totp_enabled = 1, recovery_codes = :c WHERE id = :id', { c: JSON.stringify(codes.map((x) => sha(x.replace('-', '')))), id: userId });
  return { recoveryCodes: codes };
}
export function disableTwoFactor(userId, { code, password }) {
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: userId });
  if (!checkPassword(password, u.password_hash) || !verifyTotp(u.totp_secret, code)) throw new Error('Enter your password and a current code to turn 2FA off');
  q.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = :id', { id: userId });
  return { ok: true };
}
export function changePassword(userId, { current, next }) {
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: userId });
  if (!checkPassword(current, u.password_hash)) throw new Error('Your current password is not right');
  const problem = passwordProblem(next);
  if (problem) throw new Error(problem);
  q.run('UPDATE users SET password_hash = :h WHERE id = :id', { h: hashPassword(next), id: userId });
  return { ok: true };
}
/** The account and its workspace, for the Security page. */
export function accountInfo(userId) {
  const u = q.get('SELECT * FROM users WHERE id = :id', { id: userId });
  const w = workspaces.byId(u.workspace_id);
  return { user: publicUser(u), workspace: w ? { id: w.id, name: w.name, primary: w.db_path === workspaces.PRIMARY, createdAt: w.created_at } : null };
}
