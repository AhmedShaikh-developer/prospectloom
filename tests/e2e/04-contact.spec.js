import { test, expect } from '@playwright/test';
import { api, ensureCompliance, SITE, researchFacts, expectToast } from './helpers.js';

const check = async (request, id, key) => (await api(request, 'GET', `/companies/${id}`)).evaluation.clearance.find((c) => c.key === key);

test.describe('Phase 4 — Email & contact channel verification', () => {
  test.beforeAll(async ({ request }) => { await ensureCompliance(request); });

  test('partnership inbox on an agency site is preferred over billing@', async ({ request }) => {
    // pixelforge.co already exists (HubSpot import) → merged; point it at the mock site.
    const { company } = await api(request, 'POST', '/companies', { name: 'Pixel Forge', domain: 'pixelforge.co', offer: 'B' });
    await api(request, 'PUT', `/companies/${company.id}`, { website: SITE.pixel });
    const v = await api(request, 'POST', `/companies/${company.id}/verify`);
    const c = (await api(request, 'GET', `/companies/${company.id}`)).company;
    expect(c.contact_email).toBe('partnerships@pixelforge.co');
    expect(c.email_contact_type).toBe('partnership');
    expect(c.email_source_url).toBe(`${SITE.pixel}/partners`);
    expect(v.log.join(' ')).toContain('HubSpot: existing company 9002');
  });

  test('only support/privacy inboxes published → no email chosen, stays on hold', async ({ page, request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Northwind Wholesale', domain: 'northwind-wholesale.com', website: SITE.northwind, ...researchFacts() });
    await page.goto(`/#/company/${company.id}`);
    await page.getByTestId('verify').click();
    await expectToast(page, 'Checks done');
    await expect(page.getByTestId('f-contact_email')).toHaveValue('');
    await expect(page.getByTestId('scan-emails')).toContainText('privacy@northwind-wholesale.com');
    await expect(page.locator('[data-testid="status-reason"]')).toContainText('Hold');
  });

  test('email that is not on its stated source page is flagged', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', {
      name: 'Quiet Co', domain: 'quietco.com', website: SITE.quiet, ...researchFacts(),
      contact_email: 'hello@quietco.com', email_source_url: `${SITE.quiet}/contact`, email_evidence_type: 'official_website', email_contact_type: 'general', email_purpose: 'x',
    });
    await api(request, 'POST', `/companies/${company.id}/verify`, { scan: false });
    const c = await check(request, company.id, 'email_confirmed');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('NOT found');
    expect((await api(request, 'GET', `/companies/${company.id}`)).company.status).toBe('HOLD_VERIFY');
  });

  test('human attestation can confirm an obfuscated email', async ({ request }) => {
    const { rows } = await api(request, 'GET', '/companies?search=quietco.com');
    await api(request, 'PUT', `/companies/${rows[0].id}`, { email_manual_confirmed: 1 });
    await api(request, 'POST', `/companies/${rows[0].id}/verify`, { scan: false });
    expect((await check(request, rows[0].id, 'email_confirmed')).ok).toBe(true);
  });

  test('support@ entered manually is rejected for a vendor pitch', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Support Only', domain: 'supportonly.com', ...researchFacts(), contact_email: 'support@supportonly.com', email_source_url: 'https://supportonly.com/contact', email_evidence_type: 'official_website', email_manual_confirmed: 1 });
    const c = await check(request, company.id, 'email_role');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('not acceptable');
  });

  test('a guessed firstname@ address without a source is flagged', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Guess Co', domain: 'guessco.com', ...researchFacts({ dm_name: 'Priya Natarajan' }), contact_email: 'priya@guessco.com', email_evidence_type: 'pattern_guess' });
    expect((await check(request, company.id, 'email_not_guessed')).ok).toBe(false);
    expect((await check(request, company.id, 'email_evidence')).ok).toBe(false);
  });

  test('domain without MX records cannot become READY', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'No MX', domain: 'nomx-example.com', ...researchFacts(), contact_email: 'hello@nomx-example.com', email_source_url: 'https://nomx-example.com/c', email_evidence_type: 'official_website', email_contact_type: 'general', email_purpose: 'x', email_manual_confirmed: 1 });
    await api(request, 'POST', `/companies/${company.id}/verify`, { scan: false });
    const mx = await check(request, company.id, 'mx');
    expect(mx.ok).toBe(false);
    expect(mx.detail).toContain('No MX');
  });

  test('vendor application form → MANUAL APPLICATION (no substitute email)', async ({ page, request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Big Vendor Portal', domain: 'bigvendorportal.com', ...researchFacts() });
    await page.goto(`/#/company/${company.id}`);
    await page.getByTestId('f-manual_application_url').fill('https://bigvendorportal.com/supplier-registration');
    await page.getByTestId('save-company').click();
    await expectToast(page, 'Manual application');
  });

  test('robots.txt disallow is respected during scans', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Blocked Site', domain: 'blocked-site.com', website: SITE.blocked });
    const v = await api(request, 'POST', `/companies/${company.id}/verify`);
    expect(v.log.join(' ')).toContain('robots.txt');
    expect((await api(request, 'GET', `/companies/${company.id}`)).company.contact_email).toBeNull();
  });

  test('changing the email resets confirmation + MX until re-checked', async ({ request }) => {
    const { rows } = await api(request, 'GET', '/companies?search=pixelforge.co');
    const id = rows[0].id;
    await api(request, 'PUT', `/companies/${id}`, { contact_email: 'hello@pixelforge.co' });
    const c = (await api(request, 'GET', `/companies/${id}`)).company;
    expect(c.email_source_confirmed).toBeNull();
    expect(c.mx_valid).toBeNull();
    expect(c.dedup_checked_at).toBeNull();
  });
});
