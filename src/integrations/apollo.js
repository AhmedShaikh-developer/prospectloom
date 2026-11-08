// Apollo: read-only. Default route is CSV export import (services/discovery.js).
// The API search is OFF by default (Settings → apollo_api_search_enabled) and uses
// only the people search endpoint that Apollo documents as not consuming credits,
// which never returns email addresses. Never call enrichment/reveal endpoints.
import { getSetting, getBool } from '../lib/settings.js';

export function isConfigured() {
  return !!getSetting('apollo_api_key');
}

async function call(method, path, body) {
  const key = getSetting('apollo_api_key');
  if (!key) throw new Error('Apollo API key not configured');
  const base = getSetting('apollo_base_url').replace(/\/$/, '');
  const res = await fetch(base + path, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json', 'cache-control': 'no-cache' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Apollo ${path} → ${res.status}: ${data.error || data.message || text.slice(0, 200)}`);
  return data;
}

export async function testConnection() {
  const data = await call('GET', '/v1/auth/health');
  return { ok: data.is_logged_in !== false, detail: data };
}

/**
 * Search people (no credits, no emails). Returns company candidates with the
 * person as a *candidate* decision-maker — still requires public verification.
 */
export async function searchPeople({ titles = [], locations = ['United States'], employeeRanges = [], keywords = '', page = 1, perPage = 25 }) {
  if (!getBool('apollo_api_search_enabled')) throw new Error('Apollo API search is disabled in Settings (credit protection). Use CSV export import instead.');
  const body = {
    person_titles: titles,
    person_locations: locations,
    organization_num_employees_ranges: employeeRanges,
    q_keywords: keywords || undefined,
    page,
    per_page: Math.min(perPage, 100),
  };
  const data = await call('POST', '/api/v1/mixed_people/api_search', body);
  const people = data.people || [];
  return people.map((p) => ({
    name: p.organization?.name || p.organization_name,
    domain: p.organization?.primary_domain || p.organization?.website_url,
    website: p.organization?.website_url,
    industry: p.organization?.industry,
    dm_name: [p.first_name, p.last_name_obfuscated || p.last_name].filter(Boolean).join(' '),
    dm_title: p.title,
    linkedin: p.linkedin_url,
  })).filter((r) => r.domain);
}
