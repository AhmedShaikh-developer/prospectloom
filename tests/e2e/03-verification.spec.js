import { test, expect } from '@playwright/test';
import { api, ensureCompliance, SITE, expectToast } from './helpers.js';

test.describe('Phase 3 — Company verification', () => {
  test.beforeAll(async ({ request }) => { await ensureCompliance(request); });

  test('website scan fills only evidence-backed facts; human completes research → READY', async ({ page, request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Acme Freight', domain: 'acme-freight.com', website: SITE.acme, offer: 'A' });
    await page.goto(`/#/company/${company.id}`);
    await expect(page.getByTestId('company-name')).toHaveText('Acme Freight');
    await expect(page.locator('[data-testid="status-reason"]')).toContainText('Still needed:');

    // Automated checks: scan official site, confirm email, MX, HubSpot lookup, dedup
    await page.getByTestId('verify').click();
    await expectToast(page, 'Checks done');
    await expect(page.getByTestId('f-description')).toHaveValue(/regional LTL/);
    await expect(page.getByTestId('f-us_presence')).toHaveValue(/Austin, TX 78701/);
    await expect(page.getByTestId('f-us_presence_url')).toHaveValue(`${SITE.acme}/`);
    // Picks the general inbox, never support@
    await expect(page.getByTestId('f-contact_email')).toHaveValue('hello@acme-freight.com');
    await expect(page.getByTestId('f-email_source_url')).toHaveValue(`${SITE.acme}/contact`);
    await expect(page.getByTestId('f-email_evidence_type')).toHaveValue('official_website');
    await expect(page.getByTestId('scan-emails')).toContainText('support@acme-freight.com');
    await expect(page.getByTestId('check-email_confirmed')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('check-mx')).toHaveAttribute('data-ok', 'true');
    // Not READY: decision-maker, employees, personalization, fit are still human research
    await expect(page.getByTestId('check-decision_maker')).toHaveAttribute('data-ok', 'false');
    await expect(page.getByTestId('check-fit_score')).toHaveAttribute('data-ok', 'false');

    // Human research
    await page.getByTestId('f-industry').fill('Logistics / trucking');
    await page.getByTestId('f-employee_count').fill('85');
    await page.getByTestId('f-employee_count_url').fill(`${SITE.acme}/about`);
    await page.getByTestId('f-employee_count_date').fill('2026-11-05');
    await page.getByTestId('f-dm_name').fill('Dana Whitfield');
    await page.getByTestId('f-dm_title').fill('VP Operations');
    await page.getByTestId('f-dm_url').fill('https://www.linkedin.com/in/dana-whitfield');
    await page.getByTestId('f-portfolio_url').fill(`${SITE.acme}/about`);
    await page.getByTestId('f-personalization').fill('Noticed Acme Freight runs dedicated LTL routes across Texas and Oklahoma from Austin.');
    await page.getByTestId('f-personalization_url').fill(`${SITE.acme}/`);
    await page.getByTestId('f-fit_score').fill('8');
    await page.getByTestId('f-fit_rationale').fill('Multi-state dispatch; likely TMS/portal integration work');
    await page.getByTestId('save-company').click();
    // dm not yet human-confirmed → still RESEARCHING
    await expectToast(page, 'Saved — status Researching');
    await expect(page.getByTestId('check-decision_maker')).toHaveAttribute('data-ok', 'false');

    await page.getByTestId('f-dm_verified').check();
    await page.getByTestId('save-company').click();
    await expectToast(page, 'Saved — status Ready');
    await expect(page.locator('[data-testid="status-reason"]')).toContainText('All research, contact, dedup, suppression and compliance checks passed');
    const okFlags = await page.locator('[data-testid="checklist"] li').evaluateAll((els) => els.map((e) => e.dataset.ok));
    expect(okFlags.every((v) => v === 'true')).toBe(true);
  });

  test('every edit is recorded in the audit trail', async ({ page, request }) => {
    const { rows } = await api(request, 'GET', '/companies?search=acme-freight.com');
    await page.goto(`/#/company/${rows[0].id}`);
    await expect(page.locator('.card', { hasText: 'Activity log' })).toContainText('status_changed');
    await expect(page.locator('.card', { hasText: 'Activity log' })).toContainText('updated');
    await expect(page.locator('.card', { hasText: 'Activity log' })).toContainText('verified');
  });

  test('invalid source URLs never satisfy a check', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Bad Sources', domain: 'badsources.com', us_presence: 'Somewhere in USA', us_presence_url: 'javascript:alert(1)' });
    const d = await api(request, 'GET', `/companies/${company.id}`);
    expect(d.company.us_presence_url).toBeNull();
    expect(d.evaluation.research.find((r) => r.key === 'us_presence').ok).toBe(false);
  });

  test('changing the domain to one that exists is refused', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Dup Domain', domain: 'dupdomain-one.com' });
    const res = await request.put(`/api/companies/${company.id}`, { data: { domain: 'acme-freight.com' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('already belongs');
  });
});
