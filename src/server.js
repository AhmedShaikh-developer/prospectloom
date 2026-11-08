import { upgradeDefaultTemplates } from './lib/settings.js';
import express from 'express';
import path from 'node:path';
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

app.use('/api', api);
app.use(express.static(path.join(ROOT, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

recoverJobs();
upgradeDefaultTemplates();
app.listen(config.port, config.host, () => {
  console.log(`ProspectLoom → http://${config.host}:${config.port}${config.testMode ? '  [TEST MODE]' : ''}`);
  if (config.schedulerEnabled) startScheduler();
});
