// Free local-business finder using OpenStreetMap (no key, no cost) — a Google-Maps-style
// source for B2C and local B2B leads. Nominatim finds the area, Overpass lists businesses
// in it that publish their own website. Usage policies: identify the app, keep volume low.
import { getSetting } from '../lib/settings.js';
import { normalizeDomain, normalizeUrl } from '../lib/normalize.js';
import { q, nowIso } from '../db/index.js';

const UA = 'ProspectLoomLeadFinder/1.0 (personal lead research tool)';

// label, group, OSM tag key, values, suggested offer
export const CATEGORIES = [
  ['Restaurants', 'Food & drink', 'amenity', ['restaurant'], 'C'],
  ['Cafés & coffee shops', 'Food & drink', 'amenity', ['cafe'], 'C'],
  ['Bars & pubs', 'Food & drink', 'amenity', ['bar', 'pub'], 'C'],
  ['Bakeries', 'Food & drink', 'shop', ['bakery'], 'C'],
  ['Dentists', 'Health', 'amenity', ['dentist'], 'C'],
  ['Clinics & doctors', 'Health', 'amenity', ['clinic', 'doctors'], 'C'],
  ['Physiotherapists', 'Health', 'healthcare', ['physiotherapist'], 'C'],
  ['Veterinarians', 'Health', 'amenity', ['veterinary'], 'C'],
  ['Pharmacies', 'Health', 'amenity', ['pharmacy'], 'C'],
  ['Hair & beauty salons', 'Beauty & fitness', 'shop', ['hairdresser', 'beauty'], 'C'],
  ['Gyms & fitness studios', 'Beauty & fitness', 'leisure', ['fitness_centre'], 'C'],
  ['Hotels & guest houses', 'Travel', 'tourism', ['hotel', 'guest_house', 'motel'], 'C'],
  ['Clothing stores', 'Retail', 'shop', ['clothes', 'boutique'], 'C'],
  ['Furniture stores', 'Retail', 'shop', ['furniture'], 'C'],
  ['Florists', 'Retail', 'shop', ['florist'], 'C'],
  ['Car dealers', 'Automotive', 'shop', ['car'], 'C'],
  ['Car repair', 'Automotive', 'shop', ['car_repair'], 'C'],
  ['Plumbers', 'Home services', 'craft', ['plumber'], 'C'],
  ['Electricians', 'Home services', 'craft', ['electrician'], 'C'],
  ['HVAC', 'Home services', 'craft', ['hvac'], 'C'],
  ['Real estate agents', 'Professional services', 'office', ['estate_agent'], 'C'],
  ['Lawyers', 'Professional services', 'office', ['lawyer'], 'A'],
  ['Accountants', 'Professional services', 'office', ['accountant', 'tax_advisor'], 'A'],
  ['Insurance agencies', 'Professional services', 'office', ['insurance'], 'A'],
  ['Architects', 'Professional services', 'office', ['architect'], 'A'],
  ['Recruitment agencies', 'B2B', 'office', ['employment_agency'], 'A'],
  ['Logistics & couriers', 'B2B', 'office', ['logistics', 'courier', 'moving_company'], 'A'],
  ['Wholesalers', 'B2B', 'shop', ['wholesale'], 'A'],
  ['IT companies', 'B2B', 'office', ['it', 'telecommunication'], 'A'],
  ['Marketing & advertising agencies', 'Agencies', 'office', ['advertising_agency', 'marketing'], 'B'],
  ['Design & web studios', 'Agencies', 'office', ['graphic_design', 'web_design'], 'B'],
].map(([label, group, key, values, offer]) => ({ id: label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label, group, key, values, offer }));

// Links to social/booking platforms are not the business's own website.
const PLATFORMS = ['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'linktr.ee',
  'yelp.com', 'tripadvisor.com', 'google.com', 'goo.gl', 'business.site', 'wa.me', 'whatsapp.com', 'booking.com', 'opentable.com', 'ubereats.com',
  'doordash.com', 'grubhub.com', 'square.site', 'squareup.com', 'toasttab.com', 'vagaro.com', 'fresha.com', 'mindbodyonline.com', 'zocdoc.com', 'healthgrades.com'];
const isPlatform = (domain) => PLATFORMS.some((p) => domain === p || domain.endsWith('.' + p));

async function getJson(url, init = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) })
    .catch((e) => { throw new Error(/abort|timeout/i.test(e.message) ? 'OpenStreetMap took too long — try a smaller area or again in a minute' : `OpenStreetMap unreachable (${e.message})`); });
  if (res.status === 429 || res.status === 504) throw new Error('OpenStreetMap is busy right now — wait a minute and search again');
  if (!res.ok) throw new Error(`OpenStreetMap error ${res.status}`);
  return res.json();
}

/** Geocode a place name ("Austin, TX") into a bounding box. Cached, so each place is looked up once. */
export async function geocode(location) {
  const key = String(location).trim().toLowerCase().replace(/\s+/g, ' ');
  const cached = q.get('SELECT data FROM geo_cache WHERE location = :key', { key });
  if (cached) return JSON.parse(cached.data);
  const url = `${getSetting('osm_nominatim_url').replace(/\/$/, '')}/search?format=json&limit=1&q=${encodeURIComponent(location)}`;
  const [hit] = await getJson(url);
  if (!hit) throw new Error(`Could not find "${location}". Try "City, State" or "City, Country".`);
  const [south, north, west, east] = hit.boundingbox.map(Number);
  // Whole countries/states are far too big for one search — the Lead engine covers them city by city.
  if (['country', 'state', 'region', 'province', 'continent'].includes(hit.addresstype) || north - south > 4 || east - west > 6) {
    throw new Error(`"${location}" is a whole ${hit.addresstype || 'region'} — search one city at a time (e.g. "Austin, TX"), or let the Lead engine cover all its major cities automatically.`);
  }
  // Cap large metro areas to the central part to keep the free public servers happy.
  const lat = Number(hit.lat); const lon = Number(hit.lon); const MAX = 0.35;
  const box = { south: Math.max(south, lat - MAX), north: Math.min(north, lat + MAX), west: Math.max(west, lon - MAX), east: Math.min(east, lon + MAX) };
  const out = { name: hit.display_name, ...box, capped: north - south > 2 * MAX || east - west > 2 * MAX };
  q.run('INSERT OR REPLACE INTO geo_cache (location, data, created_at) VALUES (:key, :data, :now)', { key, data: JSON.stringify(out), now: nowIso() });
  return out;
}

function address(t) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const cityLine = [t['addr:city'], [t['addr:state'], t['addr:postcode']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, cityLine, t['addr:country']].filter(Boolean).join(', ');
}

/**
 * Find businesses of a category in an area that list their own website.
 * Returns { area, results: [{ name, website, domain, phone, address, osm_url, category, offer, email_hint }], skipped }
 */
export async function findBusinesses({ categoryId, location, limit = 50, customTag }) {
  let cat = CATEGORIES.find((c) => c.id === categoryId);
  if (customTag) {
    const m = String(customTag).match(/^\s*([a-z_:]+)\s*=\s*([a-z0-9_;|]+)\s*$/i);
    if (!m) throw new Error('Custom tag must look like key=value, e.g. shop=bicycle');
    cat = { id: 'custom', label: customTag, key: m[1], values: m[2].split(/[;|]/), offer: 'A' };
  }
  if (!cat) throw new Error('Choose a business category');
  if (!String(location || '').trim()) throw new Error('Enter a city or area, e.g. "Austin, TX"');
  const area = await geocode(location);
  const bbox = `${area.south},${area.west},${area.north},${area.east}`;
  // Exact matches are much faster on the public servers than regex matches.
  const sel = cat.values.length === 1 ? `["${cat.key}"="${cat.values[0]}"]` : `["${cat.key}"~"^(${cat.values.join('|')})$"]`;
  const query = `[out:json][timeout:80];(nwr${sel}["website"](${bbox});nwr${sel}["contact:website"](${bbox}););out tags center ${Math.min(800, limit * 4)};`;
  // The public Overpass servers are free but sometimes busy: try each configured server in turn.
  let data; let lastErr;
  for (const url of getSetting('osm_overpass_url').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      data = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` }, 90000);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr;
  const seen = new Set(); const results = []; let skipped = 0;
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const website = normalizeUrl(t.website || t['contact:website'] || '');
    const domain = normalizeDomain(website);
    if (!t.name || !domain) { skipped++; continue; }
    if (isPlatform(domain)) { skipped++; continue; }
    if (seen.has(domain)) continue;
    seen.add(domain);
    results.push({
      name: t.name, website, domain,
      phone: t.phone || t['contact:phone'] || '',
      address: address(t),
      osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      category: cat.label, offer: cat.offer,
      email_hint: t.email || t['contact:email'] || '',
    });
    if (results.length >= limit) break;
  }
  return { area: area.name, capped: area.capped, results, skipped };
}
