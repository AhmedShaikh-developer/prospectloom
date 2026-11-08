import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
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

const stmtCache = new Map();
function prep(sql) {
  let st = stmtCache.get(sql);
  if (!st) {
    st = getDb().prepare(sql);
    // Callers often pass one params object to several queries.
    if (typeof st.setAllowUnknownNamedParameters === 'function') st.setAllowUnknownNamedParameters(true);
    if (stmtCache.size > 500) stmtCache.clear();
    stmtCache.set(sql, st);
  }
  return st;
}

export const q = {
  all: (sql, params) => prep(sql).all(clean(params)),
  get: (sql, params) => prep(sql).get(clean(params)),
  run: (sql, params) => prep(sql).run(clean(params)),
  exec: (sql) => getDb().exec(sql),
};

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
  stmtCache.clear();
  if (db) { db.close(); db = undefined; }
}
