import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, MOCK, SITE } from './helpers.js';

test.describe.serial('Email studio, research assistant & setup guide', () => {
  let acme;
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    acme = (await api(request, 'GET', '/companies?search=acme-freight.com')).rows[0];
    // Re-scan so the richer facts (case study, hiring, tech, phone) are captured.
    await api(request, 'POST', `/companies/${acme.id}/verify`);
  });

  test('research assistant shows free verification signals and one-click research links', async ({ page }) => {
    await page.goto(`/#/company/${acme.id}`);
    const sig = page.getByTestId('signals');
    await expect(sig).toContainText('US phone (512) 555-0142');
    await expect(sig).toContainText('Hiring (1)');
    await expect(sig).toContainText('LinkedIn page linked');
    await expect(sig).toContainText('SPF record');
    await expect(sig.locator('.tag', { hasText: 'HubSpot' })).toBeVisible();
    const links = page.getByTestId('research-links').locator('a');
    await expect(links).toHaveCount(8);
    await expect(links.first()).toHaveAttribute('href', /linkedin\.com\/search\/results\/people.*Acme%20Freight/);
    await expect(links.first()).toHaveAttribute('target', '_blank');
  });

  test('openers come only from facts on their site, each with a source', async ({ page }) => {
    await page.goto(`/#/company/${acme.id}`);
    const s = page.getByTestId('suggestion');
    await expect(s.filter({ hasText: 'Dedicated fleet for a regional grocery chain' })).toContainText(`${SITE.acme}/case-studies/grocery-fleet`);
    await expect(s.filter({ hasText: 'Dispatch Coordinator' })).toContainText('hiring');
    await expect(s.filter({ hasText: 'HubSpot' })).toBeVisible();
    await expect(page.getByTestId('studio-angle')).toContainText('carriers and 3PLs');
  });

  test('using a suggestion sets personalization + its source URL; company stays READY', async ({ page, request }) => {
    await page.goto(`/#/company/${acme.id}`);
    await page.getByTestId('suggestion').filter({ hasText: 'grocery chain' }).getByTestId('use-suggestion').click();
    await expectToast(page, 'Personalization set');
    await expect(page.getByTestId('f-personalization')).toHaveValue(/grocery chain/);
    await expect(page.getByTestId('f-personalization_url')).toHaveValue(`${SITE.acme}/case-studies/grocery-fleet`);
    await expect(page.getByTestId('suggestion').filter({ hasText: 'grocery chain' })).toHaveClass(/active/);
    expect((await api(request, 'GET', `/companies/${acme.id}`)).company.status).toBe('READY');
    // The draft preview uses the chosen opener and the industry angle
    await expect(page.getByTestId('studio-body')).toHaveValue(/grocery chain[\s\S]*carriers and 3PLs/);
  });

  test('hand-edited email is saved as a draft (still needs approval)', async ({ page, request }) => {
    await page.goto(`/#/company/${acme.id}`);
    await page.getByTestId('studio-subject').fill('Dispatch idea for Acme Freight');
    await page.getByTestId('studio-body').fill('Hi there,\n\nI was looking through your work and the grocery fleet project stood out.\n\nWorth a 20-minute call?\n\nAlex');
    await page.getByTestId('studio-save').click();
    await expectToast(page, 'Draft saved');
    await expect(page.getByTestId('studio-save')).toBeDisabled();
    await expect(page.getByTestId('draft-intro')).toHaveCount(0);
    const m = (await api(request, 'GET', '/outreach/messages?status=draft')).find((x) => x.company_id === acme.id);
    expect(m.subject).toBe('Dispatch idea for Acme Freight');
    expect(m.status).toBe('draft');
  });

  test('custom drafts are refused for non-READY companies and for leftover {{variables}}', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Not Ready Co', domain: 'notready-co.com' });
    const r1 = await request.post(`/api/companies/${company.id}/custom-draft`, { data: { subject: 'x', body: 'y' } });
    expect((await r1.json()).error).toContain('Only READY');
    const ready = await createReadyCompany(request, 'Var Leftover Co');
    const r2 = await request.post(`/api/companies/${ready.id}/custom-draft`, { data: { subject: 'Hi {{company}}', body: 'y' } });
    expect((await r2.json()).error).toContain('Unfilled');
  });

  test('AI writing is off without a Groq key and explains how to enable it', async ({ page, request }) => {
    const ready = await createReadyCompany(request, 'AI Off Co');
    const r = await request.post(`/api/companies/${ready.id}/ai-draft`);
    expect((await r.json()).error).toContain('Groq API key');
    await page.goto(`/#/company/${ready.id}`);
    await expect(page.getByTestId('studio-ai')).toHaveCount(0);
    await expect(page.getByText('Add a free Groq key to write with AI')).toBeVisible();
  });

  test('Groq AI drafts from verified facts only; human saves the draft', async ({ page, request }) => {
    await page.goto('/#/settings?tab=ai');
    await page.getByTestId('f-groq_api_key').fill('wrong-key');
    await page.getByTestId('save-settings').click();
    await expectToast(page, 'Settings saved');
    await page.getByTestId('test-ai').click();
    await expect(page.getByTestId('toast-error')).toContainText('rejected the API key');
    await page.getByTestId('f-groq_api_key').fill('groq-test');
    await page.getByTestId('save-settings').click();
    await expectToast(page, 'Settings saved');
    await page.getByTestId('test-ai').click();
    await expectToast(page, 'Groq OK');
    // The key is never sent back to the browser in full
    expect((await api(request, 'GET', '/settings')).groq_api_key).toBe('••••••••test');

    const ready = await createReadyCompany(request, 'AI Writer Co');
    await page.goto(`/#/company/${ready.id}`);
    await page.getByTestId('studio-ai').click();
    await expectToast(page, 'read it before saving');
    await expect(page.getByTestId('studio-subject')).toHaveValue('your booking page');
    await expect(page.getByTestId('studio-body')).toHaveValue(/AI-WRITTEN note/);
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain('VERIFIED FACTS');
    expect(lastPrompt).toContain('AI Writer Co');
    expect(lastPrompt).toContain('Do not invent');
    await page.getByTestId('studio-save').click();
    await expectToast(page, 'Draft saved');
    await api(request, 'PUT', '/settings', { groq_api_key: '' });
  });

  test('setup guide: every integration has steps; sending-domain check works', async ({ page }) => {
    await page.goto('/#/setup');
    await expect(page.locator('main h1')).toHaveText('Setup guide');
    for (const k of ['compliance', 'hostinger', 'ai', 'leads', 'autopilot', 'hubspot', 'apollo', 'clay']) await expect(page.getByTestId(`setup-${k}`).locator('.steps li').first()).toBeVisible();
    await expect(page.getByTestId('setup-hubspot')).toContainText('crm.objects.companies.write');
    await expect(page.getByTestId('setup-ai')).toContainText('console.groq.com/keys');
    await expect(page.getByTestId('setup-hostinger')).toContainText('smtp.hostinger.com');
    await page.getByTestId('sender-auth').click();
    await expect(page.getByTestId('sender-auth-res')).toContainText('SPF (Hostinger)');
    await expect(page.getByTestId('sender-auth-res')).toContainText('DMARC');
  });

  test('HubSpot: missing ll_* properties can be created from the app', async ({ page, request }) => {
    await request.post(`${MOCK}/__drop-prop`, { data: { name: 'll_last_sent_date' } });
    await page.goto('/#/hubspot');
    await page.getByTestId('hs-props').click();
    await expect(page.getByTestId('hs-prop-list')).toContainText('missing');
    await page.getByTestId('hs-create-props').click();
    await expectToast(page, 'Created 1 property');
    await expect(page.getByTestId('hs-prop-list').getByText('exists')).toHaveCount(7);
  });
});
