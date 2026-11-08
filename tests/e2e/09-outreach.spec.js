import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, COMPLIANCE } from './helpers.js';

const msgFor = async (request, companyId, kind = 'intro') => (await api(request, 'GET', '/outreach/messages')).find((m) => m.company_id === companyId && m.kind === kind && m.status !== 'cancelled');

test.describe.serial('Phase 9 — Hostinger outreach handoff', () => {
  const co = {};
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { daily_send_limit: '3' });
    // Clear any older drafts so the queue holds only this spec's messages.
    const old = (await api(request, 'GET', '/outreach/messages?status=draft,approved,blocked')).map((m) => m.id);
    if (old.length) await api(request, 'POST', '/outreach/cancel', { ids: old });
    for (const n of ['One', 'Two', 'Three']) co[n] = await createReadyCompany(request, `Outreach ${n}`, { fit_score: 10, dm_name: `Casey ${n}` });
  });

  test('generate today\'s drafts: top READY by fit, capped at the daily limit', async ({ page }) => {
    await page.goto('/#/outreach');
    await page.getByTestId('generate-drafts').click();
    await expectToast(page, '3 draft(s) created');
    const rows = page.getByTestId('msg-row');
    await expect(rows).toHaveCount(3);
    for (const n of ['One', 'Two', 'Three']) await expect(page.getByTestId('queue-table')).toContainText(`Outreach ${n}`);
    // Personalization from verified evidence is in the body; greeting falls back to "there" for a general inbox
    await expect(rows.first()).toContainText('Hi there');
    await expect(rows.first()).toContainText('dedicated-fleet service');
  });

  test('preview shows compliance footer; editing returns the message to draft', async ({ page, request }) => {
    const m = await msgFor(request, co.One.id);
    await page.goto('/#/outreach');
    await page.locator(`[data-testid="msg-row"][data-id="${m.id}"] .edit`).click();
    await expect(page.getByText('Passes all pre-send checks')).toBeVisible();
    await expect(page.locator('#modal')).toContainText(COMPLIANCE.sender_postal_address);
    await expect(page.locator('#modal')).toContainText('unsubscribe');
    await page.getByTestId('edit-subject').fill('Quick idea for Outreach One (edited)');
    await page.getByTestId('save-draft').click();
    await expectToast(page, 'Draft saved');
    await expect(page.getByTestId('queue-table')).toContainText('(edited)');
  });

  test('recipient cannot be changed on a draft', async ({ request }) => {
    const m = await msgFor(request, co.One.id);
    const r = await request.put(`/api/outreach/messages/${m.id}`, { data: { to_email: 'someone@else.com' } });
    expect(r.status()).toBe(400);
  });

  test('approve selected', async ({ page }) => {
    await page.goto('/#/outreach');
    await page.getByTestId('select-all-msgs').check();
    await page.getByTestId('approve-selected').click();
    await expectToast(page, '3 approved, 0 blocked');
    await expect(page.locator('[data-testid="msg-row"][data-status="approved"]')).toHaveCount(3);
    await expect(page.getByTestId('quota-approved')).toHaveText('3');
  });

  test('send now: delivered via SMTP transport with footer + List-Unsubscribe; company → SENT', async ({ page, request }) => {
    const m = await msgFor(request, co.One.id);
    await page.goto('/#/outreach');
    await page.locator(`[data-testid="msg-row"][data-id="${m.id}"]`).getByTestId('send-now').click();
    await expectToast(page, 'Sent ✓');
    await expect(page.getByTestId('sent-table')).toContainText('Outreach One');
    await expect(page.getByTestId('quota-sent')).toHaveText('1 / 3');

    const captured = await api(request, 'GET', '/test/captured');
    const mail = captured.find((x) => x.to === `hello@${co.One.domain}`);
    expect(mail.subject).toBe('Quick idea for Outreach One (edited)');
    expect(mail.from).toContain(COMPLIANCE.sender_email);
    expect(mail.text).toContain(COMPLIANCE.sender_postal_address);
    expect(mail.text).toContain('unsubscribe');
    expect(mail.headers['List-Unsubscribe']).toContain('mailto:');
    const c = (await api(request, 'GET', `/companies/${co.One.id}`)).company;
    expect(c.status).toBe('SENT');
    expect(c.last_sent_date).toBe(new Date().toISOString().slice(0, 10));
  });

  test('pre-send re-check blocks a recipient suppressed after approval', async ({ page, request }) => {
    const sup = await api(request, 'POST', '/suppressions', { value: `hello@${co.Two.domain}`, reason: 'other', note: 'test' });
    expect(sup.affected).toBeGreaterThan(0);
    const m = await msgFor(request, co.Two.id);
    await page.goto('/#/outreach');
    await page.locator(`[data-testid="msg-row"][data-id="${m.id}"]`).getByTestId('send-now').click();
    await expect(page.getByTestId('toast-error')).toContainText('suppressed');
    await expect(page.locator(`[data-testid="msg-row"][data-id="${m.id}"]`)).toHaveAttribute('data-status', 'blocked');
    const captured = await api(request, 'GET', '/test/captured');
    expect(captured.some((x) => x.to === `hello@${co.Two.domain}`)).toBe(false);
  });

  test('daily limit is enforced', async ({ request }) => {
    await api(request, 'PUT', '/settings', { daily_send_limit: '1' });
    const m = await msgFor(request, co.Three.id);
    const r = await api(request, 'POST', `/outreach/send/${m.id}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Daily limit reached');
    await api(request, 'PUT', '/settings', { daily_send_limit: '10' });
    expect((await api(request, 'POST', `/outreach/send/${m.id}`)).ok).toBe(true);
  });

  test('never a second introduction to the same company', async ({ request }) => {
    const r = await api(request, 'POST', '/outreach/drafts', { companyIds: [co.One.id, co.Three.id] });
    expect(r.created).toBe(0);
    const intros = (await api(request, 'GET', '/outreach/messages')).filter((m) => m.company_id === co.One.id && m.kind === 'intro');
    expect(intros).toHaveLength(1);
  });

  test('follow-up drafted in the same thread after N days without reply', async ({ page, request }) => {
    const intro = await msgFor(request, co.One.id);
    await api(request, 'POST', `/test/age-message/${intro.id}`, { days: 5 });
    await page.goto('/#/outreach');
    await page.getByTestId('generate-followups').click();
    await expectToast(page, 'follow-up draft');
    const fu = await msgFor(request, co.One.id, 'follow_up');
    expect(fu.subject).toBe(`Re: ${intro.subject}`);
    expect(fu.in_reply_to).toBe(intro.message_id);
    expect((await api(request, 'GET', `/companies/${co.One.id}`)).company.status).toBe('FOLLOW_UP');
    // Running it again does not create a duplicate follow-up
    expect((await api(request, 'POST', '/outreach/followups')).created).toBe(0);
  });

  test('unsubscribe link → do-not-contact + permanent opt-out', async ({ page, request }) => {
    const m = await msgFor(request, co.Three.id);
    await page.goto(`/u/${m.unsubscribe_token}`);
    await expect(page.getByRole('heading')).toHaveText("You're unsubscribed");
    const c = (await api(request, 'GET', `/companies/${co.Three.id}`)).company;
    expect(c.status).toBe('DO_NOT_CONTACT');
    const sup = await api(request, 'GET', `/suppressions?search=hello@${co.Three.domain}`);
    expect(sup.some((s) => s.reason === 'opt_out')).toBe(true);
  });

  test('draft intro from the company page', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Company Page Draft Co', { fit_score: 7 });
    await page.goto(`/#/company/${c.id}`);
    await page.getByTestId('draft-intro').click();
    await expectToast(page, 'Draft created');
    await expect(page.getByTestId('draft-intro')).toHaveCount(0);
  });
});
