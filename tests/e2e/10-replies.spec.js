import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast } from './helpers.js';

/** Create a READY company, draft → approve → send its intro, return {company, message}. */
async function sentCompany(request, name) {
  const c = await createReadyCompany(request, name, { fit_score: 9 });
  const d = await api(request, 'POST', '/outreach/drafts', { companyIds: [c.id] });
  await api(request, 'POST', '/outreach/approve', { ids: d.ids });
  const s = await api(request, 'POST', `/outreach/send/${d.ids[0]}`);
  expect(s.ok, s.reason).toBe(true);
  const m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
  return { c, m };
}
const inbound = (request, msg) => api(request, 'POST', '/test/inbound', { date: new Date().toISOString(), headers: '', ...msg });

test.describe.serial('Phase 10 — Reply handling & sales pipeline', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { daily_send_limit: '50' });
  });

  test('positive reply → REPLIED, follow-up cancelled, opportunity created', async ({ page, request }) => {
    const one = (await api(request, 'GET', '/companies?search=outreach-one.com')).rows[0];
    const intro = (await api(request, 'GET', '/outreach/messages')).find((m) => m.company_id === one.id && m.kind === 'intro');
    const r = await inbound(request, { messageId: '<r1@acme>', from: `hello@${one.domain}`, subject: `Re: ${intro.subject}`, inReplyTo: intro.message_id, text: "Thanks Alex — sounds good, let's talk next week.\n\nOn Mon, Alex wrote:\n> old text" });
    expect(r.classification).toBe('positive');

    await page.goto('/#/replies');
    const row = page.getByTestId('reply-row').filter({ hasText: 'Outreach One' });
    await expect(row).toHaveAttribute('data-class', 'positive');
    await expect(row).not.toContainText('old text');
    await expect(page.getByTestId('pipeline').locator('[data-stage="qualified_conversation"]')).toContainText('Outreach One');

    const d = await api(request, 'GET', `/companies/${one.id}`);
    expect(d.company.status).toBe('REPLIED');
    expect(d.messages.find((m) => m.kind === 'follow_up').status).toBe('cancelled');
    // Duplicate delivery of the same message is ignored
    expect((await inbound(request, { messageId: '<r1@acme>', from: `hello@${one.domain}`, subject: 'x', text: 'x' })).duplicate).toBe(true);
  });

  test('opt-out reply → DO_NOT_CONTACT + permanent suppression', async ({ request }) => {
    const { c, m } = await sentCompany(request, 'Reply Optout Co');
    const r = await inbound(request, { messageId: '<r2@x>', from: m.to_email, subject: `Re: ${m.subject}`, inReplyTo: m.message_id, text: 'Please remove me from your list.' });
    expect(r.classification).toBe('opt_out');
    expect((await api(request, 'GET', `/companies/${c.id}`)).company.status).toBe('DO_NOT_CONTACT');
    expect((await api(request, 'GET', `/suppressions?search=${m.to_email}`)).some((s) => s.reason === 'opt_out')).toBe(true);
  });

  test('bounce → BOUNCED, message marked bounced, address suppressed', async ({ request }) => {
    const { c, m } = await sentCompany(request, 'Reply Bounce Co');
    const r = await inbound(request, { messageId: '<b1@x>', from: 'MAILER-DAEMON@hostinger.com', subject: 'Undelivered Mail Returned to Sender', text: `Reporting-MTA: dns; mx\nFinal-Recipient: rfc822; ${m.to_email}\nAction: failed\nStatus: 5.1.1` });
    expect(r.classification).toBe('bounce');
    const d = await api(request, 'GET', `/companies/${c.id}`);
    expect(d.company.status).toBe('BOUNCED');
    expect(d.messages[0].status).toBe('bounced');
    expect((await api(request, 'GET', `/suppressions?search=${m.to_email}`)).some((s) => s.reason === 'bounce')).toBe(true);
  });

  test('out-of-office auto-reply does not change status', async ({ request }) => {
    const { c, m } = await sentCompany(request, 'Reply OOO Co');
    const r = await inbound(request, { messageId: '<o1@x>', from: m.to_email, subject: 'Automatic reply: ' + m.subject, inReplyTo: m.message_id, text: 'I am out of the office until Monday.' });
    expect(r.classification).toBe('auto_reply');
    expect((await api(request, 'GET', `/companies/${c.id}`)).company.status).toBe('SENT');
  });

  test('negative reply stops further contact attempts', async ({ request }) => {
    const { c, m } = await sentCompany(request, 'Reply Negative Co');
    const r = await inbound(request, { messageId: '<n1@x>', from: m.to_email, subject: 'Re: hi', inReplyTo: m.message_id, text: "We're all set, not interested." });
    expect(r.classification).toBe('negative');
    expect((await api(request, 'GET', `/companies/${c.id}`)).company.status).toBe('REPLIED');
    await api(request, 'POST', `/test/age-message/${m.id}`, { days: 10 });
    const fu = await api(request, 'POST', '/outreach/followups');
    const msgs = (await api(request, 'GET', '/outreach/messages')).filter((x) => x.company_id === c.id && x.kind === 'follow_up');
    expect(msgs).toHaveLength(0);
    expect(fu).toBeTruthy();
  });

  test('neutral reply reclassified in the UI → opportunity; pipeline stage + revenue', async ({ page, request }) => {
    const { c, m } = await sentCompany(request, 'Reply Neutral Co');
    await inbound(request, { messageId: '<q1@x>', from: m.to_email, subject: 'Re: hi', inReplyTo: m.message_id, text: 'Who referred you to us?' });
    await page.goto('/#/replies');
    const row = page.getByTestId('reply-row').filter({ hasText: 'Reply Neutral Co' });
    await expect(row).toHaveAttribute('data-class', 'neutral');
    await row.locator('.recls').selectOption('positive');
    await expectToast(page, 'Reclassified');
    const opp = page.getByTestId('opp').filter({ hasText: 'Reply Neutral Co' });
    await expect(opp).toBeVisible();
    await opp.locator('.opp-value').fill('12000');
    await opp.locator('.opp-value').blur();
    await expectToast(page, 'Value saved');
    await page.getByTestId('opp').filter({ hasText: 'Reply Neutral Co' }).locator('.opp-stage').selectOption('won');
    await expectToast(page, 'Stage updated');
    await expect(page.getByTestId('pipeline').locator('[data-stage="won"]')).toContainText('Reply Neutral Co');
    const f = (await api(request, 'GET', '/dashboard')).funnel;
    expect(f.revenue).toBeGreaterThanOrEqual(12000);
    expect(f.won).toBeGreaterThanOrEqual(1);
    expect(c.id).toBeTruthy();
  });

  test('suggested response is drafted, never sent', async ({ page, request }) => {
    const before = (await api(request, 'GET', '/test/captured')).length;
    await page.goto('/#/replies');
    await page.getByTestId('reply-row').filter({ hasText: 'Outreach One' }).getByRole('button', { name: 'Suggested reply' }).click();
    await expect(page.getByTestId('suggested')).toHaveValue(/qualification call/);
    expect((await api(request, 'GET', '/test/captured')).length).toBe(before);
  });

  test('unmatched inbound mail is stored but changes nothing', async ({ request }) => {
    const r = await inbound(request, { messageId: '<u1@x>', from: 'random@unknown-sender.net', subject: 'Hello', text: 'Are you hiring?' });
    expect(r.matched).toBe(false);
    // Not related to anything you sent → filed as "other", not counted as waiting
    expect(r.classification).toBe('other');
    const sys = await inbound(request, { messageId: '<u2@x>', from: 'no-reply@mail.example-social.com', subject: '516678 is your code', text: 'Your code' });
    expect(sys.classification).toBe('other');
    const listed = await api(request, 'GET', '/replies');
    expect(listed.some((x) => x.from_email === 'random@unknown-sender.net')).toBe(false);
  });

  test('mailbox sync reports a clear error when IMAP is not configured', async ({ page }) => {
    await page.goto('/#/replies');
    await page.getByTestId('sync-mailbox').click();
    await expect(page.getByTestId('toast-error')).toContainText('IMAP is not configured');
  });
});
