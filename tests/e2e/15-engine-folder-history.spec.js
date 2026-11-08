import { test, expect } from '@playwright/test';
import { api, ensureCompliance, expectToast, MOCK, SITE } from './helpers.js';

// Background jobs, the 24/7 lead engine, the watched leads folder (rich Clay-style CSVs),
// provider-email opt-in, and "already contacted" tracking.
test.describe.serial('Lead engine, leads folder & contact history', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { pipeline_mode: 'simple', leads_folder: 'tests/fixtures/leads csv', allow_provider_emails: '0' });
  });
  test.afterAll(async ({ request }) => {
    await request.post(`${MOCK}/__osm-delay`, { data: { ms: 0 } });
    await api(request, 'PUT', '/settings', { pipeline_mode: 'strict', engine_enabled: '0', allow_provider_emails: '0', leads_folder: 'leads csv' });
  });

  test('finder: empty city is explained inline; a whole country is refused with a clear message', async ({ page }) => {
    await page.goto('/#/import');
    await page.getByTestId('finder-location').fill('');
    await page.getByTestId('finder-search').click();
    await expect(page.getByTestId('finder-field-error')).toHaveText('Type a city first, e.g. Austin, TX');
    await page.getByTestId('finder-location').fill('United States');
    await page.getByTestId('finder-search').click();
    await expect(page.getByTestId('finder-error')).toContainText('whole country');
  });

  test('finder: a slow search keeps running in the background and is still there after switching pages', async ({ page, request }) => {
    await request.post(`${MOCK}/__osm-delay`, { data: { ms: 2500 } });
    await page.goto('/#/import');
    await page.getByTestId('finder-category').selectOption({ label: 'Restaurants (Offer C)' });
    await page.getByTestId('finder-location').fill('Austin, TX');
    await page.getByTestId('finder-search').click();
    await expect(page.getByTestId('finder-working')).toContainText('Finding Restaurants in Austin, TX');
    await expect(page.getByTestId('jobs-tray').getByTestId('job-running')).toContainText('Restaurants in Austin, TX');
    // Leave and come back: the running search (then its result) is still shown, and the form is remembered
    await page.goto('/#/companies');
    await page.goto('/#/import');
    await expect(page.getByTestId('finder-location')).toHaveValue('Austin, TX');
    await expect(page.getByTestId('finder-count')).toHaveText('2 businesses with a website', { timeout: 15000 });
    await expect(page.getByTestId('jobs-tray').getByTestId('job-running')).toHaveCount(0);
    await request.post(`${MOCK}/__osm-delay`, { data: { ms: 0 } });
  });

  test('lead engine: plan business types × cities, run a search, see progress and pacing', async ({ page, request }) => {
    const bad = await request.put('/api/engine', { data: { engine_enabled: '1', engine_categories: '', engine_locations: '' } });
    expect((await bad.json()).error).toContain('Choose at least one business type and one city');

    await page.goto('/#/engine');
    await expect(page.locator('main h1')).toHaveText('Lead engine');
    await page.getByTestId('engine-cat-restaurants').check();
    await page.getByTestId('engine-locations').fill('Austin, TX, USA');
    await page.getByTestId('preset-uae').click();
    await expect(page.getByTestId('engine-locations')).toHaveValue(/Dubai, United Arab Emirates/);
    await page.getByTestId('engine-locations').fill('Austin, TX, USA');
    await page.getByTestId('engine-save').click();
    await expectToast(page, 'Saved — 1 search planned');

    await page.getByTestId('engine-run-now').click();
    await expect.poll(async () => (await api(request, 'GET', '/engine')).imported, { timeout: 15000 }).toBe(2);
    const c = (await api(request, 'GET', '/companies?search=tacotown-atx.com')).rows[0];
    expect(c.lead_origin).toBe('openstreetmap');
    expect(c.offer).toBe('C');
    await page.goto('/#/engine');
    await expect(page.getByTestId('engine-searched')).toContainText('1 / 1');
    await expect(page.getByTestId('engine-recent')).toContainText('Restaurants in Austin, TX, USA');

    await page.getByTestId('engine-toggle').click();
    await expectToast(page, 'Lead engine started');
    await expect(page.locator('#nav-engine')).toHaveText('on');
    // Pacing: one search per (60 / searches-per-hour) minutes
    expect((await api(request, 'POST', '/test/engine-tick')).skipped).toBe('pacing');
    // A second forced run finds nothing new (no duplicates)
    const again = await api(request, 'POST', '/test/engine-tick', { force: true });
    expect(again.imported).toBe(0);
  });

  test('lead engine: when the daily limit is reached the page says so (and when it resumes)', async ({ page, request }) => {
    await api(request, 'PUT', '/engine', { engine_enabled: '1', engine_daily_cap: '1' });
    expect((await api(request, 'GET', '/engine')).paused.code).toBe('cap');
    await page.goto('/#/engine');
    await expect(page.getByTestId('engine-paused')).toContainText('Daily limit reached');
    await expect(page.getByTestId('engine-paused')).toContainText('continues automatically after midnight');
    await api(request, 'PUT', '/engine', { engine_daily_cap: '1500' });
    expect((await api(request, 'GET', '/engine')).paused?.code).not.toBe('cap'); // ("done" here: the only city was already searched)
    await api(request, 'PUT', '/engine', { engine_enabled: '0' });
  });

  test('leads folder: rich CSV columns are mapped; invalid emails dropped; generic inbox used when no decision-maker email', async ({ page, request }) => {
    await page.goto('/#/import?tab=folder');
    await expect(page.getByTestId('folder-row')).toHaveCount(1);
    await expect(page.getByTestId('folder-row')).toContainText('New');
    await page.getByTestId('folder-import').click();
    await expectToast(page, '1 file(s): 4 new companies');
    await expect(page.getByTestId('folder-row')).toContainText('Imported');

    const ff = (await api(request, 'GET', '/companies?search=fixture-freight.com')).rows[0];
    expect(ff.name).toBe('Fixture Freight');
    expect(ff.contact_email).toBe('nserrano@fixture-freight.com');
    expect(ff.email_contact_type).toBe('decision_maker');
    expect(ff.email_evidence_type).toBe('imported_list');
    expect(ff.dm_name).toBe('Nancy Serrano');
    expect(ff.fit_score).toBe(9);
    expect(ff.personalization).toContain('ordering & distribution workflow');
    expect(ff.personalization_url).toBe('https://fixture-freight.com/service/order-management/');
    expect(ff.notes).toContain('Phone: (214) 555-0199');
    expect(ff.lead_origin).toBe('csv: Sample_Qualified_Leads.csv');
    expect((await api(request, 'GET', '/companies?search=badmail-co.com')).rows[0].contact_email).toBeNull();
    const go = (await api(request, 'GET', '/companies?search=generic-only.com')).rows[0];
    expect(go.contact_email).toBe('hello@generic-only.com');
    expect(go.email_contact_type).toBe('general');
    // Unchanged files are not imported twice
    expect((await api(request, 'POST', '/import/folder', {})).summary).toBe('No new or changed files');
  });

  test('provider emails: blocked until allowed in Settings, then READY and greeted by first name', async ({ request }) => {
    const ff = (await api(request, 'GET', '/companies?search=fixture-freight.com')).rows[0];
    await api(request, 'PUT', `/companies/${ff.id}`, { website: SITE.acme }); // scan a local test site for the description
    let v = await api(request, 'POST', `/companies/${ff.id}/verify`);
    expect(v.after).toBe('HOLD_VERIFY');
    expect(v.evaluation.missing.join(' ')).toContain('turn on');
    await api(request, 'PUT', '/settings', { allow_provider_emails: '1' });
    v = await api(request, 'POST', `/companies/${ff.id}/verify`);
    expect(v.after, v.evaluation.missing.join('; ')).toBe('READY');
    expect(v.evaluation.warnings.join(' ')).toContain('mailbox itself is not validated');
    const st = await api(request, 'GET', `/companies/${ff.id}/studio`);
    expect(st.draft.body).toMatch(/^Hi Nancy,/);
    // An email on a different domain is never used, even when allowed
    const mm = (await api(request, 'GET', '/companies?search=mismatch-tile.com')).rows[0];
    const mv = await api(request, 'POST', `/companies/${mm.id}/verify`, { scan: false });
    expect(mv.after).not.toBe('READY');
  });

  test('already contacted: pasted history and the bulk action both mark companies as Sent', async ({ page, request }) => {
    await page.goto('/#/import?tab=history');
    await page.getByTestId('history-text').fill('Emailed via HeyReach: hello@generic-only.com');
    await page.getByTestId('history-import').click();
    await expectToast(page, '1 emails and 0 domains recorded — 1 companies marked as contacted');
    const go = (await api(request, 'GET', '/companies?search=generic-only.com')).rows[0];
    expect(go.status).toBe('SENT');

    await page.goto('/#/companies?search=mismatch-tile');
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('company-row').first().locator('.sel').check();
    await page.getByTestId('mark-contacted').click();
    await expectToast(page, '1 marked as already contacted');

    await page.goto('/#/companies?contacted=yes');
    await expect(page.getByTestId('company-chips').locator('.chip.active')).toHaveText('Contacted');
    const rows = page.getByTestId('company-row');
    await expect(rows.filter({ hasText: 'generic-only.com' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'mismatch-tile.com' })).toHaveCount(1);
    await page.goto('/#/companies?contacted=no');
    await expect(page.getByTestId('company-row').filter({ hasText: 'generic-only.com' })).toHaveCount(0);
  });
});
