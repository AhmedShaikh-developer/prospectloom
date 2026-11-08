// Background jobs: every long-running action (search, import, research, autopilot, mailbox sync)
// is recorded with live progress so the dashboard can show it from any page, and its result
// is kept so leaving a page never loses work.
import { q, nowIso } from '../db/index.js';

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export const jobOut = (r) => (r ? { ...r, params: parse(r.params), result: parse(r.result) } : null);

export function createJob(kind, label, params = {}) {
  return Number(q.run("INSERT INTO jobs (kind, label, params, status, started_at) VALUES (:kind, :label, :params, 'running', :now)",
    { kind, label, params: JSON.stringify(params), now: nowIso() }).lastInsertRowid);
}
export function progressJob(id, done, total, message) {
  q.run('UPDATE jobs SET done = :done, total = :total, message = COALESCE(:message, message) WHERE id = :id', { id, done, total, message: message ?? null });
}
export function finishJob(id, result, message) {
  q.run("UPDATE jobs SET status = 'done', finished_at = :now, result = :result, message = COALESCE(:message, message) WHERE id = :id",
    { id, now: nowIso(), result: JSON.stringify(result ?? null).slice(0, 2_000_000), message: message ?? result?.summary ?? null });
}
export function failJob(id, error) {
  q.run("UPDATE jobs SET status = 'failed', finished_at = :now, error = :error, message = :error WHERE id = :id", { id, now: nowIso(), error: String(error?.message || error) });
}
export function getJob(id) { return jobOut(q.get('SELECT * FROM jobs WHERE id = :id', { id })); }
export function runningJob(kind) { return jobOut(q.get("SELECT * FROM jobs WHERE kind = :kind AND status = 'running' ORDER BY id DESC LIMIT 1", { kind })); }

/** Run fn(ctx) as a tracked job. Returns { id, promise }. ctx.progress(done, total, message). */
export function runJob(kind, label, params, fn) {
  const id = createJob(kind, label, params);
  const ctx = { id, progress: (d, t, m) => progressJob(id, d, t, m) };
  const promise = Promise.resolve().then(() => fn(ctx)).then(
    (result) => { finishJob(id, result); return result; },
    (e) => { failJob(id, e); throw e; },
  );
  promise.catch(() => {});
  return { id, promise };
}

/** Same as runJob but waits for the result (for endpoints that answer synchronously). */
export async function trackJob(kind, label, params, fn) { return runJob(kind, label, params, fn).promise; }

export function listJobs({ active, kind, limit = 20, since } = {}) {
  const where = []; const p = { limit: Number(limit) || 20 };
  if (active) where.push("status = 'running'");
  if (kind) { where.push('kind = :kind'); p.kind = kind; }
  if (since) { where.push('id > :since'); p.since = Number(since); }
  return q.all(`SELECT id, kind, label, status, done, total, message, error, started_at, finished_at FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT :limit`, p);
}

/** Jobs cannot survive a restart: mark leftovers as interrupted. */
export function recoverJobs() {
  q.run("UPDATE jobs SET status = 'interrupted', finished_at = :now, message = 'Stopped when the app restarted' WHERE status = 'running'", { now: nowIso() });
  q.run("DELETE FROM jobs WHERE julianday('now') - julianday(started_at) > 14");
  q.run("UPDATE runs SET status = 'interrupted', finished_at = :now, report = COALESCE(report, 'Stopped when the app restarted') WHERE status = 'running'", { now: nowIso() });
}
