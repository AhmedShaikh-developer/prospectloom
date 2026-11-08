// Phase 3/4/5 automated checks for a single company. Only records what it can prove.
import { q, nowIso, today, logActivity } from '../db/index.js';
import { scanWebsite, confirmEmailOnPage } from '../lib/siteScan.js';
import { hasMx, mailAuth, domainState } from '../lib/dns.js';
import { preferenceScore } from '../lib/emailRules.js';
import { emailDomain } from '../lib/normalize.js';
import { getCompany, reevaluate } from './companies.js';
import { runDedup } from './suppression.js';
import { CONTACTED_STATUSES } from '../lib/constants.js';
import * as hubspot from '../integrations/hubspot.js';
import { getSetting, getBool, getNum } from '../lib/settings.js';
import { emailUsable } from '../lib/qualification.js';
import { autoOffer } from '../lib/offers.js';
import { suggestions } from '../lib/personalization.js';

const TRANSIENT = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|timed? ?out|aborted|network/i;
const DAY = 86400_000;
const later = (ms) => new Date(Date.now() + ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scan with retries: DNS/network hiccups are common when many sites are checked at once. */
async function scanWithRetry(target) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const s = await scanWebsite(target);
      if (s.pages.length || s.blocked || s.robotsBlocked || !TRANSIENT.test(s.errors.join(' '))) return s;
      // The domain no longer exists: retrying will not help.
      if (s.dnsFailed && (await domainState(target)) === 'nxdomain') return s;
      lastErr = new Error(s.errors.join('; '));
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(e.message)) throw e;
    }
    await sleep(1500 * (attempt + 1));
  }
  lastErr.transient = true;
  throw lastErr;
}

function patchCompany(id, patch) {
  if (!Object.keys(patch).length) return;
  const sets = Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
  q.run(`UPDATE companies SET ${sets}, updated_at = :__now WHERE id = :__id`, { ...patch, __now: nowIso(), __id: id });
}

/**
 * Run all automated checks. Options: { scan: true, hubspot: true }
 * Returns a per-company log describing every step and its outcome.
 */
export async function verifyCompany(id, { scan = true, useHubspot = true } = {}) {
  let c = getCompany(id);
  if (!c) throw new Error('Company not found');
  const log = [];
  let retrySoon = false;
  let nextScreen = null; // when research should look at this company again (null = normal schedule)
  const before = { status: c.status, filled: countFilled(c) };
  const now = nowIso();

  // 1. Official website scan (fills blanks only, always with the page URL as source)
  if (scan && !CONTACTED_STATUSES.has(c.status)) {
    try {
      const s = await scanWithRetry(c.website || c.domain);
      const patch = { scan_at: now, scan_emails: JSON.stringify(s.emails), scan_facts: JSON.stringify({ ...s.facts, title: s.title, linkedin: s.linkedin }) };
        if (s.pages.length && c.site_status) patchCompany(id, { site_status: null });
      if (s.pages.length) {
        if ((!c.description || !c.profile_url) && s.description) { patch.description = s.description; patch.profile_url = s.pages[0]; log.push('Description taken from site meta description'); }
        else if (!c.description && !s.description) {
          // No meta description: use the site's own title or main headline (still a fact from their homepage).
          const nameLc = String(c.name || '').toLowerCase();
          const fromTitle = String(s.title || '').split(/\s+[|–—-]\s+/).map((x) => x.trim()).find((x) => x.split(/\s+/).length >= 3 && x.toLowerCase() !== nameLc);
          const head = (s.facts?.headings || []).find((h) => h.level <= 2 && h.text.split(/\s+/).length >= 4 && h.text.toLowerCase() !== nameLc);
          const text = fromTitle || head?.text;
          if (text) { patch.description = text.slice(0, 300); patch.profile_url = s.pages[0]; log.push(`Description taken from their homepage ${fromTitle ? 'title' : 'headline'}`); }
        }
        if (!c.us_presence && s.usAddress) { patch.us_presence = `US address: ${s.usAddress.text}`; patch.us_presence_url = s.usAddress.url; log.push(`US address found: ${s.usAddress.text}`); }
        const settings = { allowProviderEmails: getBool('allow_provider_emails') };
        if ((!c.contact_email || !emailUsable(c, settings)) && !c.manual_application_url) {
          const ranked = s.emails.map((e) => ({ ...e, score: preferenceScore(e.email, c.domain) })).filter((e) => e.score > 1).sort((a, b) => b.score - a.score);
          if (ranked.length) {
            const pick = ranked[0];
            if (c.contact_email && c.contact_email !== pick.email) {
              patch.notes = [c.notes, `Imported email ${c.contact_email} (${c.email_evidence_type || 'unverified'}) replaced by the address published on their site`].filter(Boolean).join('\n');
              log.push(`Imported email ${c.contact_email} is not usable — using the published ${pick.email} instead`);
            }
            const isPartner = /^(partner|partners|partnerships|vendors)@/.test(pick.email);
            Object.assign(patch, {
              contact_email: pick.email, email_source_url: pick.url, email_evidence_type: 'official_website',
              email_contact_type: isPartner ? 'partnership' : 'general',
              email_purpose: isPartner ? 'Published partnership/vendor inbox' : 'Published general business inbox on official website',
              email_checked_at: now, email_source_confirmed: 1, email_auto_selected: 1,
            });
            log.push(`Selected published email ${pick.email} from ${pick.url}`);
          } else if (!c.contact_email) log.push(s.emails.length ? `Found ${s.emails.length} email(s) but none suitable for a vendor pitch` : 'No published email found on site');
        }
        log.push(`Scanned ${s.pages.length} page(s)`);
      } else if (s.blocked || s.robotsBlocked) {
        patch.site_status = 'blocked';
        nextScreen = later(30 * DAY);
        log.push(`Website blocks automated visits (${s.robotsBlocked ? 'robots.txt' : 'bot protection'}) — not bypassed. Research it by hand or skip it; checked again in 30 days.`);
      } else {
        const state = await domainState(c.website || c.domain);
        if (state === 'nxdomain') {
          patch.site_status = 'offline';
          log.push('Website offline — the domain no longer exists. Removed from the research queue.');
        } else if (state === 'no_web') {
          patch.site_status = 'no_web';
          nextScreen = later(30 * DAY);
          log.push('The domain exists but has no working website. Checked again in 30 days.');
        } else {
          log.push(`Website unreachable: ${s.errors.join('; ') || 'no pages loaded'}${(c.screen_count || 0) < 3 ? ' — will retry within the hour' : ''}`);
          if ((c.screen_count || 0) < 3) retrySoon = true;
          else nextScreen = later(7 * DAY);
        }
      }
      patchCompany(id, patch);
    } catch (e) {
      log.push(`Website scan failed: ${e.message}${e.transient ? ' — will retry within the hour' : ''}`);
      if (e.transient && (c.screen_count || 0) < 3) retrySoon = true;
      else if (e.transient) nextScreen = later(7 * DAY);
    }
    c = getCompany(id);
  }

  // 1b. Simple mode: pick the offer and a sourced opener automatically (only facts found on their site).
  if (getSetting('pipeline_mode') === 'simple' && !CONTACTED_STATUSES.has(c.status)) {
    const patch = {};
    if (!c.offer) { patch.offer = autoOffer(c); log.push(`Offer ${patch.offer} chosen automatically from the industry/description`); }
    if (!c.personalization) {
      const s = suggestions({ ...c, ...patch })[0];
      if (s) { patch.personalization = s.text; patch.personalization_url = s.source_url; log.push(`Opener chosen from their site (${s.kind}): ${s.source_url}`); }
    }
    patchCompany(id, patch);
    c = getCompany(id);
  }

  // 2. Confirm the recorded email appears on its stated source page
  if (c.contact_email && c.email_source_url && c.email_source_confirmed !== 1 && !c.email_manual_confirmed) {
    try {
      const r = await confirmEmailOnPage(c.contact_email, c.email_source_url);
      if (r.confirmed !== null) patchCompany(id, { email_source_confirmed: r.confirmed ? 1 : 0, email_checked_at: now });
      log.push(r.detail);
    } catch (e) { log.push(`Source confirmation failed: ${e.message}`); }
    c = getCompany(id);
  }

  // 3. MX record for the email domain (zero-credit)
  if (c.contact_email) {
    const mx = await hasMx(emailDomain(c.contact_email));
    if (mx.ok !== null) patchCompany(id, { mx_valid: mx.ok ? 1 : 0, mx_checked_at: now });
    log.push(`MX: ${mx.detail}`);
    try {
      const auth = await mailAuth(emailDomain(c.contact_email));
      patchCompany(id, { mail_auth: JSON.stringify(auth) });
      log.push(`Mail auth: SPF ${auth.spf ? 'yes' : 'no'}, DMARC ${auth.dmarc ? 'yes' : 'no'}`);
    } catch { /* informational only */ }
    c = getCompany(id);
  }

  // 4. HubSpot duplicate / stage lookup (read-only)
  if (useHubspot && hubspot.isConfigured()) {
    try {
      const hs = await hubspot.findCompanyByDomain(c.domain);
      if (hs) {
        patchCompany(id, { hubspot_id: hs.id, hubspot_stage: hs.properties.ll_outreach_stage || null, hubspot_checked_at: now });
        log.push(`HubSpot: existing company ${hs.id} (stage: ${hs.properties.ll_outreach_stage || 'none'})`);
      } else {
        patchCompany(id, { hubspot_checked_at: now });
        log.push('HubSpot: no existing company with this domain');
      }
      if (c.contact_email) {
        const contact = await hubspot.findContactByEmail(c.contact_email);
        if (contact) log.push(`HubSpot: contact ${contact.id} already exists for ${c.contact_email}`);
      }
    } catch (e) { log.push(`HubSpot lookup failed: ${e.message}`); }
    c = getCompany(id);
  }

  // 5. Dedup + suppression
  const conflicts = runDedup(c);
  log.push(conflicts.length ? `Conflicts: ${conflicts.map((x) => x.detail).join('; ')}` : 'Dedup/suppression: clear');

  // 6. Decision engine
  const after = reevaluate(id, 'automation');
  const progressed = after.status !== before.status || countFilled(after) > before.filled;
  const end = nowIso();
  // A temporary network failure re-queues the company in about an hour. Companies that keep making no
  // progress (e.g. no email published on their site) are re-checked every 14 days instead of daily.
  if (retrySoon) nextScreen = later(3600_000);
  else if (!nextScreen && !progressed && (c.screen_count || 0) >= 2 && ['RESEARCHING', 'HOLD_VERIFY'].includes(after.status)) nextScreen = later(14 * DAY);
  q.run(`UPDATE companies SET last_screened_at = :end, next_screen_at = :next, screen_count = screen_count + 1 ${progressed ? ', last_progress_at = :end' : ''} WHERE id = :id`, { end, next: nextScreen, id });
  logActivity(id, 'verified', { log, status: after.status }, 'automation');
  return { id, name: after.name, domain: after.domain, before: before.status, after: after.status, progressed, log, evaluation: after.evaluation, date: today() };
}

function countFilled(c) {
  return ['us_presence', 'description', 'industry', 'employee_count', 'dm_name', 'portfolio_url', 'personalization', 'contact_email', 'email_source_confirmed', 'mx_valid', 'fit_score']
    .filter((k) => c[k] !== null && c[k] !== '' && c[k] !== undefined).length;
}
