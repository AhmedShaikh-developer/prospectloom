import { test, expect } from '@playwright/test';
import { api, expectToast } from './helpers.js';

test.describe.serial('Phase 11 — Reporting & quality assurance', () => {
  test('research batch from the UI produces an auditable report', async ({ page, request }) => {
    await api(request, 'PUT', '/settings', { research_batch_size: '8' });
    const queued = (await api(request, 'GET', '/research/next-batch')).ids;
    expect(queued.length).toBeGreaterThan(0);
    await page.goto('/#/research');
    await page.getByTestId('run-research').click();
    await expectToast(page, 'complete');
    const top = page.getByTestId('runs-table').locator('tbody tr').first();
    await expect(top).toContainText('research');
    for (const s of ['Selected', 'Screened', 'Fully researched', 'Newly READY', 'Still on hold', 'Duplicates found', 'Suppression conflicts', 'CRM writes attempted 0', 'Next batch']) {
      await expect(top).toContainText(s);
    }
    const run = (await api(request, 'GET', '/runs?kind=research'))[0];
    expect(run.stats.selected).toBe(Math.min(8, queued.length));
    expect(run.stats.screened + run.stats.errors).toBe(run.stats.selected);
    // Screened companies are not immediately re-queued (non-overlapping batches)
    const screenedIds = queued.slice(0, run.stats.selected);
    const next = (await api(request, 'GET', '/research/next-batch')).ids;
    expect(next.filter((id) => screenedIds.includes(id))).toEqual([]);
    expect(run.stats.nextBatch).toEqual(next.slice(0, 50).filter((id) => !screenedIds.includes(id)).slice(0, run.stats.nextBatch.length));
  });

  test('outstanding verification tasks are listed per company', async ({ page }) => {
    await page.goto('/#/research');
    const details = page.getByTestId('runs-table').locator('details').first();
    await details.locator('summary').click();
    await expect(details.locator('li').first()).toBeVisible();
  });

  test('daily summary contains reserve demand, shortfalls and blockers', async ({ page }) => {
    await page.goto('/#/research');
    const s = page.getByTestId('daily-summary');
    for (const t of ['Unique companies', 'Research-qualified', 'Verified unsent reserve', '14-day demand', '30-day demand', '60-day forecast', 'New READY today', 'HubSpot ops', 'Funnel', 'Blockers']) await expect(s).toContainText(t);
    await page.getByTestId('save-daily').click();
    await expectToast(page, 'Daily summary saved');
    await expect(page.getByTestId('runs-table').locator('tbody tr').first()).toContainText('daily_summary');
  });

  test('dashboard shows the latest research run', async ({ page }) => {
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('last-run')).toContainText('Research run #');
  });
});
