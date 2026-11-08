// Hunter.io: finds the email addresses a company has published on the public web, with the
// pages they were found on. Read-only. Uses only the account endpoint (free) and domain search
// (1 credit per search with results). Never uses the "email finder" (pattern guessing).
import { getSetting } from '../lib/settings.js';
import { SourceError, classifyHttp } from '../lib/sourceError.js';

export function isConfigured() {
  return !!getSetting('hunter_api_key');
}

async function call(path, params = {}) {
  const key = getSetting('hunter_api_key');
  if (!key) throw new SourceError('Hunter API key not set', 'auth');
  const base = (getSetting('hunter_base_url') || 'https://api.hunter.io').replace(/\/$/, '');
  const qs = new URLSearchParams({ ...params, api_key: key });
  let res;
  try {
    res = await fetch(`${base}/v2${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new SourceError(`Cannot reach Hunter (${e.message})`, 'other'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.errors || []).map((x) => `${x.id || ''} ${x.details || ''}`).join('; ');
    throw classifyHttp('Hunter', res.status, detail, res.headers);
  }
  return data.data || {};
}

/** Plan and remaining searches this month. Free to call. */
export async function account() {
  const d = await call('/account');
  const s = d.requests?.searches || {};
  return {
    plan: d.plan_name || 'Free',
    used: Number(s.used || 0),
    available: Number(s.available || 0),
    left: Math.max(0, Number(s.available || 0) - Number(s.used || 0)),
    resetAt: d.reset_date ? `${d.reset_date}T00:00:00Z` : null,
  };
}

export async function testConnection() {
  const a = await account();
  return { ok: true, credits: a, detail: `Hunter OK — ${a.plan} plan: ${a.left} of ${a.available} searches left${a.resetAt ? ` (renews ${a.resetAt.slice(0, 10)})` : ''}` };
}

/**
 * Emails published for a domain, each with the public pages it was found on.
 * Emails without a source page are dropped (that would be a guess).
 */
export async function domainSearch(domain) {
  const d = await call('/domain-search', { domain, limit: '10' });
  return (d.emails || [])
    .map((e) => ({
      email: String(e.value || '').toLowerCase(),
      type: e.type, confidence: Number(e.confidence || 0),
      name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      position: e.position || '',
      sources: (e.sources || []).filter((s) => s.uri).map((s) => ({ uri: s.uri, onPage: s.still_on_page !== false })),
    }))
    .filter((e) => e.email && e.sources.length);
}
