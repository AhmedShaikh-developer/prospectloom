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
  const ok = { subject: 'quick idea for sunrise', body: `Hi there,\n\n${'I came across your brunch menu and wanted to share one idea about online bookings for busy weekends. '.repeat(2)}\n\nWould a short call be useful?\n\nAlex` };
  assert.deepEqual(validateDraft(ok), []);
  assert.ok(validateDraft({ ...ok, body: ok.body.replace('Hi there', 'Hi [Name]') }).length);
  assert.ok(validateDraft({ ...ok, body: ok.body + ' See https://x.com' }).length);
  assert.ok(validateDraft({ ...ok, body: ok.body.replace('useful?', 'useful!') }).length);
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

test('send plan: 10 emails in 2 rounds → 5 at window start + 5 in the afternoon; nothing before the first round', () => {
  setSetting('send_timezone', 'America/New_York');
  setSetting('daily_send_limit', '10'); setSetting('send_rounds', '2'); setSetting('send_window_start', '9'); setSetting('send_window_end', '17');
  setSetting('warmup_enabled', '0');
  const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 9, h + 5, m)); // Mon 9 Nov 2026, New York = UTC-5
  const p10 = ob.sendPlan(at(10));
  assert.deepEqual(p10.rounds.map((r) => r.count), [5, 5]);
  assert.equal(p10.rounds[0].at, '09:00');
  assert.ok(p10.rounds[1].atMin >= 13 * 60 && p10.rounds[1].atMin <= 13 * 60 + 40);
  assert.equal(p10.current, 1); assert.equal(p10.allowedNow, 5);
  assert.equal(ob.sendPlan(at(8)).current, 0);
  assert.equal(ob.sendPlan(at(14)).allowedNow, 10);
  assert.deepEqual(ob.sendPlan(at(10)).rounds, p10.rounds, 'stable within a day');
  setSetting('send_rounds', '3');
  assert.deepEqual(ob.sendPlan(at(10)).rounds.map((r) => r.count), [3, 3, 4]);
  setSetting('send_rounds', '2');
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
