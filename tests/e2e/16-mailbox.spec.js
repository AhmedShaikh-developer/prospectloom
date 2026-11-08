import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, COMPLIANCE } from './helpers.js';

// Hostinger mailbox: one login for sending + reading, a test email to yourself, and
// connection problems that pause sending instead of failing the approved queue.
test.describe.serial('Hostinger mailbox', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', {
      daily_send_limit: '200', send_days: '0,1,2,3,4,5,6', send_window_start: '0', send_window_end: '24', min_minutes_between_sends: '0', max_minutes_between_sends: '0', send_rounds: '1',
    });
  });
  test.afterAll(async ({ request }) => {
    await api(request, 'PUT', '/settings', { mail_transport: 'capture', smtp_host: '', smtp_port: '', smtp_user: '', smtp_pass: '', auto_send_enabled: '0' });
  });

  test('one email + password; Hostinger servers prefilled; test email goes to my own mailbox', async ({ page, request }) => {
    await page.goto('/#/settings?tab=integrations');
    const card = page.getByTestId('mailbox-card');
    await expect(card.getByTestId('f-smtp_user')).toHaveAttribute('placeholder', COMPLIANCE.sender_email);
    await expect(card.getByTestId('f-smtp_host')).toHaveValue('smtp.hostinger.com');
    await expect(card.getByTestId('f-smtp_port')).toHaveValue('465');
    await expect(card.getByTestId('f-imap_host')).toHaveValue('imap.hostinger.com');
    await expect(card.getByTestId('f-imap_port')).toHaveValue('993');
    await expect(page.getByTestId('mailbox-status')).toContainText('Test mode');

    await page.getByTestId('test-email').click();
    await expectToast(page, `Test email sent to ${COMPLIANCE.sender_email}`);
    await expect(page.getByTestId('mailbox-res')).toContainText('check your inbox');
    const cap = await api(request, 'GET', '/test/captured');
    const last = cap[cap.length - 1];
    expect(last.to).toBe(COMPLIANCE.sender_email);
    expect(last.subject).toBe('Test email from your lead pipeline');
  });

  test('a connection problem is explained in plain words, keeps the email approved and pauses sending', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Mailbox Pause Co', { fit_score: 9 });
    expect(c.status).toBe('READY');
    const d = await api(request, 'POST', '/outreach/drafts', { companyIds: [c.id] });
    await api(request, 'POST', '/outreach/approve', { ids: d.ids });

    // Real SMTP transport pointed at a closed local port
    await api(request, 'PUT', '/settings', { mail_transport: 'smtp', smtp_host: '127.0.0.1', smtp_port: '1', smtp_pass: 'not-the-password' });
    await page.goto('/#/settings?tab=integrations');
    await expect(page.getByTestId('f-smtp_port')).toHaveValue('1'); // custom port survives the form
    await page.getByTestId('test-mailbox').click();
    await expect(page.getByTestId('mailbox-res')).toContainText('Could not connect to 127.0.0.1:1');
    await expect(page.getByTestId('toast-error')).toContainText('587');

    const s = await api(request, 'POST', `/outreach/send/${d.ids[0]}`);
    expect(s.ok).toBe(false);
    expect(s.retry).toBe(true);
    expect(s.reason).toContain('stays approved');
    let m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
    expect(m.status).toBe('approved');
    expect((await api(request, 'GET', `/companies/${c.id}`)).company.status).toBe('READY');

    // The scheduler does not move on to the next email while the mailbox is failing
    await api(request, 'PUT', '/settings', { auto_send_enabled: '1' });
    expect((await api(request, 'POST', '/test/send-tick')).skipped).toBe('mailbox error');
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).toContainText('Last send failed: Could not connect');
    await page.goto('/#/settings?tab=integrations');
    await expect(page.getByTestId('mailbox-status')).toContainText('Last send failed');

    // Once the mailbox works again, the same email goes out and the warning clears
    await api(request, 'PUT', '/settings', { mail_transport: 'capture', smtp_host: '', smtp_port: '' });
    const ok = await api(request, 'POST', `/outreach/send/${d.ids[0]}`);
    expect(ok.ok, ok.reason).toBe(true);
    m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
    expect(m.status).toBe('sent');
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).not.toContainText('Last send failed');
    expect((await api(request, 'POST', '/test/send-tick')).skipped).not.toBe('mailbox error');
  });
});
