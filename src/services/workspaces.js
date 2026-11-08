// Workspaces: each account's leads, emails and settings live in their own SQLite file.
// The primary workspace is the original database (the server owner's existing data). It is claimed
// by signing up with its owner email (OWNER_EMAIL, or the sender email saved in it) and confirming
// a code sent to that mailbox. Every other sign-up gets a brand-new, empty workspace.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { accounts, withWorkspace, getDb, nowIso } from '../db/index.js';
import { config } from '../config.js';
import { getSetting } from '../lib/settings.js';

export const PRIMARY = '@primary';
const dataDir = () => path.dirname(path.resolve(config.dbPath));
export const resolvePath = (dbPath) => (dbPath === PRIMARY ? path.resolve(config.dbPath) : path.resolve(dataDir(), dbPath));

export function primary() {
  let w = accounts.get('SELECT * FROM workspaces WHERE db_path = :p', { p: PRIMARY });
  if (!w) {
    accounts.run('INSERT INTO workspaces (name, db_path, created_at) VALUES (:n, :p, :now)', { n: 'Main workspace', p: PRIMARY, now: nowIso() });
    w = accounts.get('SELECT * FROM workspaces WHERE db_path = :p', { p: PRIMARY });
  }
  return w;
}

export function create(name) {
  const rel = path.join('workspaces', `ws_${crypto.randomBytes(8).toString('hex')}.db`);
  const r = accounts.run('INSERT INTO workspaces (name, db_path, created_at) VALUES (:n, :p, :now)', { n: name || 'Workspace', p: rel, now: nowIso() });
  withWorkspace(resolvePath(rel), () => getDb()); // creates the file with the full schema
  return byId(Number(r.lastInsertRowid));
}

export const byId = (id) => accounts.get('SELECT * FROM workspaces WHERE id = :id', { id });
export function pathOf(workspaceId) {
  const w = byId(workspaceId);
  return w ? resolvePath(w.db_path) : null;
}
export function setOwner(workspaceId, userId) {
  accounts.run('UPDATE workspaces SET owner_user_id = :u WHERE id = :id', { u: userId, id: workspaceId });
}

/** Every workspace file the scheduler should look after (the primary always first). */
export function allPaths() {
  primary();
  return accounts.all('SELECT db_path FROM workspaces ORDER BY id').map((w) => resolvePath(w.db_path))
    .filter((p, i) => i === 0 || fs.existsSync(p));
}

/** The email that may claim the primary workspace's existing data. */
export function claimEmail() {
  const e = config.ownerEmail || withWorkspace(resolvePath(PRIMARY), () => getSetting('sender_email') || getSetting('smtp_user'));
  return String(e || '').trim().toLowerCase();
}
