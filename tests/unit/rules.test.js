import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `ll-unit-${process.pid}.db`);
process.env.APP_MODE = 'test';
process.env.ENV_FILE = '/nonexistent';

const { normalizeDomain, normalizeEmail, rootDomain } = await import('../../src/lib/normalize.js');
const { assessEmail, looksGuessed, extractEmails, preferenceScore } = await import('../../src/lib/emailRules.js');
const { evaluate } = await import('../../src/lib/qualification.js');
const { classify, latestText, extractBouncedRecipient } = await import('../../src/services/replies.js');
const { render } = await import('../../src/services/outreach.js');

test('normalizeDomain strips protocol, www, path, port, case', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Acme.com/about?x=1'), 'acme.com');
  assert.equal(normalizeDomain('www2.acme.co.uk:8080'), 'acme.co.uk');
  assert.equal(normalizeDomain('jane@Acme.com'), 'acme.com');
  assert.equal(normalizeDomain('not a domain'), '');
  assert.equal(rootDomain('mail.acme.co.uk'), 'acme.co.uk');
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail(' mailto:Hello@Acme.COM?subject=hi '), 'hello@acme.com');
  assert.equal(normalizeEmail('nope'), '');
});

test('assessEmail blocks support/privacy/billing inboxes and warns on sales@', () => {
  assert.equal(assessEmail('support@acme.com', 'acme.com').blocked, true);
  assert.equal(assessEmail('privacy@acme.com', 'acme.com').blocked, true);
  assert.equal(assessEmail('billing-team@acme.com', 'acme.com').blocked, true);
  assert.equal(assessEmail('no-reply@acme.com', 'acme.com').blocked, true);
  const s = assessEmail('sales@acme.com', 'acme.com');
  assert.equal(s.blocked, false); assert.ok(s.warnings.length);
  assert.equal(assessEmail('hello@acme.com', 'acme.com').ok, true);
  assert.ok(assessEmail('hello@other.com', 'acme.com').warnings[0].includes('differs'));
});

test('preferenceScore ranks partnerships@ over info@ and rejects off-domain', () => {
  assert.ok(preferenceScore('partnerships@acme.com', 'acme.com') > preferenceScore('info@acme.com', 'acme.com'));
  assert.equal(preferenceScore('support@acme.com', 'acme.com'), -1);
  assert.equal(preferenceScore('hello@gmail.com', 'acme.com'), -1);
});

test('looksGuessed flags firstname@ patterns without a source', () => {
  assert.equal(looksGuessed('jane@acme.com', 'Jane Doe', ''), true);
  assert.equal(looksGuessed('jane.doe@acme.com', 'Jane Doe', ''), true);
  assert.equal(looksGuessed('jane@acme.com', 'Jane Doe', 'https://acme.com/team'), false);
  assert.equal(looksGuessed('hello@acme.com', 'Jane Doe', ''), false);
});

test('extractEmails de-obfuscates and drops asset filenames', () => {
  const e = extractEmails('write hello [at] acme [dot] com or team@acme.com logo@2x.png');
  assert.deepEqual(e.sort(), ['hello@acme.com', 'team@acme.com']);
});

const full = {
  id: 1, name: 'Acme', domain: 'acme.com', offer: 'A', lead_origin: 'manual', status: 'RESEARCHING',
  us_presence: 'HQ Austin TX', us_presence_url: 'https://acme.com', industry: 'Logistics', description: 'Carrier', profile_url: 'https://acme.com',
  employee_count: 80, employee_count_url: 'https://linkedin.com/company/acme', employee_count_date: '2026-11-01',
  dm_name: 'Jane Doe', dm_title: 'COO', dm_url: 'https://linkedin.com/in/jane', dm_verified: 1,
  portfolio_url: 'https://acme.com/services', personalization: 'Your new dedicated fleet service in Oklahoma caught my eye.', personalization_url: 'https://acme.com/news',
  fit_score: 8, fit_rationale: 'Ops-heavy', contact_email: 'hello@acme.com', email_source_url: 'https://acme.com/contact',
  email_evidence_type: 'official_website', email_contact_type: 'general', email_purpose: 'General inbox', email_checked_at: new Date().toISOString(),
  email_source_confirmed: 1, email_manual_confirmed: 0, mx_valid: 1, dedup_checked_at: new Date().toISOString(),
};
const okCtx = { conflicts: [], compliance: { ok: true, missing: [] } };

test('fully evidenced company is READY', () => {
  const r = evaluate(full, okCtx);
  assert.equal(r.status, 'READY', r.missing.join(', '));
});

test('missing research fact → RESEARCHING; missing clearance → HOLD_VERIFY', () => {
  assert.equal(evaluate({ ...full, dm_verified: 0 }, okCtx).status, 'RESEARCHING');
  assert.equal(evaluate({ ...full, personalization: 'too short' }, okCtx).status, 'RESEARCHING');
  assert.equal(evaluate({ ...full, mx_valid: 0 }, okCtx).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...full, email_source_confirmed: 0 }, okCtx).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...full, email_evidence_type: 'apollo_database' }, okCtx).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...full, contact_email: 'support@acme.com' }, okCtx).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...full, dedup_checked_at: null }, okCtx).status, 'HOLD_VERIFY');
  assert.equal(evaluate(full, { ...okCtx, compliance: { ok: false, missing: ['physical postal address'] } }).status, 'HOLD_VERIFY');
});

test('stale email verification blocks READY', () => {
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  assert.equal(evaluate({ ...full, email_checked_at: old }, okCtx).status, 'HOLD_VERIFY');
});

test('fit score < 6 → EXCLUDED; manual application → MANUAL_APPLICATION', () => {
  assert.equal(evaluate({ ...full, fit_score: 5 }, okCtx).status, 'EXCLUDED');
  assert.equal(evaluate({ ...full, contact_email: null, manual_application_url: 'https://acme.com/vendors' }, okCtx).status, 'MANUAL_APPLICATION');
});

test('opt-out conflict → DO_NOT_CONTACT, prior contact → SENT, contacted status preserved', () => {
  assert.equal(evaluate(full, { ...okCtx, conflicts: [{ type: 'opt_out', hard: true, detail: 'x' }] }).status, 'DO_NOT_CONTACT');
  assert.equal(evaluate(full, { ...okCtx, conflicts: [{ type: 'previously_contacted', hard: true, detail: 'x' }] }).status, 'SENT');
  assert.equal(evaluate({ ...full, status: 'REPLIED' }, okCtx).status, 'REPLIED');
  assert.equal(evaluate({ ...full, status: 'DO_NOT_CONTACT', status_locked: 1 }, okCtx).status, 'DO_NOT_CONTACT');
});

test('reply classification', () => {
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Re: idea', text: "Sounds good — let's talk Tuesday?" }), 'positive');
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Re: idea', text: 'Not interested, thanks.' }), 'negative');
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Re: idea', text: 'Please remove me from your list' }), 'opt_out');
  assert.equal(classify({ from: 'jane@acme.com', subject: 'unsubscribe', text: '' }), 'opt_out');
  assert.equal(classify({ from: 'mailer-daemon@hostinger.com', subject: 'Undelivered Mail Returned to Sender', text: '' }), 'bounce');
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Automatic reply: idea', text: 'I am out of office' }), 'auto_reply');
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Re: idea', text: 'Who are you?' }), 'neutral');
  // Quoted history must not influence the result
  assert.equal(classify({ from: 'jane@acme.com', subject: 'Re: idea', text: 'Not interested.\n\nOn Mon, Bob wrote:\n> would love to tell you more, are you interested?' }), 'negative');
});

test('latestText strips quoted replies; bounce recipient extraction', () => {
  assert.equal(latestText('Yes please\n> old\nOn Mon, X wrote:\nquoted'), 'Yes please');
  assert.equal(extractBouncedRecipient('Final-Recipient: rfc822; jane@acme.com\nAction: failed'), 'jane@acme.com');
});

test('template render', () => {
  assert.equal(render('Hi {{first_name}} at {{ company }}', { first_name: 'Jane', company: 'Acme' }), 'Hi Jane at Acme');
});

const { suggestions } = await import('../../src/lib/personalization.js');
const { angleFor } = await import('../../src/lib/angles.js');

test('personalization suggestions quote site facts with sources', () => {
  const s = suggestions({
    name: 'Acme', offer: 'A', industry: 'Logistics',
    scan_facts: JSON.stringify({ caseStudies: [{ text: 'Grocery fleet rollout', url: 'https://acme.com/work/grocery' }], hiring: [{ text: 'Dispatch Coordinator', url: 'https://acme.com/careers' }], tech: [{ name: 'Shopify', url: 'https://acme.com/' }], headings: [] }),
  });
  assert.ok(s.every((x) => x.source_url && x.text));
  assert.ok(s.find((x) => x.kind === 'case_study').text.includes('Grocery fleet rollout'));
  assert.ok(s.find((x) => x.kind === 'hiring').text.includes('Dispatch Coordinator'));
  assert.ok(s.find((x) => x.kind === 'tech').text.includes('Shopify'));
  assert.deepEqual(suggestions({ name: 'X', scan_facts: null }), []);
});

test('industry angle picks by industry and offer, with a safe fallback', () => {
  assert.match(angleFor({ offer: 'A', industry: 'Freight & Logistics' }), /carriers and 3PLs/);
  assert.match(angleFor({ offer: 'B', industry: 'Shopify agency' }), /Shopify agencies/);
  assert.match(angleFor({ offer: 'A', industry: 'Something else' }), /one manual workflow/);
});

const { autoOffer } = await import('../../src/lib/offers.js');
const { validateDraft, zonedNow } = await import('../../src/services/outreach.js');

test('simple mode: no decision-maker or employee count needed; email checks still apply', () => {
  const lean = { ...full, dm_name: null, dm_title: null, dm_url: null, dm_verified: 0, employee_count: null, fit_score: null, fit_rationale: null, us_presence: null, us_presence_url: null, portfolio_url: null };
  const simple = { ...okCtx, settings: { mode: 'simple' } };
  assert.equal(evaluate(lean, simple).status, 'READY');
  assert.equal(evaluate(lean, okCtx).status, 'RESEARCHING'); // strict keeps the original rules
  assert.equal(evaluate({ ...lean, personalization: null }, simple).status, 'RESEARCHING');
  assert.equal(evaluate({ ...lean, email_source_confirmed: 0 }, simple).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...lean, contact_email: 'support@acme.com' }, simple).status, 'HOLD_VERIFY');
  assert.equal(evaluate({ ...lean, offer: 'C' }, simple).status, 'READY');
});

test('autoOffer: agencies → B, consumer-facing local businesses → C, others → A', () => {
  assert.equal(autoOffer({ industry: 'Digital marketing agency' }), 'B');
  assert.equal(autoOffer({ industry: 'Dentists' }), 'C');
  assert.equal(autoOffer({ description: 'A family restaurant in Austin' }), 'C');
  assert.equal(autoOffer({ industry: 'Freight & Logistics' }), 'A');
  assert.match(angleFor({ offer: 'C', industry: 'Hair & beauty salons' }), /Salons we work with/);
});

test('AI quality gate rejects placeholders, links, hype and invented numbers', () => {
  const ok = { subject: 'your brunch menu', body: 'Hi there,\n\nSaw the weekend brunch menu on your site. Looks like bookings still go through the phone.\n\nWe set up simple online booking for small local places, usually in a week or two, so weekends get a little calmer at the front.\n\nIs that something you have thought about, or not a priority right now?\n\nAlex' };
  assert.deepEqual(validateDraft(ok), []);
  assert.ok(validateDraft({ ...ok, body: ok.body.replace('Hi there', 'Hi [Name]') }).length);
  assert.ok(validateDraft({ ...ok, body: ok.body + ' See https://x.com' }).length);
  assert.ok(validateDraft({ ...ok, body: ok.body.replace('right now?', 'right now!') }).length);
  assert.ok(validateDraft({ ...ok, body: ok.body + ' We grew sales 40% for others.' }).length);
  assert.ok(validateDraft({ subject: 'x', body: 'Too short. Alex' }).length);
});

test('send window is computed in the recipients\' timezone', () => {
  const d = new Date('2026-11-09T14:30:00Z'); // Monday
  assert.deepEqual(zonedNow(d, 'America/New_York'), { day: 1, hour: 9 });
  assert.deepEqual(zonedNow(d, 'Asia/Karachi'), { day: 1, hour: 19 });
});

test('bounce guard pauses automatic sending above 5% bounces (min. 20 sent in 7 days)', async () => {
  const { q } = await import('../../src/db/index.js');
  const { setSetting } = await import('../../src/lib/settings.js');
  const { bounceGuard } = await import('../../src/services/outreach.js');
  const cid = Number(q.run("INSERT INTO companies (name, domain) VALUES ('Guard Co', 'guard-co.com')").lastInsertRowid);
  const add = (status) => q.run("INSERT INTO messages (company_id, kind, to_email, subject, body, status, sent_at) VALUES (:cid, 'intro', 'x@guard-co.com', 's', 'b', :status, datetime('now'))", { cid, status });
  for (let i = 0; i < 19; i++) add('sent');
  add('bounced');
  assert.equal(bounceGuard().paused, false); // 5% is not above 5%
  add('bounced'); add('bounced');
  assert.equal(bounceGuard().paused, true);
  setSetting('bounce_guard_enabled', '0');
  assert.equal(bounceGuard().paused, false);
});

test('simple mode: a description from your own imported research counts; an unsourced manual one does not', () => {
  const simple = { ...okCtx, settings: { mode: 'simple' } };
  const base = { ...full, profile_url: null };
  assert.equal(evaluate({ ...base, lead_origin: 'csv: My_Clay_Export.csv' }, simple).status, 'READY');
  assert.equal(evaluate({ ...base, lead_origin: 'manual' }, simple).status, 'RESEARCHING');
});

const mailer = await import('../../src/integrations/mailer.js');

test('mailbox errors: login/network/rate-limit problems pause sending; a rejected recipient does not', () => {
  assert.equal(mailer.isMailboxError({ code: 'EAUTH', responseCode: 535 }), true);
  assert.equal(mailer.isMailboxError({ code: 'ECONNECTION' }), true);
  assert.equal(mailer.isMailboxError({ code: 'ETIMEDOUT' }), true);
  assert.equal(mailer.isMailboxError({ responseCode: 421, response: '421 Too many messages, try again later' }), true);
  assert.equal(mailer.isMailboxError({ code: 'EENVELOPE', responseCode: 550, response: '550 5.1.1 User unknown' }), false);
});

test('mailbox errors are explained in plain words', () => {
  assert.match(mailer.friendlyMailError({ code: 'EAUTH', response: '535 5.7.8 Error: authentication failed' }), /rejected the email or password/);
  assert.match(mailer.friendlyMailError({ code: 'EAUTH' }), /not your hPanel login/);
  assert.match(mailer.friendlyMailError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND smtp.example' }), /Could not find the server/);
  assert.match(mailer.friendlyMailError({ code: 'ETIMEDOUT' }, 'SMTP'), /587/);
});

const ob = await import('../../src/services/outreach.js');
const { setSetting } = await import('../../src/lib/settings.js');

test('send times: random human-like gaps across the 6-hour window, stable for the day, different every day', () => {
  setSetting('send_timezone', 'America/New_York'); setSetting('warmup_enabled', '0'); setSetting('daily_send_limit', '10');
  setSetting('send_window_start', '9'); setSetting('send_window_end', '15'); setSetting('send_spread', '1');
  setSetting('min_minutes_between_sends', '2'); setSetting('max_minutes_between_sends', '20');
  const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 9, h + 5, m)); // Mon 9 Nov 2026, New York = UTC-5
  const p = ob.sendPlan(at(10));
  assert.equal(p.slots.length, 10);
  const mins = p.slots.map((x) => x.atMin);
  assert.ok(mins[0] >= 540 && mins[9] <= 900, 'inside 09:00–15:00');
  assert.ok(mins[9] >= 540 + 360 * 0.8, 'uses most of the window');
  const gaps = mins.slice(1).map((m, i) => m - mins[i]);
  assert.ok(gaps.every((g) => g >= 2), 'never closer than the shortest gap');
  assert.ok(Math.min(...gaps) < 20 && Math.max(...gaps) > 40, 'short bursts and longer breaks');
  assert.ok(Math.max(...gaps) <= 140, 'no break is absurdly long');
  assert.deepEqual(ob.sendPlan(at(12)).slots.map((x) => x.at), p.slots.map((x) => x.at), 'stable within a day');
  assert.notDeepEqual(ob.sendPlan(new Date(Date.UTC(2026, 10, 10, 15))).slots.map((x) => x.at), p.slots.map((x) => x.at), 'different every day');
  assert.equal(ob.sendPlan(at(8)).due, 0, 'nothing before the window');
  assert.equal(ob.sendPlan(at(15, 30)).due, 10);
  setSetting('daily_send_limit', '40');
  const p40 = ob.sendPlan(at(10));
  assert.equal(p40.slots.length, 40);
  assert.ok(p40.slots[39].atMin <= 900, '40 a day still fits the window');
  setSetting('send_spread', '0');
  assert.equal(ob.sendPlan(at(10)).due, 40, 'spread off: all due from the window start');
  setSetting('send_spread', '1'); setSetting('daily_send_limit', '10');
});

test('random gap stays within the configured range', () => {
  setSetting('min_minutes_between_sends', '6'); setSetting('max_minutes_between_sends', '14');
  for (let k = 0; k < 30; k++) { const g = ob.gapMinutes(k); assert.ok(g >= 6 && g <= 14, `gap ${g}`); }
});

test('warm-up: 10/day for 14 days, then +5 every 7 days up to 40', async () => {
  const { q } = await import('../../src/db/index.js');
  q.run('DELETE FROM messages'); // earlier tests leave bounces behind, which would (correctly) brake the ramp
  setSetting('warmup_enabled', '1'); setSetting('daily_send_limit', '10'); setSetting('warmup_hold_days', '14');
  setSetting('warmup_step', '5'); setSetting('warmup_every_days', '7'); setSetting('warmup_max', '40');
  setSetting('warmup_start_date', '2026-11-01');
  const on = (y, mo, d) => ob.warmupPlan(new Date(Date.UTC(y, mo - 1, d, 17)));
  assert.equal(on(2026, 11, 1).day, 1); assert.equal(on(2026, 11, 1).limit, 10);
  assert.equal(on(2026, 11, 14).limit, 10);
  assert.equal(on(2026, 11, 15).limit, 15); assert.equal(on(2026, 11, 14).nextLimit, 15);
  assert.equal(on(2026, 11, 22).limit, 20);
  assert.equal(on(2027, 1, 30).limit, 40); assert.equal(on(2027, 1, 30).nextLimit, null);
  assert.equal(on(2026, 11, 14).nextDate, '2026-11-15');
  setSetting('warmup_start_date', ''); setSetting('warmup_enabled', '0');
});

test('"today" follows the recipients\' timezone (a New York day spans two Pakistan dates)', () => {
  const start = ob.zonedDayStart(new Date('2026-11-10T03:30:00Z'), 'America/New_York'); // 22:30 NY on 9 Nov
  assert.equal(start.toISOString(), '2026-11-09T05:00:00.000Z');
});

const { plainText } = await import('../../src/integrations/ai.js');

test('quality gate: machine-sounding emails are rejected (flattery, AI words, dashes, copied pitch, salesy subject)', () => {
  const base = { subject: 'your dev work', body: 'Hi there,\n\nSaw the Linus Health project on your site.\n\nWe do the backend side for design studios, so your team can say yes to the bigger builds without hiring.\n\nDo you ever need extra hands on that side of things?\n\nAlex' };
  assert.deepEqual(validateDraft(base), []);
  const bad = (body) => validateDraft({ ...base, body });
  assert.match(bad(base.body.replace('Saw the', 'I was impressed by the')).join(' '), /machine-written \("impressed"\)/);
  assert.match(bad(base.body.replace('We do', 'We seamlessly do')).join(' '), /machine-written/);
  assert.match(bad(base.body.replace('Do you ever', 'Would a brief call to explore')).join(' '), /machine-written/);
  assert.match(bad(base.body.replace('site.', 'site — nice work.')).join(' '), /dashes/);
  assert.match(validateDraft({ ...base, subject: 'collaboration opportunity' }).join(' '), /salesy subject/);
  setSetting('offer_b_pitch', 'We act as a white-label engineering team for agencies: custom development, API integrations, backend and automation.');
  assert.match(validateDraft({ ...base, body: base.body.replace('We do the backend side for design studios', 'We act as a white-label engineering team for agencies: custom development') }, { offer: 'B' }).join(' '), /copies the offer description/);
  assert.deepEqual(validateDraft(base, { offer: 'B' }), []);
});

test('plainText removes typography that gives AI text away', () => {
  assert.equal(plainText('white‑label work — integrations, member areas'), 'white-label work, integrations, member areas');
  assert.equal(plainText('clients’ sites'), "clients' sites");
});

test('greeting by name only when the name fits the email address', () => {
  assert.equal(ob.nameFitsEmail('Kirk James', 'kirk@cinco.design'), true);
  assert.equal(ob.nameFitsEmail('Nancy Serrano', 'nserrano@fixture-freight.com'), true);
  assert.equal(ob.nameFitsEmail('Laurent Hainaut', 'laurent@forcemajeure.design'), true);
  assert.equal(ob.nameFitsEmail('José Núñez', 'jose.nunez@x.com'), true);
  assert.equal(ob.nameFitsEmail('Chelsea Douglass', 'mike.reynolds@innovatemap.com'), false);
  assert.equal(ob.nameFitsEmail('Chelsea Douglass', 'hello@innovatemap.com'), false);
});

test('lead engine: sources take turns (map listings ↔ Apollo); the daily limit pauses it with a plain reason', async () => {
  const { q } = await import('../../src/db/index.js');
  const eng = await import('../../src/services/engine.js');
  q.run('DELETE FROM engine_targets');
  for (const [src, cat] of [['osm', 'restaurants'], ['osm', 'dentists'], ['apollo', 'shopify agency'], ['apollo', 'logistics']]) {
    q.run("INSERT INTO engine_targets (source, category, location) VALUES (:s, :c, 'Austin, TX, USA')", { s: src, c: cat });
  }
  setSetting('engine_last_source', 'osm');
  assert.equal(eng.nextTarget().source, 'apollo');
  setSetting('engine_last_source', 'apollo');
  assert.equal(eng.nextTarget().source, 'osm');
  // a source with nothing due is skipped
  q.run("UPDATE engine_targets SET next_run_at = '2999-01-01T00:00:00Z' WHERE source = 'apollo'");
  setSetting('engine_last_source', 'osm');
  assert.equal(eng.nextTarget().source, 'osm');
  // nothing due anywhere → the engine says every search is done
  q.run("UPDATE engine_targets SET next_run_at = '2999-01-01T00:00:00Z'");
  setSetting('engine_enabled', '1');
  assert.equal(eng.nextTarget(), null);
  assert.equal(eng.pauseReason().code, 'done');
  setSetting('engine_enabled', '0');
  q.run('DELETE FROM engine_targets');
});
