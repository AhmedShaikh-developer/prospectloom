import { test, expect } from '@playwright/test';
import { watchConsole } from './helpers.js';

// Premium shell: dark/light themes, a sidebar that stays put while scrolling, live charts.
test.describe('App shell, themes & charts', () => {
  test('theme toggle switches dark ↔ light and is remembered', async ({ page }) => {
    await page.goto('/#/dashboard');
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const first = await theme();
    expect(['dark', 'light']).toContain(first);
    await page.getByTestId('theme-toggle').click();
    const second = await theme();
    expect(second).not.toBe(first);
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect.poll(bodyBg).toBe(second === 'light' ? 'rgb(243, 241, 237)' : 'rgb(9, 9, 11)');
    await page.reload();
    expect(await theme()).toBe(second);
    expect(await bodyBg()).toBe(second === 'light' ? 'rgb(243, 241, 237)' : 'rgb(9, 9, 11)');
  });

  test('the sidebar stays in place when the page scrolls (no cropped panel)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('hero')).toBeVisible();
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, 1500);
    await page.waitForFunction(() => window.scrollY > 300);
    const box = await page.getByTestId('sidebar').boundingBox();
    expect(Math.round(box.y)).toBe(0);
    expect(Math.round(box.height)).toBe(700);
  });

  test('dashboard draws its charts with hover tooltips and no errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/#/dashboard');
    const hero = page.getByTestId('hero');
    await expect(hero.locator('svg path.line-mark')).toHaveCount(1);
    await expect(page.getByTestId('lead-sources').locator('.src').first()).toBeVisible();
    await expect(page.getByTestId('deliverability').locator('.chart svg')).toBeVisible();
    await expect(page.getByTestId('warmup-card').locator('svg path.line-mark')).toHaveCount(1);
    const svg = hero.locator('.chart svg');
    const b = await svg.boundingBox();
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2);
    await expect(hero.locator('.viz-tip')).toBeVisible();
    await expect(hero.locator('.viz-tip')).toContainText('New leads');
    // range switch re-draws
    await hero.locator('#range button', { hasText: '30D' }).click();
    await expect(hero).toContainText('last 30 days');
    expect(errors).toEqual([]);
  });

  test('the product has its own logo and name (no company branding)', async ({ page }) => {
    await page.goto('/#/dashboard');
    await expect(page.locator('#brand-mark')).toHaveAttribute('src', '/logo.svg');
    await expect(page.locator('#brand-name')).toHaveText('ProspectLoom');
    expect((await page.request.get('/logo.svg')).headers()['content-type']).toContain('svg');
  });
});
