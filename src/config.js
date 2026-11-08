import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (Node >= 21 has process.loadEnvFile).
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch { /* ignore malformed .env */ }
}

const env = process.env;
// Accept GROQ_API_KEY in any capitalisation (e.g. "Groq_API_key").
const envAny = (name) => { const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? env[k] : ''; };

export const config = {
  port: Number(env.PORT || 4317),
  host: env.HOST || '127.0.0.1',
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'pipeline.db'),
  // Accounts (users, sessions, workspaces) live next to the primary database.
  accountsDbPath: env.ACCOUNTS_DB_PATH || path.join(path.dirname(env.DB_PATH || path.join(ROOT, 'data', 'pipeline.db')), 'accounts.db'),
  // Email that owns the primary database (default: its sender email). Claiming it needs a code sent to that mailbox.
  ownerEmail: env.OWNER_EMAIL || '',
  signupsOpen: env.SIGNUPS !== 'closed',
  testMode: env.APP_MODE === 'test',
  // Disable background jobs (research/IMAP/sending). Tests trigger jobs explicitly.
  schedulerEnabled: env.SCHEDULER !== 'off' && env.APP_MODE !== 'test',
  // Allow website scans of private/loopback addresses (only for local tests).
  allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === '1',
  // Tests: refuse any fetch that is not to 127.0.0.1 (no real websites are contacted).
  loopbackOnlyFetch: env.LOOPBACK_ONLY_FETCH === '1',
  // Sign-in is required unless AUTH_ENABLED=0 (off by default only in the automated test server).
  authEnabled: env.AUTH_ENABLED ? env.AUTH_ENABLED !== '0' : env.APP_MODE !== 'test',
  publicBaseUrl: env.PUBLIC_BASE_URL || '',
  // 'simple' (default): automatic research, decision-maker optional. 'strict': the original manual-evidence rules.
  pipelineMode: env.PIPELINE_MODE || 'simple',
  // Defaults for integrations. Values saved in Settings (UI) override these.
  defaults: {
    hubspot_token: env.HUBSPOT_TOKEN || '',
    hubspot_base_url: env.HUBSPOT_BASE_URL || 'https://api.hubapi.com',
    apollo_api_key: env.APOLLO_API_KEY || '',
    apollo_base_url: env.APOLLO_BASE_URL || 'https://api.apollo.io',
    clay_webhook_secret: env.CLAY_WEBHOOK_SECRET || '',
    hunter_api_key: env.HUNTER_API_KEY || '',
    hunter_base_url: env.HUNTER_BASE_URL || 'https://api.hunter.io',
    smtp_host: env.SMTP_HOST || 'smtp.hostinger.com',
    smtp_port: env.SMTP_PORT || '465',
    smtp_user: env.SMTP_USER || '',
    smtp_pass: env.SMTP_PASS || '',
    imap_host: env.IMAP_HOST || 'imap.hostinger.com',
    imap_port: env.IMAP_PORT || '993',
    imap_user: env.IMAP_USER || env.SMTP_USER || '',
    imap_pass: env.IMAP_PASS || env.SMTP_PASS || '',
    groq_api_key: envAny('GROQ_API_KEY'),
    groq_base_url: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    osm_nominatim_url: env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    osm_overpass_url: env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    mail_transport: env.MAIL_TRANSPORT || (env.APP_MODE === 'test' ? 'capture' : 'smtp'),
    dns_mode: env.DNS_MODE || (env.APP_MODE === 'test' ? 'mock' : 'live'),
  },
};
