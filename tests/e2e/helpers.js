import { expect } from '@playwright/test';

export const MOCK = 'http://127.0.0.1:4501';
export const SITE = { acme: 'http://127.0.0.1:4511', pixel: 'http://127.0.0.1:4512', northwind: 'http://127.0.0.1:4513', quiet: 'http://127.0.0.1:4514', blocked: 'http://127.0.0.1:4515', cafe: 'http://127.0.0.1:4516' };

export const COMPLIANCE = {
  sender_name: 'Alex Rivera',
  sender_title: 'Founder',
  sender_email: 'alex@localhostlabs.dev',
  sender_company: 'Localhost Labs',
  sender_postal_address: '1 Test Plaza, Suite 100, Wilmington, DE 19801',
  unsubscribe_text: 'Reply "unsubscribe" and I will not contact you again.',
};

export async function api(request, method, path, data) {
  const res = await request.fetch(path.startsWith('http') ? path : `/api${path}`, { method, data });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${JSON.stringify(body)}`);
  return body;
}

export async function ensureCompliance(request) {
  await api(request, 'PUT', '/settings', COMPLIANCE);
}

let seq = 0;
/** All Phase 3 facts with sources, human-confirmed decision-maker. */
export function researchFacts(overrides = {}) {
  seq++;
  return {
    offer: 'A',
    lead_origin: 'manual',
    us_presence: 'HQ: 120 Main St, Austin, TX 78701',
    us_presence_url: 'https://example.org/about',
    industry: 'Logistics',
    services: 'Freight, warehousing',
    description: 'Regional LTL carrier with dedicated fleet services.',
    profile_url: 'https://example.org/',
    employee_count: 85,
    employee_count_url: 'https://www.linkedin.com/company/example',
    employee_count_date: '2026-11-01',
    dm_name: `Jordan Lee ${seq}`,
    dm_title: 'COO',
    dm_url: 'https://www.linkedin.com/in/jordan-lee',
    dm_verified: 1,
    portfolio_url: 'https://example.org/services',
    personalization: 'Saw that you launched a dedicated-fleet service for Oklahoma retailers this quarter.',
    personalization_url: 'https://example.org/news',
    fit_score: 8,
    fit_rationale: 'Dispatch + customer portal are manual; strong Offer A fit',
    ...overrides,
  };
}

/**
 * Create a fully evidenced company and run the automated checks (no scan).
 * Uses a human-confirmed email so each test company can have its own domain.
 */
export async function createReadyCompany(request, name, overrides = {}) {
  const domain = overrides.domain || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.com`;
  const r = await api(request, 'POST', '/companies', {
    name,
    domain,
    website: `https://${domain}`,
    contact_email: `hello@${domain}`,
    email_source_url: `https://${domain}/contact`,
    email_evidence_type: 'official_website',
    email_contact_type: 'general',
    email_purpose: 'General business inbox on official website',
    email_manual_confirmed: 1,
    ...researchFacts(overrides),
    ...overrides,
  });
  const v = await api(request, 'POST', `/companies/${r.company.id}/verify`, { scan: false });
  return { id: r.company.id, domain, status: v.after, verify: v };
}

export async function expectToast(page, text) {
  await expect(page.getByTestId('toast').filter({ hasText: text }).first()).toBeVisible();
}

export async function noErrorToast(page) {
  await expect(page.getByTestId('toast-error')).toHaveCount(0);
}

/** Fail the test on uncaught page errors / console errors. */
export function watchConsole(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
