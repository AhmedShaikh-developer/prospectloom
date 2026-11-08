import express from 'express';
import crypto from 'node:crypto';
import { q, logActivity } from '../db/index.js';
import * as companies from '../services/companies.js';
import * as discovery from '../services/discovery.js';
import * as verification from '../services/verification.js';
import * as research from '../services/research.js';
import * as supp from '../services/suppression.js';
import * as outreach from '../services/outreach.js';
import * as replies from '../services/replies.js';
import * as sync from '../services/hubspotSync.js';
import * as inv from '../services/inventory.js';
import * as reports from '../services/reports.js';
import * as hubspot from '../integrations/hubspot.js';
import * as apollo from '../integrations/apollo.js';
import * as mailer from '../integrations/mailer.js';
import * as imap from '../integrations/imap.js';
import { scanWebsite } from '../lib/siteScan.js';
import { mailAuth, dropDeadSites } from '../lib/dns.js';
import * as ai from '../integrations/ai.js';
import * as osm from '../integrations/osm.js';
import * as jobs from '../services/jobs.js';
import * as engine from '../services/engine.js';
import { PRESETS } from '../lib/places.js';
import { normalizeDomain as normDomain, emailDomain as emDomain } from '../lib/normalize.js';
import { getAllSettings, saveSettings, getSetting, getBool } from '../lib/settings.js';
import { STATUS_LABELS, EVIDENCE_TYPES, CONTACT_TYPES, SUPPRESSION_REASONS, PIPELINE_STAGES, HUBSPOT_PROPERTIES } from '../lib/constants.js';
import { RESEARCH_CHECKS } from '../lib/qualification.js';
import { config } from '../config.js';

export const api = express.Router();

// async error wrapper
const h = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).then((data) => {
  if (!res.headersSent) res.json(data ?? { ok: true });
}).catch((e) => {
  res.status(e.status && e.status < 500 ? e.status : 400).json({ error: e.message });
});

const ids = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter(Boolean);

// ---------- meta ----------
api.get('/meta', h(() => ({
  statuses: STATUS_LABELS, evidenceTypes: EVIDENCE_TYPES, contactTypes: CONTACT_TYPES, suppressionReasons: SUPPRESSION_REASONS,
  pipelineStages: PIPELINE_STAGES, researchChecks: RESEARCH_CHECKS.map(([key, label]) => ({ key, label })), hubspotProperties: HUBSPOT_PROPERTIES,
  testMode: config.testMode,
  offers: { A: 'A — Custom software & automation', B: 'B — White-label partnership (agencies)', C: 'C — Local / consumer businesses (B2C)' },
  finderCategories: osm.CATEGORIES.map(({ id, label, group, offer }) => ({ id, label, group, offer })),
  cityPresets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, cities: v.cities }])),
})));

// ---------- Phase 8/11/12: dashboard ----------
api.get('/dashboard', h(() => ({
  inventory: inv.inventory(),
  funnel: inv.funnel(),
  blockers: inv.blockers(),
  integrations: inv.integrationStatus(),
  today: inv.todayStatus(),
  lastRun: reports.listRuns({ kind: 'research', limit: 1 })[0] || null,
  researchProgress: research.progress(),
  compliance: companies.complianceStatus(),
  engine: { enabled: getBool('engine_enabled') },
})));
api.get('/insights/missing', h(() => inv.topMissing(companies.evaluateCompany)));

// ---------- Phase 1: settings ----------
api.get('/settings', h(() => getAllSettings()));
api.put('/settings', h((req) => { saveSettings(req.body); logActivity(null, 'settings_saved', Object.keys(req.body)); return getAllSettings(); }));

// ---------- Phase 2/3/4/6: companies ----------
api.get('/companies', h((req) => {
  const r = companies.listCompanies(req.query);
  if (req.query.stalled) r.rows = r.rows.filter((c) => c.screen_count >= 3 && !c.site_status && (!c.last_progress_at || c.last_progress_at < c.last_screened_at));
  return r;
}));
api.post('/companies', h((req) => {
  const r = companies.upsertCompany(req.body, { origin: req.body.lead_origin || 'manual' });
  if (r.skipped) throw new Error(r.reason);
  return r;
}));
api.get('/companies/export.csv', (req, res) => {
  const { rows } = companies.listCompanies({ ...req.query, limit: 1000 });
  const cols = ['id', 'name', 'domain', 'status', 'status_reason', 'offer', 'fit_score', 'industry', 'employee_count', 'dm_name', 'dm_title', 'contact_email', 'email_source_url', 'email_evidence_type', 'us_presence', 'personalization', 'lead_origin', 'hubspot_id', 'last_sent_date'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.type('text/csv').attachment('companies.csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});
api.get('/companies/:id', h((req) => {
  const c = companies.getCompany(Number(req.params.id));
  if (!c) { const e = new Error('Company not found'); e.status = 404; throw e; }
  return {
    company: c,
    evaluation: companies.evaluateCompany(c),
    messages: q.all('SELECT * FROM messages WHERE company_id = :id ORDER BY id DESC', { id: c.id }),
    replies: q.all('SELECT * FROM replies WHERE company_id = :id ORDER BY id DESC', { id: c.id }),
    activity: q.all('SELECT * FROM activity WHERE company_id = :id ORDER BY id DESC LIMIT 100', { id: c.id }),
    opportunity: q.get('SELECT * FROM opportunities WHERE company_id = :id', { id: c.id }) || null,
    hubspotOps: q.all('SELECT * FROM hubspot_ops WHERE company_id = :id ORDER BY id DESC LIMIT 20', { id: c.id }),
  };
}));
api.put('/companies/:id', h((req) => companies.updateCompany(Number(req.params.id), req.body)));
api.delete('/companies/:id', h((req) => { companies.deleteCompany(Number(req.params.id)); return { ok: true }; }));
api.post('/companies/:id/status', h((req) => companies.setStatusManually(Number(req.params.id), req.body.status, req.body.reason)));
api.post('/companies/:id/verify', h((req) => verification.verifyCompany(Number(req.params.id), { scan: req.body?.scan !== false })));
api.post('/companies/:id/scan', h(async (req) => {
  const c = companies.getCompany(Number(req.params.id));
  if (!c) throw new Error('Company not found');
  return scanWebsite(c.website || c.domain);
}));
api.post('/companies/:id/use-email', h((req) => {
  // Choose one of the scanned emails as the contact (from the official website).
  const c = companies.getCompany(Number(req.params.id));
  const found = JSON.parse(c.scan_emails || '[]').find((e) => e.email === String(req.body.email).toLowerCase());
  if (!found) throw new Error('That email was not found in the last website scan');
  return companies.updateCompany(c.id, {
    contact_email: found.email, email_source_url: found.url, email_evidence_type: 'official_website',
    email_contact_type: req.body.contact_type || 'general', email_purpose: req.body.purpose || 'Published business inbox on official website',
  });
}));

// ---------- Email studio (per-lead email) ----------
api.get('/companies/:id/studio', h((req) => outreach.studio(Number(req.params.id))));
api.post('/companies/:id/personalize', h((req) => {
  const id = Number(req.params.id);
  const c = companies.getCompany(id);
  if (!c) throw new Error('Company not found');
  const s = outreach.studio(id).suggestions[Number(req.body.index)];
  if (!s) throw new Error('Suggestion not found');
  return companies.updateCompany(id, { personalization: s.text, personalization_url: s.source_url });
}));
api.post('/companies/:id/ai-draft', h((req) => outreach.aiDraft(Number(req.params.id))));
api.post('/companies/:id/custom-draft', h((req) => outreach.createCustomDraft(Number(req.params.id), req.body)));

// ---------- Deliverability: check your own sending domain ----------
api.get('/sender/auth', h(async () => {
  const email = getSetting('sender_email');
  if (!email.includes('@')) throw new Error('Set your sender email in Settings first');
  return mailAuth(email.split('@')[1]);
}));

// ---------- Phase 2: discovery / import ----------
api.post('/import/preview', h((req) => discovery.previewCsv(req.body.csv || '')));
api.post('/import/csv', h((req) => jobs.trackJob('import', `CSV import${req.body.filename ? `: ${req.body.filename}` : ''}`, {}, async () => {
  const r = discovery.importCsv(req.body.csv || '', { source: req.body.source, mapping: req.body.mapping, label: req.body.filename ? `CSV: ${req.body.filename}` : undefined, leadOrigin: req.body.filename ? `csv: ${req.body.filename}` : undefined });
  return { ...r, summary: `${r.created} new, ${r.merged} merged` };
})));
api.get('/import/folder', h(() => discovery.folderFiles()));
api.post('/import/folder', h((req) => jobs.trackJob('import', 'Leads folder import', {}, async (ctx) => discovery.importFolder({ all: !!req.body?.all, onProgress: ctx.progress }))));

// ---------- Contact history: never introduce someone twice ----------
function reevaluateMatching(emails, domains) {
  const ids = new Set();
  for (const e of emails) q.all('SELECT id FROM companies WHERE contact_email = :e OR domain = :d', { e, d: emDomain(e) }).forEach((r) => ids.add(r.id));
  for (const d of domains) q.all('SELECT id FROM companies WHERE domain = :d OR domain LIKE :sub', { d, sub: `%.${d}` }).forEach((r) => ids.add(r.id));
  for (const id of ids) { supp.runDedup(companies.getCompany(id)); companies.reevaluate(id, 'contact_history'); }
  return ids.size;
}
api.post('/history/import', h((req) => {
  const r = discovery.importContactHistory(req.body.text || '', { note: req.body.note || 'Imported contact history' });
  if (!r.emails && !r.domains) throw new Error('No email addresses or domains found in the text');
  return { emails: r.emails, domains: r.domains, affected: reevaluateMatching(r.emailList, r.domainList) };
}));
api.get('/history', h(() => q.all("SELECT folder, email, domain, date FROM mail_history WHERE direction = 'out' ORDER BY id DESC LIMIT 500")));
api.post('/companies/mark-contacted', h((req) => {
  const list = ids(req.body.ids).map((id) => companies.getCompany(id)).filter(Boolean);
  const text = list.map((c) => c.contact_email || c.domain).join('\n');
  if (!text) throw new Error('Select companies first');
  const r = discovery.importContactHistory(text, { note: 'Marked as already contacted' });
  return { marked: list.length, affected: reevaluateMatching(r.emailList, [...r.domainList, ...list.map((c) => normDomain(c.domain))]) };
}));
api.post('/import/domains', h((req) => discovery.importDomainList(req.body.text || '', { offer: req.body.offer })));
api.post('/import/hubspot', h(() => sync.importFromHubspot()));
api.post('/import/apollo-search', h(async (req) => {
  const people = await apollo.searchPeople(req.body || {});
  if (req.body.import) return discovery.importRecords(people.map((p) => ({ ...p, dm_url: p.linkedin })), { origin: 'apollo', label: 'Apollo search' });
  return { results: people };
}));

// ---------- Local business finder (OpenStreetMap, free) ----------
const markKnown = (r) => {
  const known = new Set(q.all(`SELECT domain FROM companies WHERE domain IN (${r.results.map((_, i) => ':d' + i).join(',') || "''"})`,
    Object.fromEntries(r.results.map((x, i) => ['d' + i, x.domain]))).map((x) => x.domain));
  return { ...r, results: r.results.map((x) => ({ ...x, known: known.has(x.domain) })) };
};
api.post('/finder/search', h(async (req) => {
  const params = { category: req.body.category, location: String(req.body.location || '').trim(), limit: Math.min(100, Number(req.body.limit) || 40), customTag: req.body.customTag };
  if (!params.location) throw new Error('Enter a city or area, e.g. "Austin, TX"');
  const search = () => osm.findBusinesses({ categoryId: params.category, location: params.location, limit: params.limit, customTag: params.customTag });
  if (!req.body.async) return markKnown(await search());
  // Background search: the page can be left and the result is kept on the job.
  const label = `${osm.CATEGORIES.find((c) => c.id === params.category)?.label || params.customTag || 'Businesses'} in ${params.location}`;
  const { id } = jobs.runJob('finder', `Finding ${label}`, params, async () => { const r = await search(); return { ...r, summary: `${r.results.length} businesses with a website` }; });
  return { jobId: id };
}));
function finderJob(id) {
  const j = jobs.getJob(id);
  if (!j) throw new Error('Search not found');
  return { ...j, result: j.result?.results ? markKnown(j.result) : j.result };
}
api.get('/finder/latest', h(() => {
  const j = q.get("SELECT id FROM jobs WHERE kind = 'finder' ORDER BY id DESC LIMIT 1");
  return j ? finderJob(j.id) : { none: true };
}));
api.get('/finder/job/:id', h((req) => finderJob(Number(req.params.id))));
api.post('/finder/import', h(async (req) => {
  const { results, dead } = await dropDeadSites(req.body.results || []);
  const result = { ...discovery.importLocal(results), deadSkipped: dead };
  jobs.finishJob(jobs.createJob('import', 'Local businesses import', {}), result, `${result.created} new companies added`);
  if (req.body.research && result.createdIds.length && !research.isRunning()) {
    research.runResearch({ ids: result.createdIds }).catch(() => {}); // runs in the background
    result.researchStarted = true;
  }
  return result;
}));

// ---------- Autopilot ----------
api.post('/autopilot/run', h(() => jobs.trackJob('autopilot', "Autopilot: preparing today's emails", {}, (ctx) => outreach.runAutopilot({ actor: 'user', onProgress: ctx.progress })
  .then((r) => ({ ...r, summary: `${r.approved} email(s) approved to send · ${r.aiWritten} written by AI` })))));

// ---------- Background jobs ----------
api.get('/jobs', h((req) => jobs.listJobs(req.query)));
api.get('/jobs/:id', h((req) => { const j = jobs.getJob(Number(req.params.id)); if (!j) throw new Error('Job not found'); return j; }));

// ---------- Lead engine (24/7) ----------
const ENGINE_KEYS = ['engine_enabled', 'engine_categories', 'engine_locations', 'engine_searches_per_hour', 'engine_rescan_days', 'engine_daily_cap',
  'engine_apollo_enabled', 'engine_apollo_keywords', 'engine_apollo_titles'];
api.get('/engine', h(() => engine.status()));
api.put('/engine', h((req) => {
  if (String(req.body.engine_enabled) === '1') {
    const cats = 'engine_categories' in req.body ? req.body.engine_categories : getSetting('engine_categories');
    const locs = 'engine_locations' in req.body ? req.body.engine_locations : getSetting('engine_locations');
    if (!String(cats).trim() || !String(locs).trim()) throw new Error('Choose at least one business type and one city first, then start the engine');
  }
  saveSettings(Object.fromEntries(ENGINE_KEYS.filter((k) => k in req.body).map((k) => [k, req.body[k]])));
  const r = engine.syncTargets();
  logActivity(null, 'engine_saved', { targets: r.targets });
  return { ...engine.status(), synced: r };
}));
api.post('/engine/run', h(() => {
  engine.syncTargets();
  const t = engine.nextTarget() || q.get('SELECT * FROM engine_targets ORDER BY last_run_at ASC LIMIT 1');
  if (!t) throw new Error('Choose at least one business type and one city first');
  if (jobs.runningJob('engine')) throw new Error('A search is already running');
  return { jobId: engine.runTarget(t).jobId };
}));
api.get('/autopilot/status', h(() => ({
  enabled: getBool('autopilot_enabled'), ai: ai.isEnabled(), mode: getSetting('pipeline_mode'),
  inWindow: outreach.inSendWindow(), timezone: getSetting('send_timezone'),
  window: `${getSetting('send_window_start')}:00–${getSetting('send_window_end')}:00`,
})));

// ---------- Phase 11: research runs ----------
api.post('/research/run', h(async (req) => {
  if (req.body?.wait === false) { research.runResearch({ ids: req.body.ids, size: req.body.size }).catch(() => {}); return { started: true }; }
  return research.runResearch({ ids: req.body?.ids, size: req.body?.size });
}));
api.get('/research/progress', h(() => research.progress() || { idle: true }));
api.get('/research/next-batch', h(() => ({ ids: research.nextBatch() })));
api.get('/runs', h((req) => reports.listRuns({ kind: req.query.kind })));
api.get('/reports/daily', h(() => reports.dailySummary()));
api.post('/reports/daily', h(() => reports.saveDailySummary()));

// ---------- Phase 5: suppression ----------
api.get('/suppressions', h((req) => q.all(`SELECT * FROM suppressions ${req.query.search ? 'WHERE value LIKE :s' : ''} ORDER BY id DESC LIMIT 1000`, { s: `%${req.query.search || ''}%` })));
api.post('/suppressions', h((req) => {
  const values = String(req.body.value || '').split(/[\s,;]+/).filter(Boolean);
  const added = values.map((v) => supp.addSuppression({ kind: req.body.kind || (v.includes('@') ? 'email' : 'domain'), value: v, reason: req.body.reason || 'other', note: req.body.note }));
  // Re-evaluate only the companies the new entries affect.
  const affected = new Set();
  for (const v of added) {
    const isEmail = v.includes('@');
    const d = isEmail ? v.split('@')[1] : v;
    const rows = isEmail
      ? q.all('SELECT id FROM companies WHERE contact_email = :v OR domain = :d', { v, d })
      : q.all("SELECT id FROM companies WHERE domain = :d OR domain LIKE :sub OR contact_email LIKE :mail", { d, sub: `%.${d}`, mail: `%@${d}` });
    rows.forEach((r) => affected.add(r.id));
  }
  for (const id of affected) { supp.runDedup(companies.getCompany(id)); companies.reevaluate(id, 'suppression'); }
  return { added, affected: affected.size };
}));
api.delete('/suppressions/:id', h((req) => { supp.removeSuppression(Number(req.params.id)); return { ok: true }; }));

// ---------- Phase 9: outreach ----------
api.get('/outreach/messages', h((req) => outreach.listMessages(req.query)));
api.get('/outreach/quota', h(() => inv.todayStatus()));
api.post('/outreach/drafts', h((req) => outreach.generateDrafts({ limit: req.body?.limit, companyIds: req.body?.companyIds })));
api.post('/outreach/followups', h(() => outreach.generateFollowups()));
api.put('/outreach/messages/:id', h((req) => { outreach.updateDraft(Number(req.params.id), req.body); return { ok: true }; }));
api.post('/outreach/approve', h((req) => outreach.approveMessages(ids(req.body.ids))));
api.post('/outreach/cancel', h((req) => ({ cancelled: outreach.cancelMessages(ids(req.body.ids)) })));
api.post('/outreach/send/:id', h((req) => outreach.sendOne(Number(req.params.id))));
api.get('/outreach/preview/:id', h((req) => {
  const m = q.get('SELECT * FROM messages WHERE id = :id', { id: Number(req.params.id) });
  if (!m) throw new Error('Message not found');
  return { ...m, fullText: `${m.body}\n\n${outreach.footer(m.unsubscribe_token)}`, eligibility: outreach.checkEligibility(m) };
}));

// ---------- Phase 10: replies & pipeline ----------
api.get('/replies', h((req) => replies.listReplies(req.query)));
api.put('/replies/:id', h((req) => { replies.updateReply(Number(req.params.id), req.body); return { ok: true }; }));
api.get('/replies/:id/suggest', h((req) => ({ text: replies.suggestedResponse(Number(req.params.id)) })));
api.post('/mailbox/sync', h(() => jobs.trackJob('mailbox', 'Syncing Hostinger mailbox', {}, async () => {
  const r = await replies.syncMailbox();
  return { ...r, summary: `${r.replies || 0} replies, ${r.bounces || 0} bounces, ${r.optOuts || 0} opt-outs` };
})));
api.get('/opportunities', h(() => replies.listOpportunities()));
api.post('/opportunities', h((req) => replies.upsertOpportunity(req.body)));
api.put('/opportunities/:id', h((req) => replies.upsertOpportunity({ ...req.body, id: Number(req.params.id) })));

// ---------- Phase 7: HubSpot ----------
api.post('/hubspot/test', h(() => hubspot.testConnection()));
api.get('/hubspot/properties', h(() => hubspot.checkProperties()));
api.post('/hubspot/properties/create', h(() => hubspot.createMissingProperties()));
api.post('/hubspot/propose', h(async (req) => {
  let list = ids(req.body.ids || []);
  if (!list.length) list = q.all("SELECT id FROM companies WHERE status IN ('READY','SENT','FOLLOW_UP','REPLIED','BOUNCED','DO_NOT_CONTACT') OR hubspot_id IS NOT NULL ORDER BY updated_at DESC LIMIT 100").map((r) => r.id);
  return sync.proposeSync(list);
}));
api.get('/hubspot/ops', h((req) => sync.listOps(req.query.status)));
api.post('/hubspot/ops/status', h((req) => ({ changed: sync.setOpStatus(ids(req.body.ids), req.body.status) })));
api.post('/hubspot/execute', h(() => sync.executeApproved()));

// ---------- Hostinger mailbox: one test for sending + reading, and a test email to yourself ----------
async function mailboxTest() {
  const capture = getSetting('mail_transport') === 'capture';
  const smtp = await mailer.verifyConnection().catch((e) => ({ ok: false, detail: e.message }));
  if (!smtp.ok) throw new Error(smtp.detail);
  if (capture) return { ok: true, smtp, detail: smtp.detail };
  const box = await imap.testConnection().catch((e) => ({ ok: false, detail: e.message }));
  if (!box.ok) throw new Error(`Sending works, but reading the mailbox failed: ${box.detail}`);
  // First successful connection: read the Sent folder now so nobody you already emailed gets an intro.
  let syncing = false;
  if (!getSetting('imap_last_sync') && !jobs.runningJob('mailbox')) {
    syncing = true;
    jobs.runJob('mailbox', 'Reading your Hostinger Sent folder and inbox', {}, async () => {
      const r = await replies.syncMailbox();
      return { ...r, summary: `${r.sentRecipients} past recipients found · ${r.markedContacted || 0} companies marked as already contacted · ${r.replies} replies` };
    }).promise.catch(() => {});
  }
  return {
    ok: true, smtp, imap: box, syncing,
    detail: `Connected as ${mailer.mailboxUser()} — sending and reading both work.${syncing ? ' Reading your Sent folder now so nobody you already emailed gets a second intro.' : ''}`,
  };
}
api.post('/mailbox/test-email', h(async () => {
  const to = getSetting('sender_email') || mailer.mailboxUser();
  if (!to) throw new Error('Enter your sender email in Settings → Sender & compliance first.');
  if (getSetting('mail_transport') !== 'capture' && !mailer.mailboxPass()) throw new Error('Enter the mailbox password first (Settings → Integrations → Hostinger mailbox), then save.');
  const domain = to.split('@')[1] || 'localhost';
  try {
    await mailer.sendMail({
      from: `"${getSetting('sender_name') || getSetting('sender_company') || 'Lead pipeline'}" <${to}>`,
      to,
      subject: 'Test email from your lead pipeline',
      text: `This is a test from your ${getSetting('sender_company') || ''} lead pipeline.\n\nIf this is in your inbox, sending works. If it landed in spam, check that SPF, DKIM and DMARC are set up in hPanel → Emails → your domain (Settings → Setup guide has a "Check my sending domain" button).\n\nSent ${new Date().toISOString()}`,
      messageId: `<${crypto.randomUUID()}@${domain}>`,
    });
  } catch (e) { throw new Error(mailer.friendlyMailError(e, 'SMTP')); }
  mailer.clearMailError();
  logActivity(null, 'test_email_sent', { to }, 'user');
  return { ok: true, to, detail: `Test email sent to ${to} — check your inbox (and the spam folder).` };
}));

// ---------- Integration tests ----------
api.post('/integrations/:name/test', h(async (req) => {
  switch (req.params.name) {
    case 'hubspot': return hubspot.testConnection();
    case 'apollo': return apollo.testConnection();
    case 'smtp': return mailer.verifyConnection();
    case 'imap': return imap.testConnection();
    case 'mailbox': return mailboxTest();
    case 'ai': return ai.testConnection();
    case 'clay': return { ok: !!getSetting('clay_webhook_secret'), detail: 'Webhook URL: POST /hooks/clay with header x-clay-secret' };
    default: throw new Error('Unknown integration');
  }
}));
api.post('/integrations/clay/secret', h(() => {
  const secret = crypto.randomBytes(18).toString('hex');
  saveSettings({ clay_webhook_secret: secret });
  return { secret };
}));

// ---------- Activity ----------
api.get('/activity', h(() => q.all('SELECT a.*, c.name AS company_name FROM activity a LEFT JOIN companies c ON c.id = a.company_id ORDER BY a.id DESC LIMIT 200')));

// ---------- Test-only hooks (APP_MODE=test) ----------
if (config.testMode) {
  api.post('/test/inbound', h((req) => replies.processInbound(req.body)));
  api.get('/test/captured', h(() => mailer.captured));
  api.post('/test/send-tick', h(() => outreach.autoSendTick()));
  api.post('/test/engine-tick', h((req) => engine.tick({ force: !!req.body?.force })));
  api.post('/test/age-message/:id', h((req) => {
    q.run("UPDATE messages SET sent_at = datetime('now', :d) WHERE id = :id", { d: `-${Number(req.body.days || 5)} days`, id: Number(req.params.id) });
    return { ok: true };
  }));
  api.post('/test/mail-history', h((req) => {
    q.run("INSERT INTO mail_history (direction, folder, uid, email, domain, subject, date) VALUES (:dir, 'Sent', :uid, :email, :domain, 'x', datetime('now'))", {
      dir: req.body.direction || 'out', uid: Math.floor(Math.random() * 1e9), email: req.body.email, domain: req.body.email.split('@')[1],
    });
    return { ok: true };
  }));
}
