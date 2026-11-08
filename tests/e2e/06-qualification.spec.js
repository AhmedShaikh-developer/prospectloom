import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast } from './helpers.js';

test.describe('Phase 6 — Qualification decision engine', () => {
  test.beforeAll(async ({ request }) => { await ensureCompliance(request); });

  test('fit score below 6 is excluded; 6–7 can still qualify', async ({ request }) => {
    const low = await createReadyCompany(request, 'Low Fit Co', { fit_score: 5 });
    expect(low.status).toBe('EXCLUDED');
    const mid = await createReadyCompany(request, 'Mid Fit Co', { fit_score: 6 });
    expect(mid.status).toBe('READY');
  });

  test('removing evidence demotes READY back to RESEARCHING', async ({ page, request }) => {
    const r = await createReadyCompany(request, 'Demote Me Co');
    await page.goto(`/#/company/${r.id}`);
    await page.getByTestId('f-personalization').fill('');
    await page.getByTestId('save-company').click();
    await expectToast(page, 'Saved — status Researching');
    await expect(page.getByTestId('check-personalization')).toHaveAttribute('data-ok', 'false');
  });

  test('do-not-contact is sticky: edits never promote it back', async ({ page, request }) => {
    const r = await createReadyCompany(request, 'Sticky DNC Co');
    await page.goto(`/#/company/${r.id}`);
    page.once('dialog', (d) => d.accept('Asked us by phone'));
    await page.getByTestId('mark-dnc').click();
    await expectToast(page, 'Marked do-not-contact');
    await api(request, 'PUT', `/companies/${r.id}`, { notes: 'edited later' });
    await api(request, 'POST', `/companies/${r.id}/verify`, { scan: false });
    expect((await api(request, 'GET', `/companies/${r.id}`)).company.status).toBe('DO_NOT_CONTACT');
    const unlock = await request.post(`/api/companies/${r.id}/status`, { data: { status: 'UNLOCK' } });
    expect(unlock.status()).toBe(400);
  });

  test('statuses cannot be forced to READY manually', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Force Ready', domain: 'forceready.com' });
    const res = await request.post(`/api/companies/${company.id}/status`, { data: { status: 'READY' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('computed by the decision engine');
  });

  test('companies list filters by status and shows the reason', async ({ page }) => {
    await page.goto('/#/companies');
    await page.getByTestId('filter-status').selectOption('EXCLUDED');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/status=EXCLUDED/);
    const rows = page.getByTestId('company-row');
    await expect(rows.getByTestId('badge').filter({ hasNotText: 'Excluded' })).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId('companies-table')).toContainText('below 6');
  });

  test('search + CSV export', async ({ page, request }) => {
    await page.goto('/#/companies');
    await page.getByTestId('search').fill('Mid Fit');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.getByTestId('company-row')).toHaveCount(1);
    const csv = await (await request.get('/api/companies/export.csv?search=Mid%20Fit')).text();
    expect(csv.split('\n')[0]).toContain('contact_email');
    expect(csv).toContain('mid-fit-co.com');
  });
});
