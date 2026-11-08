import { test, expect } from '@playwright/test';
import { api, expectToast } from './helpers.js';

const APOLLO_CSV = `First Name,Last Name,Title,Company,Website,Email,Email Status,Seniority,Industry,# Employees,City,State,Country,Person Linkedin Url,Apollo Account Id
Maria,Lopez,COO,Lakeside Distribution,https://www.lakeside-dist.com,maria@lakeside-dist.com,verified,c_suite,Wholesale,11-50,Denver,CO,United States,https://linkedin.com/in/maria,abc1
Sam,Ortiz,Owner,Ridge Recruiting,ridgerecruiting.com,,unavailable,owner,Staffing,45,Tampa,FL,United States,https://linkedin.com/in/sam,abc2`;

test.describe('Phase 2 — Lead discovery & import', () => {
  test('Apollo CSV: auto-detect, preview mapping, import, and re-import dedups', async ({ page, request }) => {
    await page.goto('/#/import?tab=csv');
    await page.getByTestId('csv-text').fill(APOLLO_CSV);
    await page.getByTestId('csv-preview').click();
    await expect(page.getByText('Detected source: apollo')).toBeVisible();
    await expect(page.getByTestId('mapping')).toContainText('contact_email');
    await page.getByTestId('csv-import').click();
    await expect(page.getByTestId('import-result')).toContainText('2 new');

    // Apollo emails are never treated as public-source confirmed
    const { rows } = await api(request, 'GET', '/companies?search=lakeside');
    expect(rows).toHaveLength(1);
    expect(rows[0].email_evidence_type).toBe('apollo_database');
    expect(rows[0].dm_verified).toBe(0);
    expect(rows[0].employee_count).toBe(50);
    expect(['RESEARCHING', 'HOLD_VERIFY']).toContain(rows[0].status);

    // Re-import: merged, no duplicates
    await page.getByTestId('csv-import').click();
    await expect(page.getByTestId('import-result')).toContainText('0 new, 2 existing');
    const again = await api(request, 'GET', '/companies?search=lakeside');
    expect(again.total).toBe(1);
  });

  test('pasted domains: normalized, in-file duplicates collapsed', async ({ page, request }) => {
    await page.goto('/#/import');
    await page.locator('#imp-tabs button[data-t="domains"]').click();
    await page.getByTestId('domains-text').fill('https://www.BlueHarbor-Agency.com/about\nblueharbor-agency.com\nnot_a_domain\nfoxglove-studio.io');
    await page.getByTestId('domains-import').click();
    await expect(page.getByTestId('import-result')).toContainText('2 new');
    await expect(page.getByTestId('import-result')).toContainText('1 duplicate rows in file');
    await expect(page.getByTestId('import-result')).toContainText('1 skipped');
    const { rows } = await api(request, 'GET', '/companies?search=blueharbor');
    expect(rows[0].domain).toBe('blueharbor-agency.com');
  });

  test('HubSpot import keeps prior outreach stages (never re-introduce)', async ({ page, request }) => {
    await page.goto('/#/import');
    await page.locator('#imp-tabs button[data-t="hubspot"]').click();
    await page.getByTestId('hubspot-import').click();
    await expectToast(page, 'Read 4');
    const sent = (await api(request, 'GET', '/companies?search=existing-crm.com')).rows[0];
    expect(sent.status).toBe('SENT');
    expect(sent.hubspot_id).toBe('9001');
    const dnc = (await api(request, 'GET', '/companies?search=optedout-inc.com')).rows[0];
    expect(dnc.status).toBe('DO_NOT_CONTACT');
  });

  test('Apollo API search is blocked by default (credit protection), works when enabled', async ({ page, request }) => {
    // Apollo is optional: its tab only appears once a key is saved.
    await page.goto('/#/import');
    await expect(page.locator('#imp-tabs button[data-t="apollo"]')).toHaveCount(0);
    await api(request, 'PUT', '/settings', { apollo_api_key: 'apollo-test' });
    await page.reload();
    await page.locator('#imp-tabs button[data-t="apollo"]').click();
    await expect(page.getByText('API search is disabled')).toBeVisible();
    await page.locator('#ap-search').click();
    await expect(page.getByTestId('toast-error')).toContainText('disabled');

    await api(request, 'PUT', '/settings', { apollo_api_search_enabled: '1' });
    await page.reload();
    await page.locator('#imp-tabs button[data-t="apollo"]').click();
    await page.locator('#ap-import').click();
    await expect(page.getByTestId('import-result')).toContainText('2 new');
    const r = (await api(request, 'GET', '/companies?search=harborlogistics')).rows[0];
    expect(r.contact_email).toBeNull(); // people search never yields emails
    expect(r.lead_origin).toBe('apollo');
    await api(request, 'PUT', '/settings', { apollo_api_search_enabled: '0' });
  });

  test('Clay webhook requires the shared secret', async ({ page, request }) => {
    await page.goto('/#/import');
    await page.locator('#imp-tabs button[data-t="clay"]').click();
    await expect(page.getByTestId('clay-url')).toContainText('/hooks/clay');
    await page.getByTestId('clay-generate').click();
    await expectToast(page, 'New secret generated');
    const secret = (await page.locator('#clay-secret').textContent()).trim();

    const bad = await request.post('/hooks/clay', { headers: { 'x-clay-secret': 'wrong' }, data: { Company: 'X', Domain: 'x.com' } });
    expect(bad.status()).toBe(401);
    const ok = await request.post('/hooks/clay', { headers: { 'x-clay-secret': secret }, data: { rows: [{ 'Company Name': 'Cedar Ops', 'Company Domain': 'cedarops.com', Industry: 'Manufacturing' }] } });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).created).toBe(1);
    const c = (await api(request, 'GET', '/companies?search=cedarops')).rows[0];
    expect(c.lead_origin).toBe('clay');
    expect(c.industry).toBe('Manufacturing');
  });

  test('manual add via UI merges into an existing domain instead of duplicating', async ({ page, request }) => {
    await page.goto('/#/companies');
    await page.getByTestId('add-company').click();
    await page.getByTestId('new-name').fill('Blue Harbor');
    await page.getByTestId('new-domain').fill('http://blueharbor-agency.com/contact');
    await page.getByTestId('save-new').click();
    await expectToast(page, 'merged');
    expect((await api(request, 'GET', '/companies?search=blueharbor')).total).toBe(1);
  });
});
