// Phase 2: lead discovery / import from CSV (generic, Clay, Apollo), Clay webhook,
// pasted domain lists, Apollo search and HubSpot. Dedups by normalized domain.
import { parse } from 'csv-parse/sync';
import { q, nowIso, logActivity } from '../db/index.js';
import { upsertCompany } from './companies.js';
import { normalizeDomain } from '../lib/normalize.js';

// Header aliases -> internal field. Lower-cased, non-alphanumerics stripped.
const ALIASES = {
  name: ['name', 'company', 'companyname', 'organization', 'organizationname', 'account', 'accountname', 'agencyname', 'businessname'],
  domain: ['domain', 'companydomain', 'primarydomain', 'websitedomain', 'organizationdomain', 'rootdomain'],
  website: ['website', 'websiteurl', 'companywebsite', 'url', 'homepage', 'organizationwebsiteurl'],
  industry: ['industry', 'companyindustry', 'organizationindustry', 'agencytype', 'category'],
  description: ['description', 'companydescription', 'shortdescription', 'about'],
  services: ['services', 'keywords', 'specialties', 'coreservices'],
  employee_count: ['employees', 'employeecount', 'numberofemployees', 'companysize', 'estimatednumemployees', 'headcount', 'organizationnumemployees', 'employeecountestimate'],
  employee_count_url: ['employeecountsource', 'employeesource', 'companylinkedinurl', 'linkedincompanyurl', 'companylinkedin'],
  dm_name: ['decisionmaker', 'fullname', 'contactname', 'personname', 'decisionmakername'],
  dm_first: ['firstname', 'first'],
  dm_last: ['lastname', 'last'],
  dm_title: ['title', 'jobtitle', 'decisionmakertitle', 'persontitle'],
  dm_url: ['personlinkedinurl', 'linkedinurl', 'linkedin', 'profileurl', 'decisionmakerurl', 'decisionmakerlinkedinurl'],
  contact_email: ['email', 'workemail', 'contactemail', 'publicemail', 'emailaddress', 'decisionmakerprofessionalemail', 'professionalemail', 'decisionmakeremail'],
  generic_email: ['genericagencyemail', 'genericcompanyemail', 'genericemail', 'companyemail', 'generalemail', 'infoemail'],
  email_status: ['emailverificationstatus', 'emailstatus', 'emailverification'],
  phone: ['phone', 'phonenumber', 'businessphone', 'businessphoneifpublic', 'publicbusinessphoneifavailable', 'companyphone'],
  email_source_url: ['emailsource', 'emailsourceurl', 'sourceurl'],
  us_presence: ['location', 'hq', 'headquarters', 'companyaddress', 'address'],
  city: ['city', 'companycity', 'headquarterscity'],
  state: ['state', 'companystate', 'region', 'headquartersstate'],
  country: ['country', 'companycountry'],
  offer: ['offer'],
  portfolio_url: ['portfolio', 'portfoliourl', 'casestudy', 'casestudyurl', 'portfoliocasestudyurl'],
  portfolio_note: ['personalizationangle', 'portfolionote'],
  personalization: ['personalization', 'personalisation', 'icebreaker', 'suggestedoutreachhook', 'suggestedpartnershipoutreachhook', 'outreachhook', 'opener'],
  personalization_url: ['personalizationurl', 'personalizationsource', 'primaryevidenceurl'],
  fit_score: ['leadscore110', 'leadscore10', 'leadscore', 'fitscore', 'score'],
  fit_rationale: ['whylocalhostlabsfits', 'whythisagencyisagoodpartner', 'fitrationale'],
  notes: ['notes', 'note', 'researchnotes'],
};

const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectMapping(headers) {
  const map = {};
  for (const h of headers) {
    const k = key(h);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(k) && !Object.values(map).includes(field)) { map[h] = field; break; }
    }
  }
  return map;
}

export function detectSource(headers) {
  const ks = headers.map(key);
  if (ks.includes('apolloaccountid') || ks.includes('apollocontactid') || (ks.includes('emailstatus') && ks.includes('seniority'))) return 'apollo';
  if (ks.some((k) => k.startsWith('clay')) || ks.includes('findcompanieswithclay')) return 'clay';
  return 'csv';
}

function rowToCompany(row, mapping) {
  const out = {};
  for (const [header, field] of Object.entries(mapping)) {
    const v = row[header];
    if (v !== undefined && String(v).trim() !== '') out[field] = String(v).trim();
  }
  if (!out.dm_name && (out.dm_first || out.dm_last)) out.dm_name = [out.dm_first, out.dm_last].filter(Boolean).join(' ');
  delete out.dm_first; delete out.dm_last;
  // Email: the decision-maker's own address first, else a generic company inbox. Addresses a
  // provider marked as invalid/bounced are not used.
  const status = out.email_status || ''; delete out.email_status;
  if (out.contact_email && /invalid|bounce|undeliverable|do not use/i.test(status)) delete out.contact_email;
  if (out.contact_email) {
    out.email_contact_type = out.dm_name ? 'decision_maker' : 'general';
    out.email_purpose = out.dm_name ? `Decision-maker work email from imported list${status ? ` (${status.slice(0, 80)})` : ''}` : 'Company email from imported list';
  } else if (out.generic_email) {
    out.contact_email = out.generic_email; out.email_contact_type = 'general'; out.email_purpose = 'Generic company inbox from imported list';
  }
  delete out.generic_email;
  if (out.phone) { out.notes = [out.notes, `Phone: ${out.phone}`].filter(Boolean).join('\n'); delete out.phone; }
  if (out.fit_score && !/^\d+(\.\d+)?$/.test(String(out.fit_score).trim())) delete out.fit_score;
  if (out.personalization && !out.personalization_url) delete out.personalization; // openers need a source
  if (out.portfolio_note && !out.portfolio_url && out.personalization_url) out.portfolio_url = out.personalization_url;
  const loc = [out.city, out.state, out.country].filter(Boolean).join(', ');
  if (!out.us_presence && loc) out.us_presence = loc;
  // Location strings from imports are hints, not evidence: no source URL is set,
  // so the "US presence" check still requires verification.
  delete out.city; delete out.state; delete out.country;
  if (out.employee_count) {
    // "11-50" -> keep the upper bound as an approximate count; note it.
    const m = String(out.employee_count).match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
    if (m) out.employee_count = m[2].replace(/,/g, '');
  }
  return out;
}

function startRun(kind) {
  const res = q.run("INSERT INTO runs (kind, started_at, status) VALUES (:kind, :now, 'running')", { kind, now: nowIso() });
  return Number(res.lastInsertRowid);
}
function finishRun(id, stats, report, status = 'ok') {
  q.run('UPDATE runs SET finished_at = :now, status = :status, stats = :stats, report = :report WHERE id = :id', {
    now: nowIso(), status, stats: JSON.stringify(stats), report, id,
  });
}

/** Import an array of company-like objects. */
export function importRecords(records, { origin = 'csv', label = 'Import' } = {}) {
  const runId = startRun('import');
  const stats = { origin, received: records.length, created: 0, merged: 0, skipped: 0, duplicatesInFile: 0, createdIds: [], skippedReasons: {} };
  const seen = new Set();
  for (const r of records) {
    const d = normalizeDomain(r.domain || r.website || (r.contact_email ? String(r.contact_email).split('@')[1] : ''));
    if (d && seen.has(d)) { stats.duplicatesInFile++; continue; }
    if (d) seen.add(d);
    const res = upsertCompany(r, { origin, actor: 'import' });
    if (res.skipped) { stats.skipped++; stats.skippedReasons[res.reason] = (stats.skippedReasons[res.reason] || 0) + 1; }
    else if (res.created) { stats.created++; stats.createdIds.push(res.company.id); }
    else stats.merged++;
  }
  const report = `${label} (${origin}): ${stats.received} rows → ${stats.created} new, ${stats.merged} existing (merged blanks only), ${stats.duplicatesInFile} duplicate rows in file, ${stats.skipped} skipped.`;
  finishRun(runId, { ...stats, createdIds: stats.createdIds.slice(0, 500) }, report);
  logActivity(null, 'import', report, 'user');
  return { ...stats, report, runId };
}

export function importCsv(text, { source, mapping, label, leadOrigin } = {}) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const origin = source && source !== 'auto' ? source : detectSource(headers);
  const map = mapping && Object.keys(mapping).length ? mapping : detectMapping(headers);
  if (!Object.values(map).some((f) => ['domain', 'website', 'contact_email'].includes(f))) {
    throw new Error(`CSV needs a domain, website or email column. Detected columns: ${headers.join(', ')}`);
  }
  const records = rows.map((r) => ({ ...rowToCompany(r, map), ...(leadOrigin ? { lead_origin: leadOrigin } : {}) }));
  const result = importRecords(records, { origin, label: label || 'CSV import' });
  return { ...result, mapping: map, headers };
}

export function previewCsv(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true, to: 6 });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, source: detectSource(headers), mapping: detectMapping(headers), sample: rows.slice(0, 5) };
}

export function importDomainList(text, { offer, origin = 'manual' } = {}) {
  const records = String(text).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).map((d) => ({ domain: d, offer }));
  return importRecords(records, { origin, label: 'Domain list' });
}

/** Clay "HTTP API" column → POST rows here. Accepts one row or { rows: [...] }. */
export function handleClayWebhook(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : [body];
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const map = detectMapping(headers);
  return importRecords(rows.map((r) => rowToCompany(r, map)), { origin: 'clay', label: 'Clay webhook' });
}

/** Import businesses picked from the OpenStreetMap finder. Location carries the OSM page as its source. */
export function importLocal(results) {
  const records = (results || []).map((r) => ({
    name: r.name, website: r.website, domain: r.domain, industry: r.category, offer: r.offer,
    us_presence: r.address ? `Address: ${r.address}` : undefined, us_presence_url: r.address ? r.osm_url : undefined,
    notes: [r.phone && `Phone: ${r.phone}`, `Found on OpenStreetMap: ${r.osm_url}`].filter(Boolean).join('\n'),
  }));
  return importRecords(records, { origin: 'openstreetmap', label: 'Local business finder' });
}

// ---------------------------------------------------------------- watched "leads csv" folder
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { getSetting } from '../lib/settings.js';
import { extractEmails } from '../lib/emailRules.js';
import { normalizeEmail, emailDomain } from '../lib/normalize.js';

export function leadsFolder() {
  const dir = path.resolve(ROOT, getSetting('leads_folder') || 'leads csv');
  if (!dir.startsWith(ROOT)) throw new Error('The leads folder must be inside the app folder');
  return dir;
}

/** CSV files in the leads folder, with whether each was imported (and is unchanged since). */
export function folderFiles() {
  const dir = leadsFolder();
  if (!fs.existsSync(dir)) return { dir, files: [] };
  const files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f)).sort().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    const row = q.get('SELECT * FROM import_files WHERE path = :p', { p: f });
    const changed = !row || row.size !== st.size || row.mtime !== st.mtime.toISOString();
    return { file: f, size: st.size, modified: st.mtime.toISOString(), importedAt: row?.imported_at || null, changed, stats: row ? JSON.parse(row.stats || '{}') : null };
  });
  return { dir, files };
}

/** Import new or changed CSV files from the leads folder. */
export function importFolder({ all = false, onProgress } = {}) {
  const { dir, files } = folderFiles();
  const todo = files.filter((f) => all || f.changed);
  const out = [];
  todo.forEach((f, i) => {
    onProgress?.(i, todo.length, `Importing ${f.file}`);
    try {
      const r = importCsv(fs.readFileSync(path.join(dir, f.file), 'utf8'), { source: 'auto', label: `Folder: ${f.file}`, leadOrigin: `csv: ${f.file}` });
      const stats = { received: r.received, created: r.created, merged: r.merged, skipped: r.skipped };
      q.run('INSERT OR REPLACE INTO import_files (path, size, mtime, imported_at, stats) VALUES (:p, :size, :mtime, :now, :stats)',
        { p: f.file, size: f.size, mtime: f.modified, now: nowIso(), stats: JSON.stringify(stats) });
      out.push({ file: f.file, ...stats });
    } catch (e) { out.push({ file: f.file, error: e.message }); }
  });
  const created = out.reduce((a, x) => a + (x.created || 0), 0);
  return { files: out, created, summary: todo.length ? `${todo.length} file(s): ${created} new companies` : 'No new or changed files' };
}

/**
 * Record people/companies you already emailed from other tools (or before this app), so they
 * are never introduced again. Accepts any text: emails and/or domains.
 */
export function importContactHistory(text, { note = 'Imported contact history' } = {}) {
  const emails = [...new Set(extractEmails(String(text)).map(normalizeEmail).filter(Boolean))];
  const rest = String(text).replace(/[^\s,;]+@[^\s,;]+/g, ' ');
  const domains = [...new Set(rest.split(/[\s,;]+/).map((d) => normalizeDomain(d)).filter(Boolean))];
  const now = nowIso();
  const ins = (e, d) => q.run("INSERT OR IGNORE INTO mail_history (direction, folder, uid, email, domain, subject, date) VALUES ('out', 'Imported history', 0, :e, :d, :note, :now)", { e, d, note, now });
  for (const e of emails) ins(e, emailDomain(e));
  for (const d of domains) ins(`@${d}`, d); // whole company/domain already contacted
  return { emails: emails.length, domains: domains.length, emailList: emails, domainList: domains };
}
