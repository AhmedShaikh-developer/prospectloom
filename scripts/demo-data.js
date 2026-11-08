// Builds a demo workspace full of FICTIONAL companies, emails and replies, so you can try ProspectLoom
// (and take screenshots) without touching real data. Domains use the reserved .example TLD.
//
//   npm run demo          → creates data/demo/pipeline.db and starts the app on http://127.0.0.1:4320
//
// It refuses to write into a database that already has companies.
import path from 'node:path';
import fs from 'node:fs';

const DB = path.resolve(process.env.DEMO_DB || 'data/demo/pipeline.db');
fs.rmSync(DB, { force: true }); fs.rmSync(`${DB}-wal`, { force: true }); fs.rmSync(`${DB}-shm`, { force: true });
Object.assign(process.env, { DB_PATH: DB, ENV_FILE: '/nonexistent', SCHEDULER: 'off' });

const { q } = await import('../src/db/index.js');
const { saveSettings, setSetting } = await import('../src/lib/settings.js');
const { setPlatform } = await import('../src/services/performance.js');
if (q.get('SELECT COUNT(*) AS n FROM companies').n) throw new Error(`${DB} already has data — not touching it`);

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600_000; const DAY = 24 * HOUR;

saveSettings({
  sender_name: 'Jordan Reyes', sender_title: 'Founder', sender_company: 'Northwind Studio', sender_email: 'jordan@northwindstudio.example',
  sender_website: 'https://northwindstudio.example', sender_postal_address: '500 Market St, Suite 200, San Francisco, CA 94105',
  daily_send_limit: '10', warmup_enabled: '1', send_window_start: '9', send_window_end: '15', send_days: '0,1,2,3,4,5,6',
  autopilot_enabled: '1', pipeline_mode: 'simple', allow_provider_emails: '1', engine_enabled: '1',
  engine_categories: 'restaurants,dentists,marketing-advertising-agencies,it-companies,real-estate-agents', engine_locations: 'Austin, TX, USA\nDenver, CO, USA\nSeattle, WA, USA',
  smtp_user: 'jordan@northwindstudio.example', smtp_pass: 'demo-password', mail_transport: 'smtp', dns_mode: 'mock', groq_api_key: 'demo-key',
  apollo_api_key: 'demo-key', apollo_api_search_enabled: '1', engine_apollo_enabled: '1', engine_apollo_keywords: 'shopify agency\nlogistics company',
  hunter_api_key: 'demo-key', source_hunter_enabled: '1', hubspot_token: 'demo-key', source_hubspot_import: '1',
});
setSetting('warmup_start_date', new Date(Date.now() - 17 * DAY).toISOString().slice(0, 10));
setSetting('imap_last_sync', iso(4 * 60_000));
setSetting('engine_last_run', iso(2 * 60_000));

const WORDS = ['North', 'Pine', 'Harbor', 'Summit', 'Copper', 'Bright', 'Maple', 'Cedar', 'Blue', 'River', 'Atlas', 'Golden', 'Granite', 'Silver', 'Iron', 'Oak', 'Lumen', 'Echo', 'Nova', 'Vista'];
const KINDS = {
  'Map listings': ['Dental', 'Bistro', 'Realty', 'Fitness', 'Salon', 'Bakery', 'Clinic', 'Cafe'],
  Apollo: ['Logistics', 'Commerce', 'Labs', 'Systems', 'Freight', 'Digital'],
  Clay: ['Agency', 'Creative', 'Studio', 'Partners', 'Interactive'],
  HubSpot: ['Group', 'Consulting', 'Ventures', 'Advisors'],
};
const ORIGIN = { 'Map listings': 'openstreetmap', Apollo: 'apollo', Clay: 'csv: Clay export - agency partners.csv', HubSpot: 'hubspot' };
const COUNT = { 'Map listings': 2840, Apollo: 610, Clay: 420, HubSpot: 185 };
const INDUSTRY = { 'Map listings': ['Dentists', 'Restaurants', 'Real estate agents', 'Gyms & fitness studios', 'Hair & beauty salons'], Apollo: ['Logistics', 'E-commerce', 'Software'], Clay: ['Marketing agency', 'Design studio', 'Web agency'], HubSpot: ['Consulting', 'Professional services'] };
const used = new Set();

const ids = {};
for (const [platform, count] of Object.entries(COUNT)) {
  ids[platform] = [];
  for (let i = 0; i < count; i++) {
    let name; let domain;
    do { name = `${pick(WORDS)} ${pick(WORDS)} ${pick(KINDS[platform])}`; domain = `${name.toLowerCase().replace(/[^a-z]+/g, '')}${Math.floor(rnd() * 90 + 10)}.example`; } while (used.has(domain));
    used.add(domain);
    const age = platform === 'Clay' ? 13 * DAY + rnd() * DAY : Math.pow(rnd(), 1.7) * 13.5 * DAY; // the engine ramps up over two weeks
    const r = rnd();
    const status = r < 0.22 ? 'READY' : r < 0.47 ? 'RESEARCHING' : r < 0.9 ? 'HOLD_VERIFY' : r < 0.95 ? 'EXCLUDED' : 'RESEARCHING';
    const hasEmail = status === 'READY' || rnd() < 0.25;
    const res = q.run(`INSERT INTO companies (name, domain, website, status, status_reason, lead_origin, industry, offer, contact_email, email_contact_type, email_evidence_type,
        description, profile_url, fit_score, screen_count, last_screened_at, ready_at, research_completed_at, site_status, created_at, updated_at)
      VALUES (:name, :domain, :web, :status, :reason, :origin, :industry, :offer, :email, :ctype, :evidence, :desc, :web, :fit, :sc, :ls, :ready, :done, :site, :created, :created)`, {
      name, domain, web: `https://${domain}`, status, origin: ORIGIN[platform], industry: pick(INDUSTRY[platform]),
      offer: platform === 'Clay' ? 'B' : platform === 'Map listings' ? 'C' : 'A',
      email: hasEmail ? `${rnd() < 0.4 && platform !== 'Map listings' ? 'alex' : 'hello'}@${domain}` : null,
      ctype: rnd() < 0.4 && platform !== 'Map listings' ? 'decision_maker' : 'general',
      evidence: platform === 'Clay' ? 'imported_list' : rnd() < 0.12 ? 'hunter_io' : 'official_website',
      reason: status === 'READY' ? 'All research, contact, dedup, suppression and compliance checks passed' : status === 'HOLD_VERIFY' ? 'No usable email yet — research looks for one published on their website' : status === 'EXCLUDED' ? 'Website offline — the domain no longer exists' : 'Still needed: what they do',
      desc: `${name} — ${pick(INDUSTRY[platform]).toLowerCase()} serving local customers.`, fit: 6 + Math.floor(rnd() * 4), sc: 1 + Math.floor(rnd() * 3),
      ls: iso(rnd() * 6 * HOUR), ready: status === 'READY' ? iso(age * 0.5) : null, done: ['READY', 'HOLD_VERIFY'].includes(status) ? iso(age * 0.5) : null, site: status === 'EXCLUDED' ? 'offline' : rnd() < 0.03 ? 'blocked' : null,
      created: iso(age),
    });
    ids[platform].push(Number(res.lastInsertRowid));
  }
}
setPlatform(ORIGIN.Clay, 'Clay');

// 17 days of warmed-up sending: ~10 a day, replies differ by source (Apollo best, map listings lowest)
const BODY = (n) => `Hi there,\n\nSaw the ${n} project on your site.\n\nWe build the backend side for teams like yours, so the bigger client requests become a yes without hiring.\n\nIs that something you ever need a hand with?\n\nJordan`;
const PLAN = { Apollo: { sent: 52, replied: 8, positive: 4, bounced: 1 }, Clay: { sent: 48, replied: 4, positive: 2, bounced: 1 }, 'Map listings': { sent: 41, replied: 1, positive: 0, bounced: 3 }, HubSpot: { sent: 12, replied: 1, positive: 1, bounced: 0 } };
const sendTimes = [];
for (let d = 16; d >= 0; d--) for (let k = 0; k < (d === 0 ? 4 : 9); k++) sendTimes.push(d * DAY + (5 - k * 0.55) * HOUR + rnd() * 20 * 60_000);
let t = 0;
for (const [platform, p] of Object.entries(PLAN)) {
  const list = ids[platform].slice(0, p.sent);
  list.forEach((cid, i) => {
    const c = q.get('SELECT * FROM companies WHERE id = :id', { id: cid });
    const bounced = i >= p.sent - p.bounced; const replied = i < p.replied;
    // bounces happened in the first week (before the warm-up's 7-day bounce window)
    const sentAt = bounced ? iso((10 + rnd() * 5) * DAY) : iso(sendTimes[(t++) % sendTimes.length]);
    q.run(`UPDATE companies SET status = :st, contact_email = COALESCE(contact_email, :e), last_sent_date = :d WHERE id = :id`, { st: bounced ? 'BOUNCED' : replied ? 'REPLIED' : 'SENT', e: `hello@${c.domain}`, d: sentAt.slice(0, 10), id: cid });
    const m = q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, status, sent_at, approved_at, created_at, unsubscribe_token)
      VALUES (:cid, 'intro', :to, :subj, :body, :st, :at, :at, :at, :tok)`, { cid, to: `hello@${c.domain}`, subj: `${c.name.split(' ')[0].toLowerCase()} project`, body: BODY(c.name), st: bounced ? 'bounced' : 'sent', at: sentAt, tok: `demo${cid}` });
    if (replied) {
      q.run(`INSERT INTO replies (company_id, message_ref, from_email, subject, snippet, classification, handled, message_id, received_at)
        VALUES (:cid, :mid, :from, :s, :snip, :cls, 0, :id, :at)`, { cid, mid: Number(m.lastInsertRowid), from: `hello@${c.domain}`, s: `Re: ${c.name.split(' ')[0].toLowerCase()} project`, snip: i < p.positive ? 'Good timing — we have two client builds coming up. Can you send a few examples?' : 'Thanks, not right now but keep in touch.', cls: i < p.positive ? 'positive' : 'neutral', id: `<demo-${cid}@example>`, at: iso(Math.max(0, sendTimes[(t - 1) % sendTimes.length] - 5 * HOUR)) });
    }
  });
}
// today's queue
for (const cid of ids.Apollo.slice(60, 66)) {
  const c = q.get('SELECT * FROM companies WHERE id = :id', { id: cid });
  q.run(`UPDATE companies SET status = 'READY', contact_email = :e, email_evidence_type = 'official_website', email_contact_type = 'general', email_source_url = :src,
      email_purpose = 'Published general business inbox on official website', email_source_confirmed = 1, mx_valid = 1, email_checked_at = :now,
      personalization = :pers, personalization_url = :web, offer = 'A', us_presence = 'HQ in Austin, TX', us_presence_url = :web WHERE id = :id`,
  { e: `hello@${c.domain}`, src: `https://${c.domain}/contact`, now: new Date().toISOString(), pers: `Saw the ${c.name} project on your site.`, web: `https://${c.domain}/`, id: cid });
  q.run(`INSERT INTO messages (company_id, kind, to_email, subject, body, status, approved_at, unsubscribe_token) VALUES (:cid, 'intro', :to, :subj, :body, 'approved', :at, :tok)`,
    { cid, to: `hello@${c.domain}`, subj: `${c.name.split(' ')[0].toLowerCase()} project`, body: BODY(c.name), at: iso(HOUR), tok: `demoq${cid}` });
}
// lead engine progress and source states
const cats = ['restaurants', 'dentists', 'marketing-advertising-agencies', 'it-companies', 'real-estate-agents'];
for (const loc of ['Austin, TX, USA', 'Denver, CO, USA', 'Seattle, WA, USA']) {
  for (const cat of cats) q.run(`INSERT INTO engine_targets (source, category, location, status, runs, found, imported, last_run_at, next_run_at) VALUES ('osm', :c, :l, 'done', 1, :f, :i, :at, :next)`, { c: cat, l: loc, f: 210 + Math.floor(rnd() * 90), i: 180 + Math.floor(rnd() * 60), at: iso(rnd() * 3 * DAY), next: iso(-27 * DAY) });
  for (const kw of ['shopify agency', 'logistics company']) q.run(`INSERT INTO engine_targets (source, category, location, status, cursor, runs, found, imported, last_run_at) VALUES ('apollo', :c, :l, 'done', 4, 3, 300, :i, :at)`, { c: kw, l: loc, i: 90 + Math.floor(rnd() * 20), at: iso(rnd() * DAY) });
}
const now = new Date().toISOString();
q.run(`INSERT INTO source_state (source, status, message, credits, runs, found, imported, last_run_at, last_ok_at, updated_at) VALUES
  ('apollo', 'ready', NULL, NULL, 18, 1800, 610, :now, :now, :now),
  ('hunter', 'waiting_credits', 'Out of credits — waiting. Checks again on the 1st and continues where it stopped.', :cr, 3, 22, 9, :now, :now, :now),
  ('hubspot', 'done', '185 HubSpot companies read · all pages imported', NULL, 2, 185, 185, :now, :now, :now)`,
{ now, cr: JSON.stringify({ plan: 'Free', used: 25, available: 25, left: 0, resetAt: new Date(Date.now() + 12 * DAY).toISOString() }) });
q.run(`INSERT INTO runs (kind, started_at, finished_at, status, report) VALUES ('research', :a, :b, 'ok', :r)`, { a: iso(9 * 60_000), b: iso(7 * 60_000), r: 'Research run #412\nSelected 50 | Screened 50 | Errors 0\nNewly READY 7 | Still on hold 31 | Excluded 2 (website offline)\nInventory: 891 eligible unsent READY (59 days at 15/day)' });
console.log(`Demo workspace ready: ${DB} (${q.get('SELECT COUNT(*) AS n FROM companies').n} fictional companies)`);
