import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, MOCK } from './helpers.js';

const mockState = async (request) => (await request.get(`${MOCK}/__state`)).json();

test.describe.serial('Phase 7 — HubSpot CRM management', () => {
  let fresh;
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    fresh = await createReadyCompany(request, 'HS Fresh Co');
  });

  test('connection test + custom property check', async ({ page }) => {
    await page.goto('/#/hubspot');
    await page.getByTestId('hs-test').click();
    await expectToast(page, 'HubSpot connection OK');
    await page.getByTestId('hs-props').click();
    const list = page.getByTestId('hs-prop-list');
    await expect(list).toContainText('ll_outreach_stage');
    await expect(list.getByText('exists')).toHaveCount(7);
  });

  test('propose: reads HubSpot first, shows before → after diff, writes nothing', async ({ page, request }) => {
    const before = (await mockState(request)).companies.length;
    await page.goto('/#/hubspot');
    await page.getByTestId('hs-propose').click();
    await expectToast(page, 'proposed');
    const row = page.getByTestId('hs-op').filter({ hasText: 'HS Fresh Co' });
    await expect(row).toHaveAttribute('data-status', 'proposed');
    await expect(row).toContainText('create');
    await expect(row).toContainText('ll_outreach_stage');
    await expect(row).toContainText('READY');
    // Imported DNC record keeps HubSpot's own suppression reason (history preserved)
    const dncId = (await api(request, 'GET', '/companies?search=optedout-inc.com')).rows[0].id;
    const ops = await api(request, 'GET', '/hubspot/ops');
    expect(ops.find((o) => o.company_id === dncId)).toBeUndefined();
    const [again] = await api(request, 'POST', '/hubspot/propose', { ids: [dncId] });
    expect(again.skipped).toContain('up to date');
    const hs = (await mockState(request)).companies.find((c) => c.properties.domain === 'optedout-inc.com');
    expect(hs.properties.ll_suppression_reason).toBe('Asked not to be contacted');
    expect((await mockState(request)).companies.length).toBe(before);
  });

  test('executing without approval writes nothing', async ({ page, request }) => {
    await page.goto('/#/hubspot');
    await page.getByTestId('hs-execute').click();
    await expectToast(page, 'Attempted 0');
    expect((await mockState(request)).companies.some((c) => c.properties.domain === fresh.domain)).toBe(false);
  });

  test('approve → execute → confirmed only after re-read matches', async ({ page, request }) => {
    await page.goto('/#/hubspot');
    await page.getByTestId('hs-op').filter({ hasText: 'HS Fresh Co' }).locator('.osel').check();
    await page.getByTestId('hs-approve').click();
    await expectToast(page, '1 approved');
    await expect(page.getByTestId('hs-op').filter({ hasText: 'HS Fresh Co' })).toHaveAttribute('data-status', 'approved');
    await page.getByTestId('hs-execute').click();
    await expectToast(page, 'confirmed 1');
    await expect(page.getByTestId('hs-op').filter({ hasText: 'HS Fresh Co' })).toHaveAttribute('data-status', 'confirmed');

    const created = (await mockState(request)).companies.find((c) => c.properties.domain === fresh.domain);
    expect(created.properties.ll_outreach_stage).toBe('READY');
    expect(created.properties.ll_public_contact_email).toBe(`hello@${fresh.domain}`);
    expect(created.properties.ll_email_evidence_type).toBe('official_website');
    const local = (await api(request, 'GET', `/companies/${fresh.id}`)).company;
    expect(local.hubspot_id).toBe(created.id);
  });

  test('re-proposing an in-sync company is a no-op', async ({ request }) => {
    const r = await api(request, 'POST', '/hubspot/propose', { ids: [fresh.id] });
    expect(r[0].skipped).toContain('up to date');
  });

  test('create is blocked if the company appears in HubSpot before execution', async ({ request }) => {
    const race = await createReadyCompany(request, 'HS Race Co');
    const [p] = await api(request, 'POST', '/hubspot/propose', { ids: [race.id] });
    expect(p.operation).toBe('create');
    // Someone creates it in HubSpot meanwhile
    await request.post(`${MOCK}/crm/v3/objects/companies`, { headers: { authorization: 'Bearer test-token' }, data: { properties: { name: 'HS Race Co', domain: race.domain } } });
    await api(request, 'POST', '/hubspot/ops/status', { ids: [p.opId], status: 'approved' });
    const res = await api(request, 'POST', '/hubspot/execute');
    expect(res.blocked).toBe(1);
    const op = (await api(request, 'GET', '/hubspot/ops')).find((o) => o.id === p.opId);
    expect(op.status).toBe('blocked');
    expect(op.response.reason).toContain('already exists');
    expect((await mockState(request)).companies.filter((c) => c.properties.domain === race.domain)).toHaveLength(1);
  });

  test('discarding a proposal', async ({ page }) => {
    await page.goto('/#/hubspot');
    const first = page.getByTestId('hs-op').filter({ has: page.locator('.osel') }).first();
    await first.locator('.osel').check();
    await page.getByRole('button', { name: 'Discard selected' }).click();
    await expectToast(page, '1 discarded');
  });
});
