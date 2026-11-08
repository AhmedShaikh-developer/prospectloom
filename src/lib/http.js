// Polite, read-only HTTP fetch for official company websites.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

export const USER_AGENT = 'LocalhostLabsResearch/1.0 (+business research; read-only)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80') || low === '::';
}

async function assertPublic(url) {
  if (config.loopbackOnlyFetch) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('External fetch blocked in test mode');
    return;
  }
  if (config.allowPrivateFetch) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (ips.some(isPrivateIp)) throw new Error('Refusing to fetch a private network address');
}

const robotsCache = new Map();

async function robotsAllows(url) {
  const u = new URL(url);
  const key = u.origin;
  if (!robotsCache.has(key)) {
    let rules = [];
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const text = await res.text();
        let applies = false;
        for (const raw of text.split('\n')) {
          const line = raw.split('#')[0].trim();
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').trim();
          if (/^user-agent$/i.test(k)) applies = v === '*';
          else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
        }
      }
    } catch { /* no robots.txt => allowed */ }
    robotsCache.set(key, rules);
  }
  return !robotsCache.get(key).some((p) => u.pathname.startsWith(p));
}

export async function fetchPage(url, { timeoutMs = 10000, maxBytes = 1_500_000 } = {}) {
  await assertPublic(url);
  if (!(await robotsAllows(url))) return { ok: false, status: 0, url, error: 'Disallowed by robots.txt', html: '' };
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, url: res.url || url, error: `HTTP ${res.status}`, html: '' };
    if (type && !/html|text/.test(type)) return { ok: false, status: res.status, url: res.url, error: `Not HTML (${type})`, html: '' };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, url: res.url || url, html: buf.subarray(0, maxBytes).toString('utf8') };
  } catch (e) {
    return { ok: false, status: 0, url, error: e.name === 'TimeoutError' ? 'Timed out' : e.message, html: '' };
  }
}
