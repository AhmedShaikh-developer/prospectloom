// Zero-credit deliverability signal: does the email domain publish MX records?
// This does NOT prove a mailbox exists — it only rules out dead domains.
import dns from 'node:dns/promises';
import { getSetting } from './settings.js';
import { rootDomain } from './normalize.js';

const cache = new Map();

export async function hasMx(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return { ok: false, detail: 'no domain' };
  if (getSetting('dns_mode') === 'mock') {
    // Test mode: any domain containing "nomx" has no mail server.
    return d.includes('nomx') ? { ok: false, detail: 'mock: no MX' } : { ok: true, detail: 'mock: MX present', records: ['mx.mock'] };
  }
  if (cache.has(d)) return cache.get(d);
  let result;
  try {
    const recs = await dns.resolveMx(d);
    result = recs.length
      ? { ok: true, detail: `${recs.length} MX record(s)`, records: recs.sort((a, b) => a.priority - b.priority).map((r) => r.exchange) }
      : { ok: false, detail: 'no MX records' };
  } catch (e) {
    if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') result = { ok: false, detail: `DNS: ${e.code}` };
    else return { ok: null, detail: `DNS lookup failed (${e.code || e.message}); retry later` };
  }
  cache.set(d, result);
  return result;
}

async function txt(name) {
  try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; }
}

/**
 * Free email-authentication check for a domain (SPF, DMARC, common DKIM selectors).
 * Used for (a) your own sending domain — deliverability — and (b) a lead's domain as a
 * "real business mail domain" signal.
 */
export async function mailAuth(domain) {
  const d = String(domain || '').toLowerCase();
  if (getSetting('dns_mode') === 'mock') {
    const ok = !d.includes('nomx');
    return { domain: d, mx: ok, spf: ok ? 'v=spf1 include:_spf.mail.hostinger.com ~all' : null, dmarc: ok ? 'v=DMARC1; p=none' : null, dkim: ok ? 'hostingermail1' : null, spfIncludesHostinger: ok };
  }
  const [mx, rootTxt, dmarcTxt] = await Promise.all([hasMx(d), txt(d), txt(`_dmarc.${d}`)]);
  const spf = rootTxt.find((t) => t.toLowerCase().startsWith('v=spf1')) || null;
  const dmarc = dmarcTxt.find((t) => t.toLowerCase().startsWith('v=dmarc1')) || null;
  let dkim = null;
  for (const sel of ['hostingermail-a', 'hostingermail-b', 'hostingermail1', 'hostingermail2', 'default', 'google', 'selector1', 'selector2', 'k1', 's1']) {
    const name = `${sel}._domainkey.${d}`;
    // Hostinger publishes DKIM as a CNAME to its own zone; Node's resolver can time out
    // following it, so resolve the CNAME first and read the TXT at the target.
    let recs = await txt(name);
    if (!recs.length) {
      const target = await dns.resolveCname(name).then((r) => r[0]).catch(() => null);
      if (target) recs = await txt(target);
    }
    if (recs.some((r) => /p=[A-Za-z0-9+/]/.test(r))) { dkim = sel; break; } // an empty p= is a revoked key
  }
  return { domain: d, mx: mx.ok, spf, dmarc, dkim, spfIncludesHostinger: !!spf && /hostinger/i.test(spf) };
}

// ---------------------------------------------------------------- does the website's domain still exist?
// Map listings (OpenStreetMap) are often years old: many websites have expired. A public resolver
// tells "domain no longer exists" (NXDOMAIN) apart from a temporary lookup problem.
const publicResolver = new dns.Resolver({ timeout: 4000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);
const stateCache = new Map();

async function resolves(host) {
  try { await dns.lookup(host); return true; } catch { return false; }
}

/**
 * 'alive'    — the website host (or its www/bare twin) resolves
 * 'nxdomain' — the domain itself no longer exists (expired / deleted)
 * 'no_web'   — the domain exists but has no working web address
 * 'unknown'  — DNS could not answer right now (treat as temporary)
 */
export async function domainState(hostOrDomain) {
  const host = String(hostOrDomain || '').toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
  if (!host) return 'unknown';
  if (getSetting('dns_mode') === 'mock') return host.includes('deadsite') ? 'nxdomain' : host.includes('noweb') ? 'no_web' : 'alive';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return 'alive';
  const cached = stateCache.get(host);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.state;
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  let state;
  if ((await resolves(host)) || (await resolves(twin))) state = 'alive';
  else {
    try {
      await publicResolver.resolveSoa(rootDomain(host) || host);
      state = 'no_web';
    } catch (e) {
      state = e.code === 'ENOTFOUND' ? 'nxdomain' : e.code === 'ENODATA' ? 'no_web' : e.code === 'ESERVFAIL' ? 'no_web' : 'unknown';
    }
  }
  stateCache.set(host, { state, at: Date.now() });
  return state;
}

/** Keep only results whose website domain still exists (used before importing map listings). */
export async function dropDeadSites(results, { concurrency = 12 } = {}) {
  const out = []; let dead = 0;
  for (let i = 0; i < results.length; i += concurrency) {
    const chunk = results.slice(i, i + concurrency);
    const states = await Promise.all(chunk.map((r) => domainState(r.website || r.domain)));
    chunk.forEach((r, j) => { if (states[j] === 'nxdomain') dead++; else out.push(r); });
  }
  return { results: out, dead };
}
