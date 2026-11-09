import { test, expect } from '@playwright/test';
import { api } from './helpers.js';

// Its own page (left menu) explains what runs by itself, why something is waiting, and when it runs next.
test.describe.serial('Automation schedule', () => {
  const hourIn = (tz) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date())) % 24;

  test('every automatic job shows its state, the reason, its last run and its next run', async ({ page, request }) => {
    const au = await api(request, 'GET', '/automation');
    expect(au.rows.slice(0, 5).map((r) => r.key)).toEqual(['engine', 'research', 'writing', 'sending', 'mailbox']);
    for (const r of au.rows) { expect(r.state).toBeTruthy(); expect(r.reason).toBeTruthy(); }
    expect(au.timeline.rows.map((r) => r.key)).toEqual(['engine', 'research', 'sending']);
    expect(au.timeline.rows[0].values).toHaveLength(au.timeline.hours);

    await page.goto('/#/dashboard');
    await expect(page.getByTestId('hero')).toBeVisible();
    await expect(page.getByTestId('automation')).toHaveCount(0); // not on the dashboard
    await page.locator('nav a[data-nav="automation"]').click();
    await expect(page).toHaveURL(/#\/automation$/);
    await expect(page.locator('main h1')).toHaveText('Automation schedule');
    await expect(page.locator('nav a[data-nav="automation"]')).toHaveClass(/active/);
    const card = page.getByTestId('automation');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('auto-now')).toContainText('your time');
    await expect(card.getByTestId('auto-row')).toHaveCount(au.rows.length);
    for (const key of ['engine', 'research', 'writing', 'sending', 'mailbox']) {
      const row = card.locator(`[data-testid="auto-row"][data-key="${key}"]`);
      await expect(row.getByTestId('auto-state')).not.toBeEmpty();
      await expect(row.getByTestId('auto-reason')).not.toBeEmpty();
    }
  });

  test('a paused lead engine says why and exactly when it starts again', async ({ page, request }) => {
    // at least one lead the engine "found" today, so a limit of 1 is reached
    await api(request, 'POST', '/companies', { name: 'Map Lead Today', domain: 'map-lead-today.example', lead_origin: 'openstreetmap' }).catch(() => null);
    await api(request, 'PUT', '/engine', { engine_enabled: '1', engine_daily_cap: '1', engine_categories: 'restaurants', engine_locations: 'Austin, TX, USA' });
    const eng = (await api(request, 'GET', '/automation')).rows.find((r) => r.key === 'engine');
    expect(eng.state).toBe('paused');
    expect(eng.nextLabel).toBe('Starts again');
    await page.goto('/#/automation');
    const row = page.locator('[data-testid="auto-row"][data-key="engine"]');
    await expect(row.getByTestId('auto-state')).toHaveText('Paused');
    await expect(row.getByTestId('auto-reason')).toContainText('Daily limit reached');
    await expect(row.getByTestId('auto-next')).toContainText(/Starts again\s*tomorrow 12:00\sAM/);
    await expect(row.getByRole('link', { name: /Raise the daily limit/ })).toHaveAttribute('href', '#/engine');
    await api(request, 'PUT', '/engine', { engine_daily_cap: '1500', engine_enabled: '0' });
  });

  test('outside sending hours it shows when sending starts, in your time', async ({ page, request }) => {
    const before = await api(request, 'GET', '/settings');
    const tz = before.send_timezone || 'America/New_York';
    const h = hourIn(tz);
    const [ws, we] = h < 20 ? [h + 2, h + 4] : [1, 3]; // a window that is not open right now
    await api(request, 'PUT', '/settings', { auto_send_enabled: '1', send_window_start: String(ws), send_window_end: String(we), daily_send_limit: '500', send_days: '0,1,2,3,4,5,6' });
    try {
      const s = (await api(request, 'GET', '/automation')).rows.find((r) => r.key === 'sending');
      expect(s.state).toBe('waiting');
      expect(s.nextLabel).toBe('Sending starts');
      expect(new Date(s.next).getTime()).toBeGreaterThan(Date.now());
      await page.goto('/#/automation');
      const row = page.locator('[data-testid="auto-row"][data-key="sending"]');
      await expect(row.getByTestId('auto-reason')).toContainText('Outside sending hours');
      await expect(row.getByTestId('auto-window')).toContainText('your time');
      await expect(row.getByTestId('auto-next')).toContainText(/Sending starts.*in \d/);
    } finally {
      await api(request, 'PUT', '/settings', { auto_send_enabled: before.auto_send_enabled, send_window_start: before.send_window_start, send_window_end: before.send_window_end, daily_send_limit: before.daily_send_limit, send_days: before.send_days });
    }
  });

  test('today, hour by hour: one row per job, with a tooltip for each hour', async ({ page }) => {
    await page.goto('/#/automation');
    const tl = page.getByTestId('auto-timeline');
    const svg = tl.locator('.chart svg');
    await expect(svg).toBeVisible();
    await expect(svg.locator('.day-track')).toHaveCount(3);
    await expect(svg.locator('.marker-t')).toContainText('Now');
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    const tip = tl.locator('.viz-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Finding leads');
    await expect(tip).toContainText('Sending');
  });
});
