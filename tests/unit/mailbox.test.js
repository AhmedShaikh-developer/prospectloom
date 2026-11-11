import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `ll-unit-mailbox-${process.pid}.db`);
process.env.APP_MODE = 'test';
process.env.ENV_FILE = '/nonexistent';

const { mailErrorKind, retryMinutes, recordMailError, clearMailError, mailPause, reconnect } = await import('../../src/integrations/mailer.js');
const { catchUpUntil, sendPlan } = await import('../../src/services/outreach.js');
const { setSetting, getSetting } = await import('../../src/lib/settings.js');

test('mailbox errors: a dropped connection is retried soon, a wrong password or a sending limit gently', () => {
  assert.equal(mailErrorKind({ code: 'ETIMEDOUT' }), 'network');
  assert.equal(mailErrorKind({ code: 'ECONNECTION', message: 'Connection timeout' }), 'network');
  assert.equal(mailErrorKind({ code: 'EAUTH', responseCode: 535 }), 'auth');
  assert.equal(mailErrorKind({ responseCode: 451, response: '451 Ratelimit exceeded, try again later' }), 'limit');
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => retryMinutes('network', n)), [1, 2, 3, 5, 5]);
  assert.equal(retryMinutes('auth', 4), 30);
  assert.equal(retryMinutes('limit', 1), 20);
});

test('after a dropped connection the app tests the mailbox again by itself and carries on', async () => {
  setSetting('mail_transport', 'capture');
  clearMailError();
  assert.deepEqual(await reconnect(), { ok: true, skipped: 'no mailbox error' });

  const t0 = Date.now();
  recordMailError({ code: 'ETIMEDOUT', message: 'Connection timeout' });
  let mp = mailPause();
  assert.equal(mp.paused, true);
  assert.equal(mp.kind, 'network');
  assert.equal(mp.failures, 1);
  assert.ok(Math.abs(new Date(mp.until).getTime() - (t0 + 60_000)) < 5000, 'first test after about a minute');
  assert.match(mp.error, /Check your internet connection/);
  const since = mp.since;

  recordMailError({ code: 'ETIMEDOUT' });
  mp = mailPause();
  assert.equal(mp.failures, 2);
  assert.equal(mp.since, since, 'the outage start is kept');
  assert.ok(new Date(mp.until).getTime() - Date.now() > 100_000, 'second test after about two minutes');

  // still waiting: nothing is tested yet
  assert.ok((await reconnect()).waiting);
  // the wait is over and the connection works again (capture mode stands in for a working mailbox)
  setSetting('mail_paused_until', new Date(Date.now() - 1000).toISOString());
  const r = await reconnect();
  assert.equal(r.reconnected, true);
  mp = mailPause();
  assert.equal(mp.error, null);
  assert.equal(mp.paused, false);
  assert.equal(mp.failures, 0);
  assert.ok(getSetting('mail_last_recovered_at'));
});

test('catch-up: emails that missed their time still go out for 2 hours after the window', () => {
  setSetting('send_timezone', 'America/New_York');
  setSetting('send_days', '0,1,2,3,4,5,6');
  setSetting('send_window_start', '9');
  setSetting('send_window_end', '15');
  setSetting('send_catchup_minutes', '120');
  // 2026-11-11 is a Wednesday; New York is UTC-5 in November
  assert.equal(catchUpUntil(new Date('2026-11-11T19:30:00Z')), null, '14:30: still inside the window');
  assert.equal(catchUpUntil(new Date('2026-11-11T20:30:00Z')), 17 * 60, '15:30: catching up until 17:00');
  assert.equal(catchUpUntil(new Date('2026-11-11T22:05:00Z')), null, '17:05: catch-up is over');
  // after the window every one of the day's send times is due, so the missed ones are "behind"
  const plan = sendPlan(new Date('2026-11-11T20:30:00Z'));
  assert.equal(plan.due, plan.limit);
  assert.equal(plan.behind, plan.limit - plan.sent);
  setSetting('send_days', '1,2,3,4,5');
  assert.equal(catchUpUntil(new Date('2026-11-15T20:30:00Z')), null, 'not on a day you do not send');
  setSetting('send_days', '0,1,2,3,4,5,6');
  setSetting('send_catchup_minutes', '0');
  assert.equal(catchUpUntil(new Date('2026-11-11T20:30:00Z')), null, 'turned off');
});
