// Phase 4: contact-channel suitability rules.
import { normalizeEmail, emailLocalPart, emailDomain, rootDomain } from './normalize.js';
import { BLOCKED_LOCAL_PARTS, WARN_LOCAL_PARTS, PREFERRED_LOCAL_PARTS, ACCEPTED_EVIDENCE } from './constants.js';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com']);

function baseLocal(local) {
  // "support-team", "support.us", "support+x" -> "support"
  return local.split('+')[0].split(/[._-]/)[0];
}

/**
 * Classify an email address for unsolicited B2B vendor outreach.
 * Returns { ok, blocked, warnings[], reason }.
 */
export function assessEmail(email, companyDomain) {
  const e = normalizeEmail(email);
  const result = { email: e, ok: false, blocked: false, warnings: [], reason: '' };
  if (!e) { result.blocked = true; result.reason = 'Invalid email address'; return result; }
  const local = emailLocalPart(e);
  const base = baseLocal(local);
  if (BLOCKED_LOCAL_PARTS.includes(local) || BLOCKED_LOCAL_PARTS.includes(base)) {
    result.blocked = true;
    result.reason = `"${local}@" is a support/privacy/billing/system inbox — not acceptable for a vendor pitch`;
    return result;
  }
  if (WARN_LOCAL_PARTS.includes(local) || WARN_LOCAL_PARTS.includes(base)) {
    result.warnings.push(`"${local}@" usually serves the company's own customers; confirm it's an appropriate business channel`);
  }
  const d = emailDomain(e);
  if (FREE_MAIL.has(d)) result.warnings.push('Free-mail address; confirm it is the published business contact');
  else if (companyDomain && rootDomain(d) !== rootDomain(companyDomain)) {
    result.warnings.push(`Email domain (${d}) differs from company domain (${companyDomain})`);
  }
  result.ok = true;
  return result;
}

/** Score a scanned email for auto-selection. Higher is better; -1 = unusable. */
export function preferenceScore(email, companyDomain) {
  const a = assessEmail(email, companyDomain);
  if (a.blocked) return -1;
  const local = emailLocalPart(a.email);
  if (companyDomain && rootDomain(emailDomain(a.email)) !== rootDomain(companyDomain)) return -1;
  if (a.warnings.length) return 1;
  const idx = PREFERRED_LOCAL_PARTS.indexOf(local);
  if (idx >= 0) return 100 - idx;
  return 10; // a named person or other non-role inbox published on the site
}

export function isAcceptedEvidence(type) {
  return ACCEPTED_EVIDENCE.has(type);
}

/**
 * Heuristic flag: looks like firstname@ / first.last@ for the decision-maker but
 * the record has no published source. Guessing addresses is forbidden.
 */
export function looksGuessed(email, dmName, sourceUrl) {
  if (sourceUrl) return false;
  const local = emailLocalPart(email);
  if (!local || !dmName) return false;
  const parts = String(dmName).toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const [first, last = ''] = [parts[0], parts[parts.length - 1]];
  const patterns = [first, `${first}.${last}`, `${first}${last}`, `${first[0]}${last}`, `${first}_${last}`, `${first[0]}.${last}`];
  return patterns.includes(local);
}

export function extractEmails(text) {
  if (!text) return [];
  const found = new Set();
  const decoded = String(text)
    .replace(/\s*(?:&#64;|&#x40;|\[at\]|\(at\)|\{at\})\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi, '.');
  const re = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
  for (const m of decoded.matchAll(re)) {
    const e = normalizeEmail(m[0]);
    if (e && !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !e.includes('example.com') && !/sentry|wixpress|cloudflare/.test(e)) found.add(e);
  }
  return [...found];
}
