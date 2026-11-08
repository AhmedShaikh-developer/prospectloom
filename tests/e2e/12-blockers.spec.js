import { test, expect } from '@playwright/test';
import { api } from './helpers.js';

test.describe('Phase 12 — Continuous improvement & blockers', () => {
  test('stalled research is detected and linked', async ({ page, request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Stalled Research Co', domain: 'stalled-research.com' });
    for (let i = 0; i < 3; i++) await api(request, 'POST', `/companies/${company.id}/verify`);
    await page.goto('/#/dashboard');
    const b = page.getByTestId('blockers');
    await expect(b).toContainText('screened 3+ times without progress');
    await b.locator('.blocker', { hasText: 'without progress' }).getByRole('link', { name: 'Fix →' }).click();
    await expect(page.getByTestId('companies-table')).toContainText('Stalled Research Co');
  });

  test('blockers surface pending CRM writes, waiting replies and reserve shortfall', async ({ page }) => {
    await page.goto('/#/dashboard');
    const b = page.getByTestId('blockers');
    await expect(b).toContainText('awaiting approval');
    await expect(b).toContainText('waiting for you');
    await expect(b).toContainText('below the 14-day minimum');
    await expect(page.locator('#nav-replies')).not.toBeEmpty();
  });

  test('"what is holding companies back" ranks missing requirements', async ({ page, request }) => {
    const missing = await api(request, 'GET', '/insights/missing');
    expect(missing.length).toBeGreaterThan(0);
    for (let i = 1; i < missing.length; i++) expect(missing[i - 1].count).toBeGreaterThanOrEqual(missing[i].count);
    await page.goto('/#/dashboard');
    await expect(page.locator('.card', { hasText: "What's holding companies back" })).toContainText(missing[0].item);
  });

  test('integration status panel reflects configuration', async ({ page }) => {
    await page.goto('/#/dashboard');
    const card = page.locator('.card', { hasText: 'Integrations' });
    await expect(card.locator('tr', { hasText: 'HubSpot' })).toContainText('Connected');
    await expect(card.locator('tr', { hasText: 'Hostinger SMTP' })).toContainText('test capture mode');
    await expect(card.locator('tr', { hasText: 'Hostinger IMAP' })).toContainText('Not set up');
  });

  test('day by day: today, yesterday … 7 days ago and totals, in your own timezone', async ({ page, request }) => {
    const dd = await api(request, 'GET', '/insights/daily?days=30');
    await page.goto('/#/dashboard');
    const card = page.getByTestId('day-by-day');
    await expect(card.getByTestId('day-row')).toHaveCount(8);
    await expect(card.getByTestId('day-row').first()).toContainText('Today');
    await expect(card.getByTestId('day-row').nth(1)).toContainText('Yesterday');
    await expect(card.getByTestId('total-row')).toHaveCount(3);
    await expect(card.getByTestId('total-row').last()).toContainText('All time');
    await expect(page.getByTestId('kpi-sent')).toHaveText(String(dd.days[0].sent));
    expect(dd.allTime.sent).toBeGreaterThanOrEqual(dd.last7.sent);
    await page.goto('/#/settings?tab=schedule');
    await expect(page.getByTestId('f-report_timezone')).toBeVisible();
  });
});
