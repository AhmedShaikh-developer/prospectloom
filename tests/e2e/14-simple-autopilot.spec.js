import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, MOCK, SITE } from './helpers.js';

// The simplified flow: free local-business finder → automatic research (simple mode)
// → AI-written email with a quality gate → autopilot approval → paced sending.
test.describe.serial('Simple pipeline: local finder → research → autopilot', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', {
      pipeline_mode: 'simple', groq_api_key: 'groq-test', daily_send_limit: '200',
      send_days: '0,1,2,3,4,5,6', send_window_start: '0', send_window_end: '24', min_minutes_between_sends: '0', max_minutes_between_sends: '0', send_rounds: '1',
    });
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'good' } });
  });
  test.afterAll(async ({ request }) => {
    await api(request, 'PUT', '/settings', { pipeline_mode: 'strict', groq_api_key: '', autopilot_enabled: '0' });
  });

  test('finder lists businesses with their own website, skips social-only listings, imports with a sourced location', async ({ page, request }) => {
    await page.goto('/#/import');
    await expect(page.getByTestId('tab-local')).toHaveClass(/active/);
    await page.getByTestId('finder-category').selectOption({ label: 'Cafés & coffee shops (Offer C)' });
    await page.getByTestId('finder-location').fill('Austin, TX');
    await page.getByTestId('finder-search').click();
    await expect(page.getByTestId('finder-count')).toHaveText('2 businesses with a website');
    await expect(page.getByText('2 skipped without their own website')).toBeVisible();
    await expect(page.getByTestId('finder-row').first()).toContainText('500 Congress Ave, Austin, TX 78701');
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain(`["amenity"="cafe"]["website"](30.1`);

    await page.locator('#fx-research').uncheck(); // real domains are not fetched in tests
    await page.getByTestId('finder-import').click();
    await expect(page.getByTestId('import-result')).toContainText('2 new');

    const c = (await api(request, 'GET', '/companies?search=sunrise-cafe.com')).rows[0];
    expect(c.lead_origin).toBe('openstreetmap');
    expect(c.offer).toBe('C');
    expect(c.industry).toBe('Cafés & coffee shops');
    expect(c.us_presence).toContain('500 Congress Ave');
    expect(c.us_presence_url).toBe('https://www.openstreetmap.org/node/101');

    // Searching again marks them as already in the list (no duplicates)
    await page.getByTestId('finder-search').click();
    await expect(page.getByTestId('finder-row').first()).toContainText('already in list');
    await expect(page.getByTestId('finder-import')).toContainText('Add 0 selected');
  });

  test('finder explains unknown places', async ({ request }) => {
    const r = await request.post('/api/finder/search', { data: { category: 'restaurants', location: 'Nowhereville' } });
    expect((await r.json()).error).toContain('Could not find');
  });

  test('simple mode: research finds the email and a sourced opener; READY without a decision-maker', async ({ page, request }) => {
    const c = (await api(request, 'GET', '/companies?search=sunrise-cafe.com')).rows[0];
    await api(request, 'PUT', `/companies/${c.id}`, { website: SITE.cafe });
    const v = await api(request, 'POST', `/companies/${c.id}/verify`);
    expect(v.after, v.log.join('\n')).toBe('READY');
    const after = (await api(request, 'GET', `/companies/${c.id}`)).company;
    expect(after.contact_email).toBe('hello@sunrise-cafe.com');
    expect(after.dm_name).toBeNull();
    expect(after.personalization).toMatch(/Barista|brunch/);
    expect(after.personalization_url).toContain(SITE.cafe);

    await page.goto(`/#/company/${c.id}`);
    await expect(page.getByTestId('checklist').locator('.checklist').first().locator('li')).toHaveCount(5);
    await expect(page.getByText('optional — without one, emails start “Hi there”')).toBeVisible();
    await expect(page.getByTestId('studio-angle')).toContainText('Restaurants we work with');
  });

  test('autopilot: AI writes each email, approves it, and the send tick delivers it', async ({ page, request }) => {
    await page.goto('/#/dashboard');
    const card = page.getByTestId('autopilot-card');
    await expect(card).toContainText('Off');
    await card.getByTestId('autopilot-run').click();
    await expect(page.getByTestId('autopilot-result')).toContainText('ready to send');

    const msgs = await api(request, 'GET', '/outreach/messages?status=approved');
    const m = msgs.find((x) => x.domain === 'sunrise-cafe.com');
    expect(m.body).toContain('AI-WRITTEN');
    expect(m.to_email).toBe('hello@sunrise-cafe.com');
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain('small business owner'); // B2C tone for Offer C

    // Autopilot off → the tick does not send; on → it sends (window/quota/spacing still apply)
    expect((await api(request, 'POST', '/test/send-tick')).skipped).toBe('auto-send disabled');
    await card.getByTestId('autopilot-toggle').click();
    await expectToast(page, 'Autopilot on');
    await expect(page.getByTestId('autopilot-card')).toContainText('On');
    let sent = false;
    for (let i = 0; i < 60 && !sent; i++) {
      const r = await api(request, 'POST', '/test/send-tick');
      if (r.skipped === 'nothing approved') break;
      sent = (await api(request, 'GET', '/test/captured')).some((x) => x.to === 'hello@sunrise-cafe.com');
    }
    expect(sent).toBe(true);
    const mail = (await api(request, 'GET', '/test/captured')).find((x) => x.to === 'hello@sunrise-cafe.com');
    expect(mail.text).toContain('AI-WRITTEN');
    expect(mail.text).toMatch(/unsubscribe/i);
    expect((await api(request, 'GET', '/companies?search=sunrise-cafe.com')).rows[0].status).toBe('SENT');
  });

  test('quality gate: a bad AI draft (placeholders, links, invented numbers) falls back to the template', async ({ request }) => {
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'bad' } });
    const r = await createReadyCompany(request, 'Gate Test Co');
    const run = await api(request, 'POST', '/autopilot/run');
    expect(run.aiRejected).toBeGreaterThanOrEqual(1);
    expect(run.notes.join(' ')).toContain('Gate Test Co: AI draft rejected');
    const m = (await api(request, 'GET', '/outreach/messages?status=approved,sent')).find((x) => x.company_id === r.id);
    expect(m.body).not.toContain('[Name]');
    expect(m.body).toContain('Saw that you launched'); // the verified opener from the template
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'good' } });
  });

  test('settings: autopilot, timezone, Groq and Offer C are editable', async ({ page }) => {
    await page.goto('/#/settings?tab=schedule');
    await expect(page.getByTestId('f-autopilot_enabled')).toBeChecked();
    await expect(page.getByTestId('f-send_timezone')).toHaveValue('America/New_York');
    await expect(page.getByTestId('f-pipeline_mode')).toHaveValue('simple');
    await page.getByTestId('settings-tab-offers').click();
    await expect(page.getByTestId('f-offer_c_name')).toHaveValue('Websites & Automation for Local Businesses');
    await page.getByTestId('settings-tab-ai').click();
    await expect(page.getByTestId('f-groq_model')).toHaveValue('openai/gpt-oss-120b');
  });
});
