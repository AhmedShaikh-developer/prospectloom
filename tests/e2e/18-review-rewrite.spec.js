import { test, expect } from '@playwright/test';
import { api, ensureCompliance, createReadyCompany, expectToast, COMPLIANCE, MOCK } from './helpers.js';

// Reading the full email, seeing exactly what arrives, rewriting it, and review-before-send mode.
test.describe.serial('Reading, rewriting and reviewing emails', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', { groq_api_key: 'groq-test', daily_send_limit: '200' });
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'good' } });
  });
  test.afterAll(async ({ request }) => {
    await api(request, 'PUT', '/settings', { groq_api_key: '', autopilot_review: '0', autopilot_enabled: '0' });
  });

  test('queue: open the full email, see exactly what arrives, and rewrite it', async ({ page, request }) => {
    const c = await createReadyCompany(request, 'Readable Mail Co', { fit_score: 9 });
    expect(c.status).toBe('READY');
    const d = await api(request, 'POST', '/outreach/drafts', { companyIds: [c.id] });
    await api(request, 'POST', '/outreach/approve', { ids: d.ids });

    await page.goto('/#/outreach');
    const row = page.getByTestId('msg-row').filter({ hasText: 'Readable Mail Co' });
    await expect(row.getByTestId('msg-body')).toHaveClass(/clamp/);
    await row.getByTestId('toggle-full').click();
    await expect(row.getByTestId('msg-body')).not.toHaveClass(/clamp/);
    await expect(row.getByTestId('toggle-full')).toHaveText('Show less ▴');

    await row.getByTestId('preview').click();
    const view = page.getByTestId('email-view');
    await expect(view).toContainText(COMPLIANCE.sender_email);
    await expect(view).toContainText('hello@readable-mail-co.com');
    await expect(view).toContainText(COMPLIANCE.sender_postal_address); // footer is part of the preview
    await expect(view).toContainText(/unsubscribe|opt out/i);
    await page.locator('[data-close]').first().click();

    await row.getByTestId('rewrite').click();
    await expectToast(page, '1 rewritten');
    const m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.id === d.ids[0]);
    expect(m.body).toContain('AI-WRITTEN note');
    expect(m.subject).toBe('your booking page');
    expect(m.status).toBe('approved'); // still queued: the new version passed the quality check
    const { lastPrompt } = await (await request.get(`${MOCK}/__state`)).json();
    expect(lastPrompt).toContain('typing a short cold email yourself');
    expect(lastPrompt).toContain('No flattery');
  });

  test('a machine-sounding rewrite is refused and the current email is kept', async ({ request }) => {
    const m = (await api(request, 'GET', '/outreach/messages')).find((x) => x.company_name === 'Readable Mail Co');
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'bad' } });
    const r = await api(request, 'POST', '/outreach/rewrite', { ids: [m.id] });
    expect(r.rewritten).toBe(0);
    expect(r.kept).toBe(1);
    expect((await api(request, 'GET', '/outreach/messages')).find((x) => x.id === m.id).body).toContain('AI-WRITTEN note');
    await request.post(`${MOCK}/__groq-mode`, { data: { mode: 'good' } });
  });

  test('review mode: autopilot writes the emails but nothing is approved until you do it', async ({ page, request }) => {
    await createReadyCompany(request, 'Held For Review Co', { fit_score: 9 });
    await api(request, 'PUT', '/settings', { autopilot_review: '1' });
    const run = await api(request, 'POST', '/autopilot/run');
    expect(run.approved).toBe(0);
    expect(run.held).toBeGreaterThanOrEqual(1);
    expect(run.summary).toContain('waiting for your approval');
    const held = (await api(request, 'GET', '/outreach/messages')).find((x) => x.company_name === 'Held For Review Co');
    expect(held.status).toBe('draft');
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).toContainText('waiting for your approval');
  });
});
