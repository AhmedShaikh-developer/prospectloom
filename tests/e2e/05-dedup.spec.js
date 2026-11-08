import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast } from './helpers.js';

const status = async (request, id) => (await api(request, 'GET', `/companies/${id}`)).company.status;

test.describe('Phase 5 — Deduplication & suppression', () => {
  test.beforeAll(async ({ request }) => { await ensureCompliance(request); });

  test('baseline: a fully evidenced company is READY', async ({ request }) => {
    const r = await createReadyCompany(request, 'Baseline Ready Co');
    expect(r.status).toBe('READY');
  });

  test('competitor domain suppression (UI) excludes the company', async ({ page, request }) => {
    const r = await createReadyCompany(request, 'Rival Devshop');
    await page.goto('/#/suppression');
    await page.getByTestId('sup-value').fill(r.domain);
    await page.getByTestId('sup-reason').selectOption('competitor');
    await page.getByTestId('sup-add').click();
    await expectToast(page, '1 added');
    await expect(page.getByTestId('sup-table')).toContainText(r.domain);
    expect(await status(request, r.id)).toBe('EXCLUDED');
  });

  test('opt-out email → DO_NOT_CONTACT and cannot be removed', async ({ page, request }) => {
    const r = await createReadyCompany(request, 'Opt Out Target');
    await api(request, 'POST', '/suppressions', { value: `hello@${r.domain}`, reason: 'opt_out' });
    expect(await status(request, r.id)).toBe('DO_NOT_CONTACT');
    await page.goto('/#/suppression');
    const row = page.getByTestId('sup-row').filter({ hasText: `hello@${r.domain}` });
    await expect(row).toContainText('permanent');
    await expect(row.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    const del = await request.delete(`/api/suppressions/${(await api(request, 'GET', `/suppressions?search=hello@${r.domain}`))[0].id}`);
    expect(del.status()).toBe(400);
  });

  test('non-permanent suppression can be removed and the company recovers', async ({ page, request }) => {
    const r = await createReadyCompany(request, 'Temp Hold Co');
    await api(request, 'POST', '/suppressions', { value: r.domain, reason: 'other', note: 'checking' });
    expect(await status(request, r.id)).toBe('HOLD_VERIFY');
    await page.goto('/#/suppression');
    await page.getByTestId('sup-row').filter({ hasText: r.domain }).getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Removed');
    await api(request, 'POST', `/companies/${r.id}/verify`, { scan: false });
    expect(await status(request, r.id)).toBe('READY');
  });

  test('Hostinger Sent-folder history blocks a new intro (→ SENT)', async ({ request }) => {
    const r = await createReadyCompany(request, 'Mailed Before Inc');
    await api(request, 'POST', '/test/mail-history', { email: `ceo@${r.domain}`, direction: 'out' });
    await api(request, 'POST', `/companies/${r.id}/verify`, { scan: false });
    expect(await status(request, r.id)).toBe('SENT');
  });

  test('existing inbound conversation blocks READY', async ({ request }) => {
    const r = await createReadyCompany(request, 'Talking Already Co');
    await api(request, 'POST', '/test/mail-history', { email: `owner@${r.domain}`, direction: 'in' });
    await api(request, 'POST', `/companies/${r.id}/verify`, { scan: false });
    const d = await api(request, 'GET', `/companies/${r.id}`);
    expect(d.company.status).toBe('HOLD_VERIFY');
    expect(d.evaluation.conflicts.map((c) => c.type)).toContain('existing_conversation');
  });

  test('same recipient on two company records is a conflict', async ({ page, request }) => {
    const a = await createReadyCompany(request, 'Shared Inbox A');
    const b = await createReadyCompany(request, 'Shared Inbox B', { contact_email: `hello@${a.domain}` });
    expect(b.status).toBe('HOLD_VERIFY');
    await page.goto(`/#/company/${b.id}`);
    await expect(page.getByTestId('conflicts')).toContainText('Same recipient already used');
  });

  test('HubSpot stage SENT on an imported company blocks a new introduction', async ({ request }) => {
    const { rows } = await api(request, 'GET', '/companies?search=existing-crm.com');
    const d = await api(request, 'GET', `/companies/${rows[0].id}`);
    expect(d.company.status).toBe('SENT');
    expect(d.evaluation.conflicts.some((c) => c.detail.includes('HubSpot ll_outreach_stage = SENT'))).toBe(true);
  });
});
