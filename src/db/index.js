import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

// Every account has its own workspace = its own SQLite file. The workspace for the current request
// or background job travels with it (AsyncLocalStorage), so every query below automatically hits the
// right file. Without a workspace in context (sign-in off, scripts, tests) the primary database is used.
const context = new AsyncLocalStorage();
const conns = new Map(); // absolute path -> { db, stmts }

function open(file, schema = 'schema.sql') {
  const key = path.resolve(file);
  let c = conns.get(key);
  if (c) return c;
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const db = new DatabaseSync(key);
  db.exec(fs.readFileSync(new URL(`./${schema}`, import.meta.url), 'utf8'));
  if (schema === 'schema.sql') migrate(db);
  c = { db, stmts: new Map() };
  conns.set(key, c);
  return c;
}

/** The workspace database for the current request/job. */
export const currentDbPath = () => path.resolve(context.getStore()?.dbPath || config.dbPath);
export const isPrimaryWorkspace = () => currentDbPath() === path.resolve(config.dbPath);
/** Run fn (and everything it starts, sync or async) against one workspace. */
export const withWorkspace = (dbPath, fn) => context.run({ dbPath: path.resolve(dbPath) }, fn);

export function getDb() {
  return open(currentDbPath()).db;
}

// Add columns introduced after a database was first created.
const COLUMN_MIGRATIONS = {
  companies: { dm_verified: 'INTEGER NOT NULL DEFAULT 0', scan_facts: 'TEXT', mail_auth: 'TEXT', site_status: 'TEXT', next_screen_at: 'TEXT', hunter_checked_at: 'TEXT' },
};
function migrate(d) {
  for (const [table, cols] of Object.entries(COLUMN_MIGRATIONS)) {
    const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

// node:sqlite rejects `undefined`; convert to null and booleans to ints.
function clean(params) {
  if (params == null) return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

function prep(c, sql) {
  let st = c.stmts.get(sql);
  if (!st) {
    st = c.db.prepare(sql);
    // Callers often pass one params object to several queries.
    if (typeof st.setAllowUnknownNamedParameters === 'function') st.setAllowUnknownNamedParameters(true);
    if (c.stmts.size > 500) c.stmts.clear();
    c.stmts.set(sql, st);
  }
  return st;
}
const bind = (conn) => ({
  all: (sql, params) => prep(conn(), sql).all(clean(params)),
  get: (sql, params) => prep(conn(), sql).get(clean(params)),
  run: (sql, params) => prep(conn(), sql).run(clean(params)),
  exec: (sql) => conn().db.exec(sql),
});

/** Queries against the current workspace. */
export const q = bind(() => open(currentDbPath()));
/** Queries against the shared accounts database (users, sessions, workspaces). */
export const accounts = bind(() => open(config.accountsDbPath, 'accounts.sql'));

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function logActivity(companyId, action, detail, actor = 'user') {
  q.run(
    'INSERT INTO activity (company_id, actor, action, detail) VALUES (:company_id, :actor, :action, :detail)',
    { company_id: companyId ?? null, actor, action, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) },
  );
}

/** Close and forget the connection (tests use this to reset). */
export function closeDb() {
  for (const c of conns.values()) c.db.close();
  conns.clear();
}
