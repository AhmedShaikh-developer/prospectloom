// Phase 5: normalize domains and email addresses before any matching.

const MULTI_PART_TLDS = new Set(['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'com.mx']);

export function normalizeDomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip protocol
  s = s.split(/[/?#]/)[0];                      // strip path/query/hash
  s = s.replace(/:\d+$/, '');                    // strip port
  s = s.replace(/^www\d*\./, '');
  s = s.replace(/\.+$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';
  return s;
}

/** Registrable root, e.g. "mail.acme.co.uk" -> "acme.co.uk". */
export function rootDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return '';
  const parts = d.split('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normalizeEmail(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^mailto:/, '').split('?')[0];
  s = s.replace(/^<|>$/g, '');
  return EMAIL_RE.test(s) ? s : '';
}

export function emailDomain(email) {
  const e = normalizeEmail(email);
  return e ? e.split('@')[1] : '';
}

export function emailLocalPart(email) {
  const e = normalizeEmail(email);
  return e ? e.split('@')[0] : '';
}

export function normalizeUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

export function isValidUrl(input) {
  if (!input) return false;
  try {
    const u = new URL(String(input));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
