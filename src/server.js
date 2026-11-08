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
import { authRouter } from './routes/auth.js';
import * as auth from './services/auth.js';

getDb();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // behind nginx on the same server: real client IP + https detection
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

// ---------------------------------------------------------------- sign-in
// Public: the sign-in pages and their assets, the auth API, unsubscribe links (above) and the Clay webhook (above).
app.use('/api/auth', authRouter);
if (config.testMode) app.post('/__test/auth', (req, res) => { auth.setEnabled(!!req.body?.enabled); res.json({ enabled: auth.isEnabled() }); });
const PUBLIC_FILES = new Set(['/styles.css', '/logo.svg', '/auth.js', '/login.html']);
app.get(['/login', '/signup'], (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.use((req, res, next) => {
  if (!auth.isEnabled() || PUBLIC_FILES.has(req.path)) return next();
  const user = auth.sessionUser(auth.readCookie(req));
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in required', signIn: true });
  return res.redirect('/login');
});

// The app reloads itself when its files change (so an open tab never runs an old version).
const PUBLIC_DIR = path.join(ROOT, 'public');
app.get('/api/version', (req, res) => {
  const v = fs.readdirSync(PUBLIC_DIR).reduce((m, f) => Math.max(m, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs), 0);
  res.json({ v: String(Math.round(v)) });
});
app.use('/api', api);
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

recoverJobs();
upgradeDefaultTemplates();
app.listen(config.port, config.host, () => {
  console.log(`ProspectLoom → http://${config.host}:${config.port}${config.testMode ? '  [TEST MODE]' : ''}`);
  if (config.schedulerEnabled) startScheduler();
});
