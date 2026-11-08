import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers.js';

const PAGES = [
  ['dashboard', 'Pipeline dashboard'],
  ['companies', 'Companies'],
  ['import', 'Find leads'],
  ['research', 'Research runs & reports'],
  ['outreach', 'Outreach'],
  ['replies', 'Replies & pipeline'],
  ['hubspot', 'HubSpot sync'],
  ['suppression', 'Suppression list'],
  ['settings', 'Settings'],
];

test.describe('Navigation & shell', () => {
  test('every page renders from the sidebar without JS errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByText('TEST MODE')).toBeVisible();
    for (const [nav, heading] of PAGES) {
      await page.locator(`nav a[data-nav="${nav}"]`).click();
      await expect(page.locator('main h1')).toHaveText(heading);
      await expect(page.locator(`nav a[data-nav="${nav}"]`)).toHaveClass(/active/);
    }
    expect(errors).toEqual([]);
  });

  test('deep links and unknown routes', async ({ page }) => {
    await page.goto('/#/companies?status=READY');
    await expect(page.getByTestId('filter-status')).toHaveValue('READY');
    await page.goto('/#/company/999999');
    await expect(page.getByText('Company not found')).toBeVisible();
    await page.goto('/#/does-not-exist');
    await expect(page.locator('main h1')).toHaveText('Pipeline dashboard');
  });

  test('layout works at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('main h1')).toHaveText('Pipeline dashboard');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
