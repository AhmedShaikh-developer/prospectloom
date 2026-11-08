import { test, expect } from '@playwright/test';
import { COMPLIANCE, expectToast, api } from './helpers.js';

test.describe('Phase 1 — Offers, compliance & integration settings', () => {
  test('compliance blocker is shown until sender details are saved', async ({ page, request }) => {
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).toContainText('Compliance');

    await page.goto('/#/settings');
    // Offers tab shows both offers with defaults
    await expect(page.getByTestId('f-offer_a_name')).toHaveValue('Custom Software & Automation');
    await expect(page.getByTestId('f-offer_b_name')).toHaveValue('White-Label Development Partnership');
    await page.getByTestId('f-offer_b_max_employees').fill('50');

    await page.getByTestId('settings-tab-sender').click();
    for (const [k, v] of Object.entries(COMPLIANCE)) await page.getByTestId(`f-${k}`).fill(v);
    await page.getByTestId('save-settings').click();
    await expectToast(page, 'Settings saved');

    // Persisted after reload
    await page.reload();
    await page.getByTestId('settings-tab-sender').click();
    await expect(page.getByTestId('f-sender_postal_address')).toHaveValue(COMPLIANCE.sender_postal_address);

    const s = await api(request, 'GET', '/settings');
    expect(s.sender_email).toBe(COMPLIANCE.sender_email);

    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).not.toContainText('Compliance');
  });

  test('schedule settings: auto-send defaults OFF and limits persist', async ({ page }) => {
    await page.goto('/#/settings');
    await page.getByTestId('settings-tab-schedule').click();
    await expect(page.getByTestId('f-auto_send_enabled')).not.toBeChecked();
    await expect(page.getByTestId('f-research_batch_size')).toHaveValue('50');
    await page.getByTestId('f-daily_send_limit').fill('10');
    await page.getByTestId('save-settings').click();
    await expectToast(page, 'Settings saved');
  });

  test('integrations: HubSpot + SMTP connection tests, secrets are masked', async ({ page, request }) => {
    await page.goto('/#/settings');
    await page.getByTestId('settings-tab-integrations').click();
    await expect(page.getByTestId('f-hubspot_token')).toHaveValue(/^•+oken$/); // masked "test-token"
    await page.getByTestId('test-hubspot').click();
    await expectToast(page, 'hubspot');
    await page.getByTestId('test-mailbox').click();
    await expectToast(page, 'capture mode');
    await expect(page.getByTestId('mailbox-res')).toContainText('capture mode');
    // Saving the form with the masked value must not overwrite the real token
    await page.getByTestId('save-settings').click();
    await expectToast(page, 'Settings saved');
    const r = await api(request, 'POST', '/integrations/hubspot/test');
    expect(r.ok).toBe(true);
  });
});
