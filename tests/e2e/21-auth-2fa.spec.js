import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

// Accounts: the app is locked until you sign in; the first account is the owner; two-factor
// authentication with an authenticator app and one-time recovery codes; sign-ups closed by default.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret, t = Date.now()) {
  let bits = 0; let val = 0; const key = [];
  for (const ch of secret.replace(/\s/g, '').toUpperCase()) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(key)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
}
const OWNER = { name: 'Avery Owner', email: 'owner@acmestudio.dev', password: 'Correct horse 42 battery' };

test.describe.serial('Sign-in, sign-up & two-factor authentication', () => {
  let secret = ''; let codes = [];
  test.beforeAll(async ({ request }) => { await request.post('/__test/auth', { data: { enabled: true } }); });
  test.afterAll(async ({ request }) => { await request.post('/__test/auth', { data: { enabled: false } }); });

  async function signIn(page, { code } = {}) {
    await page.goto('/login');
    await page.getByTestId('login-email').fill(OWNER.email);
    await page.getByTestId('login-password').fill(OWNER.password);
    await page.getByTestId('login-submit').click();
    if (code) {
      await expect(page.getByTestId('form-2fa')).toBeVisible();
      await page.getByTestId('login-code').fill(code);
      await page.getByTestId('login-code-submit').click();
    } else await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  }

  test('locked: pages go to sign-in, the API answers 401, public links still work', async ({ page, request }) => {
    expect((await request.get('/api/dashboard')).status()).toBe(401);
    await page.goto('/#/companies');
    await expect(page).toHaveURL(/\/login#\/companies$/); // the page you asked for is kept for after sign-in
    expect((await request.get('/u/not-a-real-token')).status()).toBe(200); // unsubscribe links stay public
    const hook = await request.post('/hooks/clay', { data: {} });
    expect((await hook.json()).error).toBe('Invalid webhook secret'); // webhook keeps its own secret check
  });

  test('first visit: create the owner account (strong password) and land in Security', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('form-signup')).toBeVisible();
    await expect(page.getByText('Set up your workspace')).toBeVisible();
    await page.getByTestId('signup-name').fill(OWNER.name);
    await page.getByTestId('signup-email').fill(OWNER.email);
    await page.getByTestId('signup-password').fill('lettersonlypassword');
    await page.getByTestId('signup-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText('at least one number');
    await page.getByTestId('signup-password').fill(OWNER.password);
    await page.getByTestId('signup-submit').click();
    await expect(page).toHaveURL(/#\/settings\?tab=security/);
    await expect(page.getByTestId('security')).toContainText('Your account is ready');
    await expect(page.getByTestId('user-menu')).toHaveText('AO');
  });

  test('turn on 2FA: QR code + key, a wrong code is refused, the right one enables it and shows recovery codes', async ({ page }) => {
    await signIn(page);
    await page.goto('/#/settings?tab=security');
    await page.getByTestId('2fa-start').click();
    await expect(page.getByTestId('2fa-qr').locator('svg')).toBeVisible();
    secret = (await page.getByTestId('2fa-secret').textContent()).trim();
    expect(secret.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByTestId('2fa-code').fill('000000');
    await page.getByTestId('2fa-verify').click();
    await expect(page.getByTestId('toast-error')).toContainText('not right');
    await page.getByTestId('2fa-code').fill(totp(secret));
    await page.getByTestId('2fa-verify').click();
    await expect(page.getByTestId('recovery-codes').locator('span')).toHaveCount(8);
    codes = await page.getByTestId('recovery-codes').locator('span').allTextContents();
  });

  test('every sign-in now needs the code', async ({ page }) => {
    await signIn(page, { code: '123456' === totp(secret) ? '654321' : '123456' });
    await expect(page.getByTestId('auth-error')).toContainText('not right');
    await page.getByTestId('login-code').fill(totp(secret));
    await page.getByTestId('login-code-submit').click();
    await expect(page.locator('main h1')).toHaveText('Pipeline dashboard');
    await page.getByTestId('user-menu').click();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a recovery code works exactly once', async ({ page }) => {
    await signIn(page, { code: codes[0] });
    await expect(page.locator('main h1')).toHaveText('Pipeline dashboard');
    await page.context().clearCookies();
    await signIn(page, { code: codes[0] });
    await expect(page.getByTestId('auth-error')).toContainText('not right');
  });

  test('sign-ups are closed after the owner — until the owner opens them', async ({ page, browser }) => {
    const other = await (await browser.newContext()).newPage();
    await other.goto('/signup');
    await expect(other.getByTestId('signups-closed')).toBeVisible();

    await signIn(page, { code: totp(secret, Date.now() + 30_000) });
    await page.goto('/#/settings?tab=security');
    await page.getByTestId('signups-toggle').check();
    await expect(page.getByTestId('toast').filter({ hasText: 'Sign-ups open' })).toBeVisible();

    await other.goto('/signup');
    await other.getByTestId('signup-name').fill('Sam Member');
    await other.getByTestId('signup-email').fill('sam@acmestudio.dev');
    await other.getByTestId('signup-password').fill('Another strong 77 pass');
    await other.getByTestId('signup-submit').click();
    await expect(other).toHaveURL(/#\/settings\?tab=security/);
    await page.reload();
    await expect(page.getByTestId('users-table')).toContainText('sam@acmestudio.dev');
    await expect(page.getByTestId('users-table')).toContainText('member');
    await page.getByTestId('signups-toggle').uncheck();
    await expect(page.getByTestId('toast').filter({ hasText: 'Sign-ups closed' })).toBeVisible();
  });

  test('repeated wrong passwords lock sign-in for a while', async ({ request }) => {
    for (let i = 0; i < 5; i++) await request.post('/api/auth/login', { data: { email: 'nobody@acmestudio.dev', password: 'wrong-pass-1' } });
    const r = await request.post('/api/auth/login', { data: { email: 'nobody@acmestudio.dev', password: 'wrong-pass-1' } });
    expect((await r.json()).error).toContain('Too many attempts');
  });
});
