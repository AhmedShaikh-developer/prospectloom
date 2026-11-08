// Starts the app against a fresh throwaway database for Playwright.
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.resolve('tests/.tmp/e2e.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) fs.rmSync(f, { force: true });

Object.assign(process.env, {
  APP_MODE: 'test',
  DB_PATH: dbPath,
  PORT: '4400',
  ALLOW_PRIVATE_FETCH: '1',
  LOOPBACK_ONLY_FETCH: '1',
  HUBSPOT_TOKEN: 'test-token',
  HUBSPOT_BASE_URL: 'http://127.0.0.1:4501',
  APOLLO_BASE_URL: 'http://127.0.0.1:4501',
  GROQ_BASE_URL: 'http://127.0.0.1:4501/openai/v1',
  HUNTER_BASE_URL: 'http://127.0.0.1:4501/hunter',
  GROQ_API_KEY: '',
  OSM_NOMINATIM_URL: 'http://127.0.0.1:4501/osm/nominatim',
  OSM_OVERPASS_URL: 'http://127.0.0.1:4501/osm/overpass',
  // Phase specs 01–13 exercise the original strict rules; spec 14 switches to simple mode.
  PIPELINE_MODE: 'strict',
  ENV_FILE: '/nonexistent',
  SMTP_USER: '', SMTP_PASS: '', IMAP_USER: '', IMAP_PASS: '',
});
await import('../src/server.js');
