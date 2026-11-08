// Mock HubSpot + Apollo API (port 4501) and fake company websites (ports 4511-4515)
// so the full pipeline can be exercised end-to-end without touching real services.
import express from 'express';

const TOKEN = 'test-token';
let nextId = 9100;
let companies = [];
const contacts = [{ id: '501', properties: { email: 'known@existing-crm.com', firstname: 'Known' } }];
let lastPrompt = '';
const PROPS = ['ll_outreach_stage', 'll_public_contact_email', 'll_email_source_url', 'll_email_evidence_type', 'll_last_verified_date', 'll_suppression_reason', 'll_last_sent_date'];
export const calls = [];

function seed() {
  nextId = 9100;
  companies = [
    { id: '9001', properties: { name: 'Existing CRM Co', domain: 'existing-crm.com', ll_outreach_stage: 'SENT' } },
    { id: '9002', properties: { name: 'Pixel Forge', domain: 'pixelforge.co', ll_outreach_stage: 'HOLD' } },
    { id: '9003', properties: { name: 'Granite Supply', domain: 'granitesupply.com', industry: 'Wholesale', ll_outreach_stage: null } },
    { id: '9004', properties: { name: 'Opted Out Inc', domain: 'optedout-inc.com', ll_outreach_stage: 'DO_NOT_CONTACT', ll_suppression_reason: 'Asked not to be contacted' } },
  ];
  calls.length = 0;
}
seed();

const api = express();
api.use(express.json());
api.use((req, res, next) => {
  calls.push(`${req.method} ${req.path}`);
  if (req.path.startsWith('/__') || req.path.startsWith('/v1') || req.path.startsWith('/api/') || req.path.startsWith('/osm/') || req.path.startsWith('/hunter/')) return next();
  if (req.path.startsWith('/openai/')) return req.get('authorization') === 'Bearer groq-test' ? next() : res.status(401).json({ error: { message: 'Invalid API Key' } });
  if (req.get('authorization') !== `Bearer ${TOKEN}`) return res.status(401).json({ message: 'Invalid token' });
  next();
});

api.post('/__reset', (req, res) => { seed(); res.json({ ok: true }); });
api.get('/__state', (req, res) => res.json({ companies, calls, lastPrompt, props: PROPS }));
api.post('/__drop-prop', (req, res) => { const i = PROPS.indexOf(req.body.name); if (i >= 0) PROPS.splice(i, 1); res.json({ ok: true }); });
api.post('/crm/v3/properties/companies', (req, res) => { if (!PROPS.includes(req.body.name)) PROPS.push(req.body.name); res.status(201).json(req.body); });

// Groq (OpenAI-compatible) mock. "__groqMode" switches the reply to exercise the quality gate.
let groqMode = 'good';
api.post('/__groq-mode', (req, res) => { groqMode = req.body.mode; res.json({ ok: true }); });
api.get('/openai/v1/models', (req, res) => res.json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] }));
api.post('/openai/v1/chat/completions', (req, res) => {
  lastPrompt = req.body.messages.map((m) => m.content).join('\n\n');
  const good = 'SUBJECT: your booking page\nBODY:\nHi there,\n\nAI-WRITTEN note. Saw on your site that people can only book by phone right now.\n\nWe set up simple online booking and ordering for small local places, usually in a week or two, so the phone rings a bit less.\n\nIs that something you have thought about, or not a priority right now?\n\nAlex';
  const bad = 'SUBJECT: Hi [Name]!\nBODY:\nHi [Name]! We grew revenue 300% for clients like you! Visit https://example.com now!';
  res.json({ choices: [{ message: { role: 'assistant', content: groqMode === 'bad' ? bad : good } }] });
});

// OpenStreetMap mocks (Nominatim + Overpass)
let osmDelay = 0;
api.post('/__osm-delay', (req, res) => { osmDelay = Number(req.body.ms) || 0; res.json({ ok: true }); });
api.get('/osm/nominatim/search', (req, res) => {
  if (/nowhere/i.test(req.query.q)) return res.json([]);
  if (/^united states$/i.test(req.query.q)) return res.json([{ display_name: 'United States', addresstype: 'country', lat: '39.7', lon: '-98.5', boundingbox: ['24.5', '49.4', '-125', '-66.9'] }]);
  res.json([{ display_name: `${req.query.q} (mock)`, addresstype: 'city', lat: '30.27', lon: '-97.74', boundingbox: ['30.10', '30.50', '-97.95', '-97.55'] }]);
});
api.post('/osm/overpass', express.urlencoded({ extended: false }), async (req, res) => {
  lastPrompt = req.body.data;
  if (osmDelay) await new Promise((r) => setTimeout(r, osmDelay));
  if (/"amenity"="restaurant"/.test(req.body.data)) {
    return res.json({ elements: [
      { type: 'node', id: 601, tags: { name: 'Taco Town', amenity: 'restaurant', website: 'https://tacotown-atx.com', 'addr:city': 'Austin', 'addr:state': 'TX' } },
      { type: 'node', id: 602, tags: { name: 'Pho Real', amenity: 'restaurant', website: 'phoreal-atx.com' } },
    ] });
  }
  res.json({ elements: [
    { type: 'node', id: 101, tags: { name: 'Sunrise Café', amenity: 'cafe', website: 'https://www.sunrise-cafe.com/', phone: '+1 512 555 0100', 'addr:housenumber': '500', 'addr:street': 'Congress Ave', 'addr:city': 'Austin', 'addr:state': 'TX', 'addr:postcode': '78701' } },
    { type: 'way', id: 202, tags: { name: 'Bean There', amenity: 'cafe', 'contact:website': 'beanthere-atx.com' } },
    { type: 'node', id: 303, tags: { name: 'Only Facebook Café', amenity: 'cafe', website: 'https://facebook.com/onlyfb' } },
    { type: 'node', id: 404, tags: { amenity: 'cafe', website: 'https://noname.example' } },
    { type: 'node', id: 505, tags: { name: 'Sunrise Café (2nd location)', amenity: 'cafe', website: 'https://sunrise-cafe.com/east' } },
  ] });
});

api.get('/crm/v3/objects/companies', (req, res) => {
  const limit = Number(req.query.limit || 100);
  const after = Number(req.query.after || 0);
  const page = companies.slice(after, after + limit);
  res.json({ results: page, paging: after + limit < companies.length ? { next: { after: String(after + limit) } } : undefined });
});
api.post('/crm/v3/objects/companies/search', (req, res) => {
  const f = req.body.filterGroups?.[0]?.filters?.[0];
  res.json({ results: companies.filter((c) => c.properties[f.propertyName] === f.value) });
});
api.get('/crm/v3/objects/companies/:id', (req, res) => {
  const c = companies.find((x) => x.id === req.params.id);
  return c ? res.json(c) : res.status(404).json({ message: 'Not found' });
});
api.patch('/crm/v3/objects/companies/:id', (req, res) => {
  const c = companies.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ message: 'Not found' });
  Object.assign(c.properties, req.body.properties);
  res.json(c);
});
api.post('/crm/v3/objects/companies', (req, res) => {
  const c = { id: String(nextId++), properties: { ...req.body.properties } };
  companies.push(c);
  res.status(201).json(c);
});
api.post('/crm/v3/objects/contacts/search', (req, res) => {
  const f = req.body.filterGroups?.[0]?.filters?.[0];
  res.json({ results: contacts.filter((c) => c.properties.email === f.value) });
});
api.get('/crm/v3/properties/companies/:name', (req, res) => {
  if (!PROPS.includes(req.params.name)) return res.status(404).json({ message: 'Property does not exist' });
  res.json({ name: req.params.name, type: req.params.name.endsWith('date') ? 'date' : 'string', options: req.params.name === 'll_outreach_stage' ? ['HOLD', 'READY', 'SENT'].map((value) => ({ value })) : [] });
});

// Apollo
api.get('/v1/auth/health', (req, res) => res.json({ is_logged_in: req.get('x-api-key') === 'apollo-test' }));
let apolloMode = 'ok';
let hunterLeft = 25;
api.post('/__apollo-mode', (req, res) => { apolloMode = req.body.mode || 'ok'; res.json({ apolloMode }); });
api.post('/__hunter', (req, res) => { hunterLeft = Number(req.body.left ?? 25); res.json({ hunterLeft }); });
api.post('/api/v1/mixed_people/api_search', (req, res) => {
  if (apolloMode === 'credits') return res.status(422).json({ error: 'You have insufficient credits. Please upgrade your plan to get more credits.' });
  if (apolloMode === 'rate') return res.status(429).set({ 'x-minute-requests-left': '0', 'retry-after': '60' }).json({ error: 'Too many requests' });
  res.json({ people: [
    { first_name: 'Dana', last_name_obfuscated: 'R***', title: 'Founder', organization: { name: 'Bright Pixel Studio', primary_domain: 'brightpixelstudio.com', website_url: 'https://brightpixelstudio.com' } },
    { first_name: 'Lee', last_name_obfuscated: 'K***', title: 'COO', organization: { name: 'Harbor Logistics', primary_domain: 'harborlogistics.com', website_url: 'https://harborlogistics.com' } },
  ] });
});
// Hunter.io
const hunterKey = (req, res) => { if (req.query.api_key !== 'hunter-test') { res.status(401).json({ errors: [{ id: 'authentication_failed', details: 'No user found for the API key supplied' }] }); return false; } return true; };
api.get('/hunter/v2/account', (req, res) => {
  if (!hunterKey(req, res)) return;
  res.json({ data: { plan_name: 'Free', reset_date: '2099-01-01', requests: { searches: { used: 25 - hunterLeft, available: 25 }, verifications: { used: 0, available: 50 } } } });
});
api.get('/hunter/v2/domain-search', (req, res) => {
  if (!hunterKey(req, res)) return;
  if (hunterLeft <= 0) return res.status(429).json({ errors: [{ id: 'too_many_requests', details: "You've exceeded your usage limit" }] });
  hunterLeft--;
  const d = req.query.domain;
  const emails = d.startsWith('hunted') ? [
    { value: `riley@${d}`, type: 'personal', confidence: 96, first_name: 'Riley', last_name: 'Stone', position: 'Founder', sources: [{ domain: 'press.example.org', uri: 'https://press.example.org/riley-stone', still_on_page: true }] },
    { value: `guess@${d}`, type: 'personal', confidence: 40, first_name: 'Pat', last_name: 'Guess', position: 'Intern', sources: [] },
  ] : [];
  res.json({ data: { domain: d, emails } });
});
api.listen(4501, '127.0.0.1');

// ---- Fake company websites -------------------------------------------------
const layout = (title, desc, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${desc}"></head><body>${body}</body></html>`;
const SITES = {
  4511: { // Offer A — logistics
    '/': layout('Acme Freight — Regional LTL carrier', 'Acme Freight is a regional LTL and dedicated trucking carrier serving Texas and Oklahoma.', '<h1>Acme Freight</h1><h2>Same-day dispatch across Texas and Oklahoma</h2><p>HQ: 120 Main St, Austin, TX 78701 · Call (512) 555-0142</p><a href="https://www.linkedin.com/company/acme-freight">LinkedIn</a><a href="/case-studies/grocery-fleet">Dedicated fleet for a regional grocery chain</a><a href="/careers/dispatch-coordinator">Dispatch Coordinator (Austin)</a><script src="https://js.hs-scripts.com/123.js"></script>'),
    '/contact': layout('Contact', '', '<p>General: <a href="mailto:hello@acme-freight.com">hello@acme-freight.com</a></p><p>Customer support: support@acme-freight.com</p>'),
    '/about': layout('About', '', '<p>Founded 2009. 85 employees.</p>'),
  },
  4512: { // Offer B — agency with partnerships inbox
    '/': layout('Pixel Forge — Shopify agency', 'Pixel Forge is a Shopify Plus agency building storefronts for DTC brands.', '<h1>Pixel Forge</h1><p>Studio: 55 Water St, Brooklyn, NY 11201</p>'),
    '/partners': layout('Partners', '', '<p>Partnership enquiries: <a href="mailto:partnerships@pixelforge.co">partnerships@pixelforge.co</a></p>'),
    '/contact': layout('Contact', '', '<p>Billing: billing@pixelforge.co</p>'),
  },
  4513: { // only unsuitable inboxes
    '/': layout('Northwind Wholesale', 'Wholesale distribution of restaurant supplies.', '<p>Distribution center: 9 Dock Rd, Columbus, OH 43215</p>'),
    '/contact': layout('Contact', '', '<p>support@northwind-wholesale.com · privacy@northwind-wholesale.com</p>'),
  },
  4514: { // email claimed by research is not on the page
    '/': layout('Quiet Co', 'Quiet Co builds things.', '<p>Hi</p>'),
    '/contact': layout('Contact', '', '<p>Use our form.</p>'),
  },
  4516: { // B2C local business: café with a published email, menu headings and a careers page
    '/': layout('Sunrise Café — Breakfast & coffee in downtown Austin', 'Sunrise Café serves breakfast, brunch and specialty coffee in downtown Austin, Texas.', '<h1>Sunrise Café</h1><h2>Seasonal brunch menu with local Texas produce</h2><p>500 Congress Ave, Austin, TX 78701 · (512) 555-0100</p><a href="/careers/barista">Barista (full-time)</a>'),
    '/contact': layout('Contact', '', '<p>Catering &amp; events: <a href="mailto:hello@sunrise-cafe.com">hello@sunrise-cafe.com</a></p>'),
  },
  4515: { robots: 'User-agent: *\nDisallow: /', '/': layout('Blocked', 'nope', '<p>hello@blocked.com</p>') },
};
for (const [port, pages] of Object.entries(SITES)) {
  const site = express();
  site.get('/robots.txt', (req, res) => (pages.robots ? res.type('text/plain').send(pages.robots) : res.status(404).end()));
  site.get('*', (req, res) => (pages[req.path] ? res.type('html').send(pages[req.path]) : res.status(404).send('not found')));
  site.listen(Number(port), '127.0.0.1');
}
console.log('mock services ready on 4501 (+ sites 4511-4515)');
