import { test, expect } from '@playwright/test';
import { api, ensureCompliance, SITE } from './helpers.js';

// Human-like send times with a warm-up, and research that recognises dead or bot-protected websites.
test.describe.serial('Rounds, warm-up & website health', () => {
  test.beforeAll(async ({ request }) => {
    await ensureCompliance(request);
    await api(request, 'PUT', '/settings', {
      daily_send_limit: '10', send_spread: '1', send_window_start: '9', send_window_end: '15',
      min_minutes_between_sends: '2', max_minutes_between_sends: '20',
      warmup_enabled: '1', warmup_hold_days: '14', warmup_step: '5', warmup_every_days: '7', warmup_max: '40',
    });
  });
  test.afterAll(async ({ request }) => {
    await api(request, 'PUT', '/settings', { send_window_start: '9', send_window_end: '15', warmup_start_date: '' });
  });

  test('settings: random send times, gaps and warm-up are editable with a plain-language preview', async ({ page }) => {
    await page.goto('/#/settings?tab=schedule');
    const card = page.getByTestId('volume-settings');
    await expect(card.getByTestId('f-send_spread')).toBeChecked();
    await expect(card.getByTestId('f-warmup_enabled')).toBeChecked();
    const preview = page.getByTestId('warmup-preview');
    await expect(preview).toContainText('Days 1–14: 10/day · days 15–21: 15 · days 22–28: 20');
    await expect(preview).toContainText('day 50: 40/day from then on');
    await expect(preview).toContainText('random times over 6 hours — mostly 2–8 minutes apart, sometimes up to 20, with a few longer breaks');
    await card.getByTestId('f-warmup_step').fill('10');
    await expect(preview).toContainText('days 15–21: 20');
    await card.getByTestId('f-warmup_step').fill('5');
  });

  test('dashboard: today\'s plan shows every send time (random, inside the window) and the warm-up stage', async ({ page, request }) => {
    const t = await api(request, 'GET', '/outreach/quota');
    expect(t.plan.slots).toHaveLength(10);
    const mins = t.plan.slots.map((x) => x.atMin);
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(9 * 60);
    expect(Math.max(...mins)).toBeLessThanOrEqual(15 * 60);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('plan-slot')).toHaveCount(10);
    await expect(page.getByTestId('send-plan')).toContainText('Today: 10 emails at random times, 09:00–15:00');
    await expect(page.getByTestId('send-timeline').locator('.sd')).toHaveCount(10);
    await expect(page.getByTestId('warmup-status')).toContainText(/Warm-up (day \d+|starts with your first email)/);

    // Three weeks after the first email the limit has grown by itself
    const threeWeeksAgo = new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10);
    await api(request, 'PUT', '/settings', { warmup_start_date: threeWeeksAgo });
    const later = await api(request, 'GET', '/outreach/quota');
    expect(later.warmup.day).toBe(21);
    expect(later.warmup.nextLimit).toBe(20);
    await page.reload();
    if (later.warmup.braked) {
      // Earlier specs bounced >3% of 20+ emails this week: the ramp correctly holds at the starting level.
      expect(later.limit).toBe(10);
      await expect(page.getByTestId('warmup-status')).toContainText('Warm-up paused at 10/day — too many bounces');
    } else {
      expect(later.limit).toBe(15);
      expect(later.plan.slots).toHaveLength(15);
      await expect(page.getByTestId('warmup-status')).toContainText('Warm-up day 21: 15/day → 20/day');
    }
    await api(request, 'PUT', '/settings', { warmup_start_date: '', warmup_enabled: '0' });
    expect((await api(request, 'GET', '/outreach/quota')).limit).toBe(10);
    await api(request, 'PUT', '/settings', { warmup_enabled: '1' });
  });

  test('research: an expired domain is excluded instead of retried forever', async ({ request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Gone Diner', domain: 'deadsite-diner.com', website: 'https://www.deadsite-diner.com/' });
    const v = await api(request, 'POST', `/companies/${company.id}/verify`);
    expect(v.log.join(' ')).toContain('domain no longer exists');
    expect(v.after).toBe('EXCLUDED');
    const c = (await api(request, 'GET', `/companies/${company.id}`)).company;
    expect(c.site_status).toBe('offline');
    expect(c.status_reason).toBe('Website offline — the domain no longer exists');
    // Fixing the address by hand clears the verdict
    await api(request, 'PUT', `/companies/${company.id}`, { website: SITE.acme });
    expect((await api(request, 'GET', `/companies/${company.id}`)).company.site_status).toBeNull();
  });

  test('research: a site that blocks robots is parked for 30 days with a clear reason', async ({ page, request }) => {
    const { company } = await api(request, 'POST', '/companies', { name: 'Robots Say No', domain: 'robots-say-no.com', website: SITE.blocked });
    const v = await api(request, 'POST', `/companies/${company.id}/verify`);
    expect(v.log.join(' ')).toContain('blocks automated visits');
    const c = (await api(request, 'GET', `/companies/${company.id}`)).company;
    expect(c.site_status).toBe('blocked');
    expect(c.status_reason).toContain('Website blocks automated visits');
    expect(new Date(c.next_screen_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    await page.goto('/#/dashboard');
    await expect(page.getByTestId('blockers')).toContainText('block automated visits');
    await page.goto('/#/companies?site=blocked');
    await expect(page.getByTestId('companies-table')).toContainText('Robots Say No');
  });

  test('finder import skips businesses whose website no longer exists', async ({ request }) => {
    const r = await api(request, 'POST', '/finder/import', { results: [
      { name: 'Dead Deli', website: 'https://deadsite-deli.com/', domain: 'deadsite-deli.com', category: 'Restaurants', offer: 'C', osm_url: 'https://www.openstreetmap.org/node/9' },
      { name: 'Alive Arepas', website: 'https://alive-arepas.com/', domain: 'alive-arepas.com', category: 'Restaurants', offer: 'C', osm_url: 'https://www.openstreetmap.org/node/10' },
    ] });
    expect(r.deadSkipped).toBe(1);
    expect(r.created).toBe(1);
    expect((await api(request, 'GET', '/companies?search=deadsite-deli.com')).rows).toHaveLength(0);
  });
});
