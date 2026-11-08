import { test, expect } from '@playwright/test';
import { api, expectToast } from './helpers.js';

// Every lead remembers its source platform; results (replies, interest, bounces) are compared per source.
test.describe.serial('Source attribution & performance', () => {
  test('report: emailed companies, replies and bounces are counted per source platform', async ({ request }) => {
    const r = await api(request, 'GET', '/performance');
    expect(r.overall.emailed).toBeGreaterThan(0);
    const hand = r.byPlatform.find((g) => g.key === 'Added by hand');
    expect(hand.emailed).toBeGreaterThan(0);
    expect(hand.replied).toBeGreaterThan(0); // replies from the reply-handling spec
    expect(hand.bounced).toBeGreaterThan(0);
    expect(hand.replyRate).toBe(Math.round((hand.replied / hand.emailed) * 1000) / 10);
    expect(r.byPlatform.find((g) => g.key === 'Map listings')).toBeTruthy(); // map-finder leads
    expect(r.insights.length).toBeGreaterThan(0);
  });

  test('imported files can be labelled with the platform they came from', async ({ page, request }) => {
    await page.goto('/#/performance');
    await expect(page.locator('main h1')).toHaveText('Performance');
    await expect(page.getByTestId('perf-platforms')).toContainText('Added by hand');
    const files = page.getByTestId('perf-files');
    await expect(files).toContainText('Sample_Qualified_Leads.csv');
    await files.getByTestId('plat-select').first().selectOption('Clay');
    await expectToast(page, 'now count as Clay');
    const r = await api(request, 'GET', '/performance');
    expect(r.byPlatform.find((g) => g.key === 'Clay').leads).toBeGreaterThanOrEqual(4);
    const c = (await api(request, 'GET', '/companies?search=fixture-freight.com')).rows[0];
    expect(c.platform).toBe('Clay');
  });

  test('the sent log shows each email\'s source and what happened to it', async ({ page }) => {
    await page.goto('/#/outreach');
    const sent = page.getByTestId('sent-table');
    await expect(sent.locator('thead')).toContainText('Source');
    await expect(sent.locator('thead')).toContainText('Result');
    await expect(sent.getByTestId('sent-result').filter({ hasText: 'Replied' }).first()).toBeVisible();
    await expect(sent.getByTestId('sent-result').filter({ hasText: 'Bounced' }).first()).toBeVisible();
  });
});
