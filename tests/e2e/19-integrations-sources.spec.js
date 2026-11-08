import { test, expect } from '@playwright/test';
import { api, ensureCompliance, expectToast, MOCK, researchFacts } from './helpers.js';

// Integrations hub + credit-aware lead sources: pull while credits last, wait when they run out,
// and continue by themselves when they renew.
test.describe.serial('Integrations hub & credit-aware lead sources', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { pipeline_mode: 'simple', allow_provider_emails: '1' });
    await request.post(`${MOCK}/__hunter`, { data: { left: 25 } });
    await request.post(`${MOCK}/__apollo-mode`, { data: { mode: 'ok' } });
  });
  test.afterAll(async ({ request }) => {
    await request.post(`${MOCK}/__apollo-mode`, { data: { mode: 'ok' } });
    await request.post(`${MOCK}/__hunter`, { data: { left: 25 } });
    await api(request, 'PUT', '/settings', {
      pipeline_mode: 'strict', allow_provider_emails: '0', hunter_api_key: '', source_hunter_enabled: '0', hunter_batch_per_run: '10',
      apollo_api_key: '', apollo_api_search_enabled: '0', engine_apollo_enabled: '0', engine_apollo_keywords: '',
    });
  });

  test('every tool has a card; Hunter connects with Save & test and shows its credits', async ({ page }) => {
    await page.goto('/#/integrations');
    await expect(page.locator('main h1')).toHaveText('Integrations');
    for (const id of ['groq', 'osm', 'apollo', 'hunter', 'hubspot', 'clay']) await expect(page.getByTestId(`int-${id}`)).toBeVisible();
    await expect(page.getByTestId('mailbox-card')).toBeVisible();
    const card = page.getByTestId('int-hunter');
    await expect(card).toContainText('Not connected');
    await card.getByTestId('f-hunter_api_key').fill('wrong-key');
    await card.getByTestId('test-hunter').click();
    await expect(page.getByTestId('toast-error')).toContainText('Hunter rejected the API key');
    await card.getByTestId('f-hunter_api_key').fill('hunter-test');
    await card.getByTestId('test-hunter').click();
    await expectToast(page, '25 of 25 searches left');
    await page.reload();
    await expect(page.getByTestId('int-hunter')).toContainText('25 of 25 left');
    await expect(page.getByTestId('int-hunter')).toContainText('Renews 2099-01-01');
  });

  test('Hunter finds the address a company published elsewhere — with its source page, never a guess — and the company becomes READY', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Hunted Co', domain: 'hunted-co.com', website: 'https://hunted-co.com', ...researchFacts({ dm_name: null, dm_title: null, dm_url: null, fit_score: 10 }) });
    const v = await api(request, 'POST', `/companies/${company.id}/verify`, { scan: false });
    expect(v.after).toBe('HOLD_VERIFY');
    await request.post(`${MOCK}/__hunter`, { data: { left: 200 } });
    await api(request, 'PUT', '/settings', { source_hunter_enabled: '1', hunter_batch_per_run: '200' });
    const r = await api(request, 'POST', '/sources/hunter/run');
    expect(r.found).toBeGreaterThanOrEqual(1);
    const c = (await api(request, 'GET', `/companies/${company.id}`)).company;
    expect(c.contact_email).toBe('riley@hunted-co.com'); // the source-less "guess@" address is never used
    expect(c.email_evidence_type).toBe('hunter_io');
    expect(c.email_source_url).toBe('https://press.example.org/riley-stone');
    expect(c.dm_name).toBe('Riley Stone');
    expect(c.status, c.status_reason).toBe('READY');
    // Each company is looked up once — the next run does not spend credits on it again
    const again = await api(request, 'POST', '/sources/hunter/run');
    expect(again.checked).toBe(0);
  });

  test('out of credits: Hunter waits until its renewal date, then continues by itself', async ({ page, request }) => {
    await request.post(`${MOCK}/__hunter`, { data: { left: 0 } });
    expect((await request.post('/api/sources/hunter/run')).ok()).toBe(false);
    let s = (await api(request, 'GET', '/sources')).find((x) => x.name === 'hunter');
    expect(s.status).toBe('waiting_credits');
    expect(s.resume_at.slice(0, 10)).toBe('2099-01-01');
    await page.goto('/#/integrations');
    await expect(page.getByTestId('int-hunter')).toContainText('Waiting for credits');
    await expect(page.getByTestId('int-hunter').getByTestId('src-msg')).toContainText('Out of credits');
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).toContainText('Hunter.io');
    // The scheduler leaves a waiting source alone…
    expect((await api(request, 'POST', '/test/sources-tick')).hunter).toBeUndefined();
    // …and once credits are back it runs again on its own
    await request.post(`${MOCK}/__hunter`, { data: { left: 25 } });
    s = await api(request, 'POST', '/sources/hunter/check');
    expect(s.status).toBe('ready');
    expect((await api(request, 'POST', '/test/sources-tick')).hunter).toBe('ran');
  });

  test('Apollo out of credits: every keyword × city waits with its page cursor and resumes when credits return', async ({ page, request }) => {
    await api(request, 'PUT', '/settings', { apollo_api_key: 'apollo-test', apollo_api_search_enabled: '1' });
    await api(request, 'PUT', '/engine', { engine_apollo_enabled: '1', engine_apollo_keywords: 'shopify agency', engine_categories: 'restaurants', engine_locations: 'Austin, TX, USA' });
    expect((await api(request, 'GET', '/engine')).apollo).toBe(true);
    await request.post(`${MOCK}/__apollo-mode`, { data: { mode: 'credits' } });
    let s = await api(request, 'POST', '/sources/apollo/check');
    expect(s.status).toBe('waiting_credits');
    expect((await api(request, 'GET', '/engine')).waiting).toBeGreaterThanOrEqual(1);
    await page.goto('/#/integrations');
    await expect(page.getByTestId('int-apollo')).toContainText('Waiting for credits');

    await request.post(`${MOCK}/__apollo-mode`, { data: { mode: 'ok' } });
    s = await api(request, 'POST', '/sources/apollo/check');
    expect(s.status).toBe('ready');
    expect((await api(request, 'GET', '/engine')).waiting).toBe(0);
  });

  test('changing a key re-checks the source right away', async ({ request }) => {
    await request.post(`${MOCK}/__hunter`, { data: { left: 0 } });
    await request.post('/api/sources/hunter/run');
    expect((await api(request, 'GET', '/sources')).find((x) => x.name === 'hunter').status).toBe('waiting_credits');
    await api(request, 'PUT', '/settings', { hunter_api_key: 'hunter-test-2' });
    expect((await api(request, 'GET', '/sources')).find((x) => x.name === 'hunter').status).toBe('idle');
    await api(request, 'PUT', '/settings', { hunter_api_key: 'hunter-test' });
  });
});
