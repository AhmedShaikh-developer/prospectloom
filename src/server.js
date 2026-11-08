import { upgradeDefaultTemplates } from './lib/settings.js';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, ROOT } from './config.js';
import { getDb } from './db/index.js';
import { api } from './routes/api.js';
import { handleClayWebhook } from './services/discovery.js';
import { unsubscribeByToken } from './services/outreach.js';
import { getSetting } from './lib/settings.js';
import { startScheduler } from './services/scheduler.js';
import { recoverJobs } from './services/jobs.js';

getDb();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// Public endpoints (no dashboard auth): unsubscribe links and the Clay webhook.
app.get('/u/:token', (req, res) => {
  const ok = unsubscribeByToken(req.params.token);
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribe</title>
    <body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#222">
    <h1>${ok ? "You're unsubscribed" : 'Link not recognised'}</h1>
    <p>${ok ? 'You will not receive further emails from us.' : 'Reply "unsubscribe" to the email and we will remove you.'}</p></body>`);
});

app.post('/hooks/clay', (req, res) => {
  const secret = getSetting('clay_webhook_secret');
  const given = String(req.get('x-clay-secret') || req.query.secret || '');
  if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  try { res.json(handleClayWebhook(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Optional password for the dashboard (recommended if PUBLIC_BASE_URL exposes the app).
if (config.dashboardPassword) {
  app.use((req, res, next) => {
    const [, b64] = String(req.get('authorization') || '').split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass === config.dashboardPassword) return next();
    res.set('WWW-Authenticate', 'Basic realm="ProspectLoom"').status(401).send('Authentication required');
  });
}

// Your company logo lives next to your data (private, never in the code repository).
const brandDir = path.join(path.dirname(config.dbPath), 'brand');
const LOGO_FILES = ['logo.png', 'logo.jpg', 'logo.webp', 'logo.svg'];
app.get('/brand/logo', (req, res) => {
  const f = LOGO_FILES.map((x) => path.join(brandDir, x)).find((p) => fs.existsSync(p));
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'no-cache').sendFile(f);
});
app.post('/api/brand/logo', (req, res) => {
  const m = String(req.body?.dataUrl || '').match(/^data:image\/(png|jpe?g|webp|svg\+xml);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Choose a PNG, JPG, WebP or SVG image' });
  const ext = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', 'svg+xml': 'svg' }[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Logo must be under 3 MB' });
  fs.mkdirSync(brandDir, { recursive: true });
  for (const x of LOGO_FILES) fs.rmSync(path.join(brandDir, x), { force: true });
  fs.writeFileSync(path.join(brandDir, `logo.${ext}`), buf);
  res.json({ ok: true });
});
app.delete('/api/brand/logo', (req, res) => {
  for (const x of LOGO_FILES) fs.rmSync(path.join(brandDir, x), { force: true });
  res.json({ ok: true });
});
app.use('/api', api);
app.use(express.static(path.join(ROOT, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

recoverJobs();
upgradeDefaultTemplates();
app.listen(config.port, config.host, () => {
  console.log(`ProspectLoom → http://${config.host}:${config.port}${config.testMode ? '  [TEST MODE]' : ''}`);
  if (config.schedulerEnabled) startScheduler();
});
