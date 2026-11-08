// Phase 2/3/4 helper: read the official website and collect publicly published facts.
// It only reports what is literally on the page, with the page URL as the source.
import { fetchPage } from './http.js';
import { extractEmails } from './emailRules.js';

const CANDIDATE_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us', '/partners', '/partnerships', '/services', '/work', '/portfolio', '/case-studies', '/careers', '/jobs', '/team', '/blog', '/news'];

const US_STATES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
const STATE_ABBR = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || '';
}

function findUsAddress(text) {
  const re = new RegExp(`[0-9]{1,6}[^,]{2,60},\\s*[A-Za-z .'-]{2,40},\\s*(?:${STATE_ABBR}|${US_STATES})\\s+\\d{5}(?:-\\d{4})?`);
  return text.match(re)?.[0] || '';
}

// Technology fingerprints visible in public HTML (free tech-stack detection).
const TECH = [
  ['Shopify', /cdn\.shopify\.com|Shopify\.theme/i], ['WordPress', /wp-content\/|wp-includes\//i], ['WooCommerce', /woocommerce/i],
  ['Webflow', /webflow\.(js|com)|data-wf-site/i], ['Squarespace', /squarespace\.com|static1\.squarespace/i], ['Wix', /wixstatic\.com|wix\.com/i],
  ['HubSpot', /js\.hs-scripts\.com|hsforms|hs-analytics/i], ['Salesforce', /salesforce\.com|force\.com|pardot/i], ['Zoho', /zoho\.(com|eu)/i],
  ['Next.js', /__NEXT_DATA__|\/_next\//], ['React', /data-reactroot|react-dom/i], ['Magento', /mage\/|Magento/], ['BigCommerce', /bigcommerce/i],
  ['Intercom', /intercom/i], ['Zendesk', /zendesk|zdassets/i], ['Calendly', /calendly\.com/i], ['Typeform', /typeform/i], ['Google Analytics', /gtag\(|googletagmanager/i],
];

function textOf(fragment) { return stripTags(fragment).replace(/\s+/g, ' ').trim(); }

function collectFacts(html, url, path, facts) {
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = textOf(m[2]);
    if (t.length >= 6 && t.length <= 140 && !facts.headings.some((h) => h.text === t)) facts.headings.push({ text: t, url, level: Number(m[1]), path });
  }
  for (const [name, re] of TECH) if (re.test(html) && !facts.tech.some((t) => t.name === name)) facts.tech.push({ name, url });
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]; const t = textOf(m[2]);
    if (!t || t.length < 6 || t.length > 120) continue;
    if (/case-stud|\/work\/|\/portfolio\/|\/projects?\/|\/clients?\//i.test(href) && !facts.caseStudies.some((c) => c.text === t)) {
      try { facts.caseStudies.push({ text: t, url: new URL(href, url).toString() }); } catch { /* bad href */ }
    }
    if (/careers|jobs|join-us|hiring/i.test(href) && /engineer|developer|manager|coordinator|specialist|analyst|designer|dispatcher|recruiter|operations|sales/i.test(t) && !facts.hiring.some((c) => c.text === t)) {
      try { facts.hiring.push({ text: t, url: new URL(href, url).toString() }); } catch { /* bad href */ }
    }
  }
  if (/careers|jobs/.test(path)) {
    for (const h of facts.headings.filter((x) => x.path === path && x.level >= 2)) {
      if (/engineer|developer|manager|coordinator|specialist|analyst|designer|dispatcher|recruiter|operations/i.test(h.text) && !facts.hiring.some((c) => c.text === h.text)) facts.hiring.push({ text: h.text, url: h.url });
    }
  }
  const text = textOf(html);
  for (const m of text.matchAll(/(?:\+1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) {
    const num = `(${m[1]}) ${m[2]}-${m[3]}`;
    if (!facts.phones.some((p) => p.number === num) && facts.phones.length < 5) facts.phones.push({ number: num, url });
  }
}

export async function scanWebsite(domainOrUrl, { maxPages = 10 } = {}) {
  const base = /^https?:\/\//.test(domainOrUrl) ? new URL(domainOrUrl).origin : `https://${domainOrUrl}`;
  const result = { base, pages: [], emails: [], title: '', description: '', linkedin: '', usAddress: null, mailtoEmails: [], errors: [],
    facts: { headings: [], caseStudies: [], tech: [], hiring: [], phones: [], social: {} } };
  const emailSources = new Map();
  let origin = base;
  // A DNS failure throws inside fetchPage (public-address check); treat it as a failed page.
  const get = (url) => fetchPage(url).catch((e) => ({ ok: false, status: 0, url, error: e.message, html: '' }));
  for (const p of CANDIDATE_PATHS) {
    if (result.pages.length >= maxPages) break;
    const url = origin + p;
    let page = await get(url);
    if (!page.ok) {
      if (p === '/') {
        // Try plain http, then the www / non-www twin (map listings often have the wrong one).
        const host = new URL(url).hostname;
        const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
        const tries = [url.replace(/^https:/, 'http:'), url.replace(host, twin), url.replace(host, twin).replace(/^https:/, 'http:')];
        let alt = null;
        for (const t of tries) { alt = await get(t); if (alt.ok) break; }
        if (!alt.ok) {
          result.errors.push(`${url}: ${page.error}`);
          if (/ENOTFOUND|getaddrinfo/i.test(`${page.error} ${alt.error}`)) result.dnsFailed = true;
          if ([401, 403, 429, 503].includes(page.status) || [401, 403, 429, 503].includes(alt.status)) result.blocked = true;
          if (/robots\.txt/i.test(page.error)) result.robotsBlocked = true;
          break;
        }
        page = alt;
      } else continue;
    }
    if (p === '/') {
      origin = new URL(page.url).origin;
      // Bot-protection pages (Cloudflare "Just a moment…", SiteGround captcha) are not the site: stop, never bypass.
      if (page.html.length < 30000 && /sgcaptcha|cf-chl|challenge-platform|<title>\s*(just a moment|attention required|access denied)|captcha-delivery|px-captcha/i.test(page.html)) {
        result.blocked = true;
        result.errors.push(`${page.url}: bot protection page`);
        break;
      }
    }
    const html = page.html;
    result.pages.push(page.url);
    if (p === '/') {
      result.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      result.description = meta(html, 'description') || meta(html, 'og:description');
    }
    const li = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-z0-9_-]+/i)?.[0];
    if (li && !result.linkedin) result.linkedin = li;
    for (const [k, re] of [['linkedin', /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-z0-9_-]+/i], ['clutch', /https?:\/\/(?:www\.)?clutch\.co\/profile\/[a-z0-9_-]+/i], ['facebook', /https?:\/\/(?:www\.)?facebook\.com\/[a-z0-9_.-]+/i], ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.-]+/i]]) {
      const hit = html.match(re)?.[0];
      if (hit && !result.facts.social[k]) result.facts.social[k] = hit;
    }
    collectFacts(html, page.url, p, result.facts);
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
      const e = decodeURIComponent(m[1]).toLowerCase();
      if (!emailSources.has(e)) emailSources.set(e, page.url);
      if (!result.mailtoEmails.includes(e)) result.mailtoEmails.push(e);
    }
    const text = stripTags(html);
    for (const e of extractEmails(text)) if (!emailSources.has(e)) emailSources.set(e, page.url);
    if (!result.usAddress) {
      const addr = findUsAddress(text);
      if (addr) result.usAddress = { text: addr, url: page.url };
    }
  }
  result.emails = [...emailSources.entries()].map(([email, url]) => ({ email, url }));
  return result;
}

/** Re-fetch a source page and confirm the exact email string is present. */
export async function confirmEmailOnPage(email, url) {
  const page = await fetchPage(url);
  if (!page.ok) return { confirmed: null, detail: `Could not load source page: ${page.error}` };
  const lower = page.html.toLowerCase();
  const target = email.toLowerCase();
  if (lower.includes(target) || lower.includes(encodeURIComponent(target))) return { confirmed: true, detail: 'Exact email found on source page' };
  const found = extractEmails(stripTags(page.html));
  if (found.includes(target)) return { confirmed: true, detail: 'Email found on source page (de-obfuscated)' };
  return { confirmed: false, detail: 'Email NOT found on source page' };
}
