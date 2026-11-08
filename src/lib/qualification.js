// Phase 6: qualification decision engine (pure function; no I/O).
import { STATUS, CONTACTED_STATUSES, TERMINAL_STATUSES, PROVIDER_EVIDENCE } from './constants.js';
import { isValidUrl, emailDomain, rootDomain } from './normalize.js';
import { assessEmail, isAcceptedEvidence, looksGuessed } from './emailRules.js';

const DAY = 86_400_000;
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const ageDays = (iso, now) => (iso ? (now - new Date(iso).getTime()) / DAY : Infinity);

/** Phase 3 checklist. Each item: [key, label, passes(company)] */
export const RESEARCH_CHECKS = [
  ['name', 'Canonical company name', (c) => !isBlank(c.name)],
  ['domain', 'Canonical website domain', (c) => !isBlank(c.domain)],
  ['us_presence', 'US presence with source URL', (c) => !isBlank(c.us_presence) && isValidUrl(c.us_presence_url)],
  ['industry', 'Industry', (c) => !isBlank(c.industry)],
  ['description', 'Services / description with source URL', (c) => !isBlank(c.description) && isValidUrl(c.profile_url)],
  ['employees', 'Employee count with dated source', (c) => Number(c.employee_count) > 0 && isValidUrl(c.employee_count_url) && !isBlank(c.employee_count_date)],
  ['decision_maker', 'Named decision-maker with title + source (human-confirmed current)', (c) => !isBlank(c.dm_name) && !isBlank(c.dm_title) && isValidUrl(c.dm_url) && Number(c.dm_verified) === 1],
  ['portfolio', 'Portfolio / case study / observable workflow URL', (c) => isValidUrl(c.portfolio_url)],
  ['personalization', 'Company-specific personalization with source', (c) => !isBlank(c.personalization) && String(c.personalization).trim().length >= 20 && isValidUrl(c.personalization_url)],
  ['offer', 'Offer selected (A, B or C)', (c) => ['A', 'B', 'C'].includes(c.offer)],
  ['lead_origin', 'Lead origin', (c) => !isBlank(c.lead_origin)],
  ['fit_score', 'Fit score (1–10) with rationale', (c) => Number(c.fit_score) >= 1 && Number(c.fit_score) <= 10 && !isBlank(c.fit_rationale)],
];

/** A provider/list email may be used only when allowed in Settings and it belongs to the company's own domain. */
export function providerEmailAllowed(c, settings = {}) {
  return !!(settings.allowProviderEmails && c.contact_email && PROVIDER_EVIDENCE.has(c.email_evidence_type)
    && rootDomain(emailDomain(c.contact_email)) === rootDomain(c.domain || ''));
}

/** True when the recorded email can be used as-is (so research should not replace it). */
export function emailUsable(c, settings = {}) {
  return !!c.contact_email && (isAcceptedEvidence(c.email_evidence_type) || c.email_source_confirmed === 1 || c.email_manual_confirmed === 1 || providerEmailAllowed(c, settings));
}

/**
 * Simple mode: what an automated run can prove from the company's own website. A named
 * decision-maker is optional (emails then greet "Hi there"); nothing is ever invented.
 */
export const SIMPLE_CHECKS = [
  ['name', 'Company name', (c) => !isBlank(c.name)],
  ['domain', 'Website domain', (c) => !isBlank(c.domain)],
  ['description', 'What they do (from their website or your imported research)', (c) => !isBlank(c.description) && (isValidUrl(c.profile_url) || /^(csv|clay|apollo)/.test(c.lead_origin || ''))],
  ['personalization', 'Personal opener from a fact on their site (with source)', (c) => !isBlank(c.personalization) && String(c.personalization).trim().length >= 20 && isValidUrl(c.personalization_url)],
  ['offer', 'Offer selected (A, B or C)', (c) => ['A', 'B', 'C'].includes(c.offer)],
];

/**
 * Evaluate a company.
 * ctx: { conflicts: [{type, detail, hard}], compliance: {ok, missing[]}, settings: {emailRecheckDays, dedupRecheckDays}, now }
 * Returns { status, reason, research: [{key,label,ok}], clearance: [{key,label,ok,detail}], missing[], warnings[], researchComplete }
 */
export function evaluate(company, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const emailRecheckDays = ctx.settings?.emailRecheckDays ?? 90;
  const dedupRecheckDays = ctx.settings?.dedupRecheckDays ?? 30;
  const conflicts = ctx.conflicts ?? [];
  const warnings = [];

  const checks = ctx.settings?.mode === 'simple' ? SIMPLE_CHECKS : RESEARCH_CHECKS;
  const research = checks.map(([key, label, fn]) => ({ key, label, ok: !!fn(company) }));
  const researchComplete = research.every((r) => r.ok);

  const clearance = [];
  const add = (key, label, ok, detail = '') => clearance.push({ key, label, ok: !!ok, detail });

  const email = company.contact_email;
  const assessment = email ? assessEmail(email, company.domain) : null;
  if (assessment) warnings.push(...assessment.warnings);
  const provider = providerEmailAllowed(company, ctx.settings);
  if (provider) warnings.push('Email comes from a data provider / your list — the mailbox itself is not validated; bounces are tracked and pause sending');
  const viaList = 'from your imported list / provider (allowed in Settings)';
  add('email_present', 'Contact email recorded', !isBlank(email));
  add('email_source', 'Email source recorded', provider || isValidUrl(company.email_source_url), provider ? viaList : '');
  add('email_evidence', 'Accepted evidence type', provider || isAcceptedEvidence(company.email_evidence_type),
    company.email_evidence_type ? `evidence: ${company.email_evidence_type}${PROVIDER_EVIDENCE.has(company.email_evidence_type) && !provider ? ' — turn on “Email addresses from Clay/Apollo/CSV” in Settings to use it' : ''}` : '');
  add('email_role', 'Suitable inbox (not support/privacy/billing)', assessment ? !assessment.blocked : false, assessment?.reason || '');
  add('email_not_guessed', 'Not a guessed address', !(email && (company.email_evidence_type === 'pattern_guess' || (!provider && looksGuessed(email, company.dm_name, company.email_source_url)))));
  add('email_confirmed', 'Email confirmed at its source',
    provider || company.email_source_confirmed === 1 || company.email_manual_confirmed === 1,
    provider ? viaList : company.email_source_confirmed === 0 && !company.email_manual_confirmed ? 'NOT found on the source page' : '');
  add('email_purpose', 'Contact purpose recorded', !isBlank(company.email_purpose) && !isBlank(company.email_contact_type));
  add('email_fresh', `Email checked within ${emailRecheckDays} days`, ageDays(company.email_checked_at, now) <= emailRecheckDays);
  add('mx', 'Email domain accepts mail (MX record)', company.mx_valid === 1,
    company.mx_valid === 0 ? 'No MX record — domain cannot receive mail' : company.mx_valid == null ? 'MX not checked yet' : '');
  add('dedup', `Dedup & suppression checked within ${dedupRecheckDays} days`, ageDays(company.dedup_checked_at, now) <= dedupRecheckDays);
  const hardConflicts = conflicts.filter((c) => c.hard);
  add('no_conflicts', 'No duplicate / suppression / prior-contact conflicts', hardConflicts.length === 0,
    hardConflicts.map((c) => c.detail).join('; '));
  if (ctx.compliance) add('compliance', 'Commercial-email requirements configured', ctx.compliance.ok, (ctx.compliance.missing || []).join(', '));

  const missing = [
    ...research.filter((r) => !r.ok).map((r) => r.label),
    ...clearance.filter((c) => !c.ok).map((c) => c.label + (c.detail ? ` (${c.detail})` : '')),
  ];
  const clearanceOk = clearance.every((c) => c.ok);

  // --- Decide status -----------------------------------------------------
  const current = company.status;
  const optOut = conflicts.find((c) => c.type === 'opt_out' || c.type === 'complaint' || c.type === 'do_not_contact');
  let status; let reason;

  if (TERMINAL_STATUSES.has(current) && company.status_locked) {
    status = current; reason = company.status_reason || 'Marked do-not-contact';
  } else if (optOut) {
    status = STATUS.DO_NOT_CONTACT; reason = optOut.detail;
  } else if (CONTACTED_STATUSES.has(current)) {
    status = current; reason = company.status_reason || 'Already contacted — lifecycle status preserved';
  } else if (conflicts.some((c) => c.type === 'previously_contacted')) {
    status = STATUS.SENT; reason = conflicts.find((c) => c.type === 'previously_contacted').detail;
  } else if (company.site_status === 'offline') {
    status = STATUS.EXCLUDED; reason = 'Website offline — the domain no longer exists';
  } else if (company.fit_score != null && company.fit_score !== '' && Number(company.fit_score) < 6) {
    status = STATUS.EXCLUDED; reason = `Fit score ${company.fit_score} is below 6`;
  } else if (conflicts.some((c) => c.type === 'competitor')) {
    status = STATUS.EXCLUDED; reason = 'Competitor / excluded company';
  } else if (current === STATUS.EXCLUDED && company.status_locked) {
    status = current; reason = company.status_reason;
  } else if (!isBlank(company.manual_application_url) && isBlank(email)) {
    status = STATUS.MANUAL_APPLICATION; reason = 'Vendor/partnership application form must be submitted by a human';
  } else if (!researchComplete) {
    const gaps = research.filter((r) => !r.ok);
    status = STATUS.RESEARCHING; reason = `Still needed: ${gaps.slice(0, 2).map((r) => r.label.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}${gaps.length > 2 ? ` +${gaps.length - 2} more` : ''}`;
  } else if (!clearanceOk) {
    status = STATUS.HOLD_VERIFY;
    const fails = clearance.filter((c) => !c.ok);
    reason = isBlank(email)
      ? 'No usable email yet — research looks for one published on their website'
      : `${fails[0].label}${fails[0].detail ? ` (${fails[0].detail})` : ''}${fails.length > 1 ? ` · +${fails.length - 1} more check${fails.length > 2 ? 's' : ''}` : ''}`;
  } else {
    status = STATUS.READY; reason = 'All research, contact, dedup, suppression and compliance checks passed';
  }
  // Say plainly when the website itself is the problem.
  if ([STATUS.RESEARCHING, STATUS.HOLD_VERIFY].includes(status)) {
    if (company.site_status === 'blocked') reason = 'Website blocks automated visits (bot protection) — research it by hand or skip it';
    else if (company.site_status === 'no_web') reason = 'The domain has no working website — check the address or skip it';
  }

  return { status, reason, research, clearance, missing, warnings, researchComplete, conflicts };
}
