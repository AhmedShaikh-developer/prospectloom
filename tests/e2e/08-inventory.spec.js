import { test, expect } from '@playwright/test';
import { api, ensureCompliance } from './helpers.js';

test.describe('Phase 8 — Send-ready inventory management', () => {
  test.beforeAll(async ({ request }) => { await ensureCompliance(request); });

  test('dashboard counts match the database and only count eligible unsent READY', async ({ page, request }) => {
    const d = await api(request, 'GET', '/dashboard');
    const ready = await api(request, 'GET', '/companies?status=READY&limit=1000');
    expect(d.inventory.eligibleUnsent).toBe(ready.total);
    expect(d.inventory.total).toBe((await api(request, 'GET', '/companies?limit=1')).total);

    await page.goto('/#/dashboard');
    await expect(page.getByTestId('kpi-eligible')).toHaveText(String(d.inventory.eligibleUnsent));
    await expect(page.getByTestId('kpi-total')).toHaveText(String(d.inventory.total));
    await expect(page.getByTestId('inventory-breakdown')).toContainText('Ready');
  });

  test('reserve math follows the configured daily volume', async ({ page, request }) => {
    await api(request, 'PUT', '/settings', { daily_send_limit: '2' });
    const inv = (await api(request, 'GET', '/dashboard')).inventory;
    expect(inv.reserve14.demand).toBe(28);
    expect(inv.reserve30.demand).toBe(60);
    expect(inv.forecast60.demand).toBe(120);
    expect(inv.reserve14.shortfall).toBe(Math.max(0, 28 - inv.eligibleUnsent));
    expect(inv.reserveDays).toBeCloseTo(inv.eligibleUnsent / 2, 1);
    await page.goto('/#/dashboard');
    await expect(page.locator('.card', { hasText: 'Send reserve' })).toContainText('14-day reserve (28)');

    await api(request, 'PUT', '/settings', { daily_send_limit: '10' });
    const inv10 = (await api(request, 'GET', '/dashboard')).inventory;
    expect(inv10.reserve14.demand).toBe(140);
    expect(inv10.reserve30.demand).toBe(300);
    expect(inv10.forecast60.demand).toBe(600);
    expect(inv10.milestones.map((m) => m.target)).toEqual([30, 100, 140, 300, 600]);
  });

  test('status breakdown links open the filtered company list', async ({ page }) => {
    await page.goto('/#/dashboard');
    await page.getByTestId('inventory-breakdown').locator('a[href="#/companies?status=READY"]').click();
    await expect(page.getByTestId('filter-status')).toHaveValue('READY');
  });
});
