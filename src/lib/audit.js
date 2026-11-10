// Website audit: what a business already uses, and the concrete gaps a visitor can see on its site.
// Every finding is something observable on their own pages (with the page URL), never a guess about
// their numbers. The email writer uses the top findings; the lead list filters on the gap keys.

// ---------------------------------------------------------------- vendors visible in public HTML
// [name, category, pattern]
export const VENDORS = [
  // appointment booking
  ['Calendly', 'booking', /calendly\.com/i], ['Acuity', 'booking', /acuityscheduling\.com|squarespacescheduling/i],
  ['Square Appointments', 'booking', /squareup\.com\/appointments|app\.squareup\.com\/appointments|book\.squareup/i],
  ['Vagaro', 'booking', /vagaro\.com/i], ['Booksy', 'booking', /booksy\.com/i], ['Fresha', 'booking', /fresha\.com/i],
  ['Mindbody', 'booking', /mindbodyonline\.com|healcode|brandedweb\.mindbody/i], ['GlossGenius', 'booking', /glossgenius\.com/i],
  ['Boulevard', 'booking', /joinblvd\.com|blvd\.co\b/i], ['StyleSeat', 'booking', /styleseat\.com/i], ['Schedulicity', 'booking', /schedulicity\.com/i],
  ['Setmore', 'booking', /setmore\.com/i], ['SimplyBook', 'booking', /simplybook\.(me|it)/i], ['Zocdoc', 'booking', /zocdoc\.com/i],
  ['NexHealth', 'booking', /nexhealth\.com/i], ['LocalMed', 'booking', /localmed\.com/i], ['Weave', 'booking', /getweave\.com/i],
  ['Jane', 'booking', /janeapp\.com/i], ['SimplePractice', 'booking', /simplepractice\.com/i], ['YouCanBookMe', 'booking', /youcanbook\.me/i],
  ['Phorest', 'booking', /phorest\.com/i], ['Zenoti', 'booking', /zenoti\.com/i], ['Mangomint', 'booking', /mangomint\.com/i], ['MyTime', 'booking', /mytime\.com/i],
  ['Wix Bookings', 'booking', /\/book-online|bookings-checkout|wix-bookings/i],
  ['Pike13', 'booking', /pike13\.com/i], ['Zen Planner', 'booking', /zenplanner\.com/i], ['Wodify', 'booking', /wodify\.com/i], ['ClubReady', 'booking', /clubready\.com/i],
  ['Glofox', 'booking', /glofox\.com/i], ['WellnessLiving', 'booking', /wellnessliving\.com/i], ['Momence', 'booking', /momence\.com/i], ['Mariana Tek', 'booking', /marianatek/i],
  // field service (home services: booking + jobs + CRM in one)
  ['Housecall Pro', 'fieldservice', /housecallpro\.com/i], ['Jobber', 'fieldservice', /getjobber\.com/i], ['ServiceTitan', 'fieldservice', /servicetitan\.com/i],
  ['Workiz', 'fieldservice', /workiz\.com/i], ['Service Fusion', 'fieldservice', /servicefusion\.com/i],
  // hotels
  ['Cloudbeds', 'hotelbooking', /cloudbeds\.com/i], ['ThinkReservations', 'hotelbooking', /thinkreservations\.com/i], ['Little Hotelier', 'hotelbooking', /littlehotelier/i],
  ['ResNexus', 'hotelbooking', /resnexus\.com/i], ['WebRezPro', 'hotelbooking', /webrezpro/i], ['SiteMinder', 'hotelbooking', /siteminder|thebookingbutton/i],
  ['Mews', 'hotelbooking', /mews\.(com|li)\b/i], ['Lodgify', 'hotelbooking', /lodgify\.com/i], ['SynXis', 'hotelbooking', /synxis\.com/i],
  // restaurants
  ['OpenTable', 'reservations', /opentable\.com/i], ['Resy', 'reservations', /resy\.com/i], ['Tock', 'reservations', /exploretock\.com/i],
  ['SevenRooms', 'reservations', /sevenrooms\.com/i], ['Yelp Reservations', 'reservations', /yelp\.com\/reservations/i],
  ['Toast', 'ordering', /toasttab\.com/i], ['ChowNow', 'ordering', /chownow\.com/i], ['Olo', 'ordering', /\bolo\.com\b/i], ['BentoBox', 'ordering', /getbento\.com/i],
  ['Popmenu', 'ordering', /popmenu\.com/i], ['Slice', 'ordering', /slicelife\.com/i], ['Owner.com', 'ordering', /owner\.com\//i], ['Square Online', 'ordering', /square\.site|squareup\.com\/store/i],
  ['SpotOn', 'ordering', /spoton\.com/i], ['Lunchbox', 'ordering', /lunchbox\.io/i], ['MenuDrive', 'ordering', /menudrive/i], ['Clover Online Ordering', 'ordering', /clover\.com\/online-ordering/i],
  // point of sale
  ['Square', 'pos', /squareup\.com|square\.site/i], ['Clover', 'pos', /clover\.com/i], ['Lightspeed', 'pos', /lightspeed(hq|pos)/i], ['Revel', 'pos', /revelsystems/i],
  // e-commerce
  ['Shopify', 'ecommerce', /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i], ['WooCommerce', 'ecommerce', /woocommerce/i], ['BigCommerce', 'ecommerce', /bigcommerce/i],
  ['Ecwid', 'ecommerce', /ecwid/i], ['Magento', 'ecommerce', /Mage\.Cookies|data-mage-init|\/static\/version\d+\/frontend\//],
  // CRM, email marketing, lead follow-up
  ['HubSpot', 'crm', /js\.hs-scripts\.com|hsforms|hs-analytics|js\.hubspot\.com/i], ['Salesforce', 'crm', /salesforce\.com|force\.com|pardot/i],
  ['Zoho', 'crm', /zoho\.(com|eu)/i], ['Pipedrive', 'crm', /pipedrive/i], ['GoHighLevel', 'crm', /leadconnectorhq|msgsndr|gohighlevel/i], ['Keap', 'crm', /infusionsoft|keap\.com/i],
  ['Mailchimp', 'email', /mailchimp|list-manage\.com|chimpstatic/i], ['Klaviyo', 'email', /klaviyo/i], ['ActiveCampaign', 'email', /activehosted\.com|activecampaign/i],
  ['Constant Contact', 'email', /constantcontact|ctctcdn/i],
  ['Follow Up Boss', 'crm', /followupboss/i], ['kvCORE', 'crm', /kvcore|insiderealestate/i], ['Lofty', 'crm', /chime\.me|lofty\.com/i], ['BoomTown', 'crm', /boomtownroi/i],
  ['Sierra Interactive', 'crm', /sierrainteractive/i], ['CINC', 'crm', /cincpro\.com/i], ['Real Geeks', 'crm', /realgeeks/i], ['LionDesk', 'crm', /liondesk/i], ['Ylopo', 'crm', /ylopo/i],
  ['Clio', 'crm', /clio\.com|clio-grow/i], ['Lawmatics', 'crm', /lawmatics/i], ['MyCase', 'crm', /mycase\.com/i], ['PracticePanther', 'crm', /practicepanther/i],
  ['TaxDome', 'portal', /taxdome/i], ['ShareFile', 'portal', /sharefile/i], ['Canopy', 'portal', /getcanopy\.com/i], ['Liscio', 'portal', /liscio/i], ['SmartVault', 'portal', /smartvault/i],
  ['Podium', 'chat', /podium\.com/i], ['Birdeye', 'chat', /birdeye\.com/i], ['Thryv', 'crm', /thryv\.com/i],
  // chat
  ['Intercom', 'chat', /intercom/i], ['Drift', 'chat', /drift\.com|js\.driftt/i], ['Tawk.to', 'chat', /tawk\.to/i], ['LiveChat', 'chat', /livechatinc/i], ['Tidio', 'chat', /tidio/i],
  ['Crisp', 'chat', /crisp\.chat/i], ['Zendesk', 'chat', /zdassets|zopim/i], ['Olark', 'chat', /olark/i], ['Freshchat', 'chat', /freshchat/i],
  // real estate listing search (IDX)
  ['IDX Broker', 'idx', /idxbroker|idx\.broker/i], ['Showcase IDX', 'idx', /showcaseidx/i], ['iHomefinder', 'idx', /ihomefinder/i], ['dsIDXpress', 'idx', /diversesolutions|dsidxpress/i],
  ['Buying Buddy', 'idx', /buyingbuddy/i], ['Realtyna', 'idx', /realtyna/i], ['Placester', 'idx', /placester/i], ['Luxury Presence', 'idx', /luxurypresence/i], ['AgentFire', 'idx', /agentfire/i],
  // forms
  ['Typeform', 'forms', /typeform/i], ['JotForm', 'forms', /jotform/i], ['Google Forms', 'forms', /docs\.google\.com\/forms|forms\.gle/i], ['Wufoo', 'forms', /wufoo/i],
  ['Formstack', 'forms', /formstack/i], ['Cognito Forms', 'forms', /cognitoforms/i], ['Gravity Forms', 'forms', /gform_|gravityforms/i], ['Contact Form 7', 'forms', /wpcf7/i], ['WPForms', 'forms', /wpforms/i],
  // payments
  ['Stripe', 'payments', /js\.stripe\.com|checkout\.stripe/i], ['PayPal', 'payments', /paypal\.com\/sdk|paypalobjects/i], ['LawPay', 'payments', /lawpay/i],
  // site builders
  ['Wix', 'builder', /wixstatic\.com|static\.wixstatic|_wixCIDX|wix\.com/i], ['Squarespace', 'builder', /static1\.squarespace|squarespace\.com/i],
  ['GoDaddy Website Builder', 'builder', /img1\.wsimg\.com|websites\.godaddy/i], ['Weebly', 'builder', /weebly\.com|editmysite/i], ['Duda', 'builder', /multiscreensite|dudaone|dudamobile/i],
  ['WordPress', 'builder', /wp-content\/|wp-includes\//i], ['Webflow', 'builder', /webflow\.(js|com)|data-wf-site/i], ['Jimdo', 'builder', /jimdo/i], ['Strikingly', 'builder', /strikingly/i],
  ['Showit', 'builder', /showit\.co/i], ['Hibu', 'builder', /hibu/i],
];

// Third-party platforms a site sends its customers to (they take a fee or keep the lead).
const OUTBOUND = [
  ['Zillow', 'listings', /zillow\.com/i], ['Realtor.com', 'listings', /realtor\.com/i], ['Redfin', 'listings', /redfin\.com/i], ['Homes.com', 'listings', /homes\.com/i],
  ['Trulia', 'listings', /trulia\.com/i], ['LoopNet', 'listings', /loopnet\.com/i],
  ['DoorDash', 'delivery', /doordash\.com/i], ['Uber Eats', 'delivery', /ubereats\.com/i], ['Grubhub', 'delivery', /grubhub\.com/i], ['Postmates', 'delivery', /postmates\.com/i], ['Seamless', 'delivery', /seamless\.com/i],
  ['Booking.com', 'ota', /booking\.com/i], ['Expedia', 'ota', /expedia\.com/i], ['Airbnb', 'ota', /airbnb\.com/i], ['Hotels.com', 'ota', /hotels\.com/i], ['VRBO', 'ota', /vrbo\.com/i],
];

// Free website addresses (a business on one of these has no domain of its own).
export const FREE_HOSTS = [
  ['wixsite.com', 'Wix'], ['godaddysites.com', 'GoDaddy'], ['weebly.com', 'Weebly'], ['square.site', 'Square'], ['squarespace.com', 'Squarespace'], ['mystrikingly.com', 'Strikingly'],
  ['carrd.co', 'Carrd'], ['business.site', 'Google'], ['sites.google.com', 'Google Sites'], ['webnode.com', 'Webnode'], ['jimdosite.com', 'Jimdo'], ['site123.me', 'Site123'],
  ['wordpress.com', 'WordPress.com'], ['blogspot.com', 'Blogger'], ['yolasite.com', 'Yola'], ['ueniweb.com', 'UENI'], ['wixstudio.io', 'Wix'],
];
export const freeHostOf = (domain) => FREE_HOSTS.find(([h]) => String(domain || '').toLowerCase() === h || String(domain || '').toLowerCase().endsWith('.' + h)) || null;

export const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|sbcglobal|bellsouth|verizon|cox|charter|earthlink|protonmail|proton)\.[a-z.]+$/i;
const MAIL_NAME = (email) => {
  const d = String(email || '').split('@')[1] || '';
  const m = { gmail: 'Gmail', googlemail: 'Gmail', yahoo: 'Yahoo', ymail: 'Yahoo', hotmail: 'Hotmail', outlook: 'Outlook', live: 'Outlook', msn: 'MSN', aol: 'AOL', icloud: 'iCloud', me: 'iCloud', mac: 'iCloud' };
  return m[d.split('.')[0]] || d;
};

const SOCIAL = [['Facebook', /facebook\.com|fb\.com/i], ['Instagram', /instagram\.com/i], ['Linktree', /linktr\.ee/i], ['Yelp', /yelp\.com/i], ['TikTok', /tiktok\.com/i]];
export const socialOf = (url) => (SOCIAL.find(([, re]) => re.test(String(url || ''))) || [null])[0];

// ---------------------------------------------------------------- collecting signals from each page
const strip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&copy;/gi, '©').replace(/\s+/g, ' ').trim();
const short = (t, n = 70) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);
const abs = (href, url) => { try { return new URL(href, url).toString(); } catch { return ''; } };

export function emptySignals() {
  return { https: null, viewport: null, metaDescription: null, h1: null, copyrightYear: null, vendors: {}, forms: [], pdfs: [], outbound: {}, ctas: [], phoneOnly: null,
    portal: null, apps: {}, listingsPage: null, valuation: null, resumeByEmail: null, pages: 0 };
}

const PDF_KIND = [['menu', /menu|carta|drinks|wine list|brunch|lunch|dinner/i], ['form', /form|intake|registration|new patient|patient info|medical history|consent|application|questionnaire|health history/i],
  ['schedule', /schedule|timetable|class(es)? times/i], ['price', /price|pricing|rates|fee schedule/i]];

const CTA = /\b(book( now| online| an appointment| a table)?|schedule( now| online| an appointment| a visit| service)?|request (an? )?(appointment|quote|estimate|consultation)|get (a |your )?(free )?(quote|estimate)|free (quote|estimate|consultation)|order (now|online|pickup|delivery)|reserve( a table| now)?|make a reservation|appointments?)\b/i;
const PHONE_ONLY = /\b(call (us )?(today |now )?(to|for) (book|schedule|make|set up|request|an appointment|a quote|an estimate|a free estimate|reservations?)|please call (to|for) (book|schedule|an appointment|reservations?)|to (book|schedule)( an appointment| a visit)?,? (please )?call|appointments? (are )?by phone|call for (an )?(appointment|estimate|quote|reservations?))\b/i;
const PORTAL = /\b((patient|client|customer|member|tenant|owner|resident|partner) (portal|login|log in|sign in)|my account|track (your |a )?(order|shipment|package|load)|shipment tracking|order tracking|client area)\b/i;
const LISTINGS = /\b(search (all )?(homes|properties|listings|mls)|featured (listings|properties)|homes for sale|our listings|property search|view (all )?listings|current listings|available properties|idx)\b/i;
const VALUATION = /\b(home (value|valuation)|what'?s my home worth|home worth|free (market analysis|cma|home evaluation)|market analysis|sell(ing)? your home)\b/i;

/** Read one page (homepage first) and add what it shows to the running signals. */
export function collectSignals(html, url, path, sig) {
  sig.pages++;
  const text = strip(html);
  if (path === '/') {
    sig.https = /^https:/i.test(url);
    sig.viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    sig.metaDescription = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html) || /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(html);
    sig.h1 = /<h1[\s>]/i.test(html);
    const years = [...text.matchAll(/(?:©|copyright|\(c\))\s*(?:[a-z.,\s]{0,30})?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] || m[1]));
    if (years.length) sig.copyrightYear = Math.max(...years);
  }
  for (const [name, cat, re] of VENDORS) if (!sig.vendors[name] && re.test(html)) sig.vendors[name] = { cat, url };
  // forms that collect a lead (email / phone / message), native or embedded
  for (const m of html.matchAll(/<form[\s\S]*?<\/form>/gi)) {
    const f = m[0];
    if (/type=["']search["']|name=["'](s|q|search)["']/i.test(f) && !/textarea|type=["']email["']/i.test(f)) continue;
    if (/type=["']email["']|type=["']tel["']|<textarea/i.test(f) && sig.forms.length < 6) sig.forms.push({ url, kind: 'native', newsletter: !/<textarea/i.test(f) && !/type=["']tel["']/i.test(f) });
  }
  if (/<iframe[^>]+(typeform|jotform|docs\.google\.com\/forms|wufoo|formstack|cognitoforms|hsforms|form\.jotform)/i.test(html) && sig.forms.length < 6) sig.forms.push({ url, kind: 'embed' });
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]; const t = strip(m[2]).slice(0, 120); const full = abs(href, url);
    if (!full) continue;
    if (/\.pdf(\?|#|$)/i.test(href) && sig.pdfs.length < 12) {
      const label = t || decodeURIComponent(href.split('/').pop().replace(/\.pdf.*/i, '').replace(/[-_]+/g, ' '));
      const kind = (PDF_KIND.find(([, re]) => re.test(`${label} ${href}`)) || ['other'])[0];
      if (!sig.pdfs.some((p) => p.url === full)) sig.pdfs.push({ text: short(label), url: full, kind, page: url });
    }
    for (const [name, cat, re] of OUTBOUND) {
      if (sig.outbound[name] || !re.test(full) || re.test(url)) continue;
      // A listing portal counts only when the link is about listings (not the agent's profile or review icon).
      if (cat === 'listings' && (/\/profile\/|\/reviews?\b|agent/i.test(full) || !(LISTINGS.test(t) || /listing|homes?\b|propert|for sale|search|mls|homedetails|for_sale/i.test(`${t} ${full}`)))) continue;
      sig.outbound[name] = { cat, text: short(t || name), href: full, url };
    }
    if (/apps\.apple\.com|itunes\.apple\.com\/.*app/i.test(full)) sig.apps.ios = full;
    if (/play\.google\.com\/store\/apps/i.test(full)) sig.apps.android = full;
    if (t && CTA.test(t) && sig.ctas.length < 10) sig.ctas.push({ text: short(t, 50), href: full, url, tel: /^tel:/i.test(href), mail: /^mailto:/i.test(href) });
    if (!sig.portal && t && PORTAL.test(t)) sig.portal = { text: short(t, 50), url: full };
    if (!sig.listingsPage && (LISTINGS.test(t) || /\/(listings|properties|homes-for-sale|idx|mls|search-homes)(\/|$|\?)/i.test(href)) && !OUTBOUND.some(([, c, re]) => c === 'listings' && re.test(full))) sig.listingsPage = { text: short(t || href, 50), url: full };
    if (!sig.valuation && (VALUATION.test(t) || /home-?(value|valuation|worth)/i.test(href))) sig.valuation = { text: short(t || href, 50), url: full };
  }
  if (!sig.phoneOnly) { const m = text.match(PHONE_ONLY); if (m) sig.phoneOnly = { text: short(text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 30).trim(), 90), url }; }
  if (!sig.resumeByEmail) { const m = text.match(/\b(e-?mail|send) (us )?your (resume|cv)\b[^.]{0,60}/i); if (m) sig.resumeByEmail = { text: short(m[0], 90), url }; }
  return sig;
}

/** Internal links on the homepage worth reading for an audit (menu, booking, patients, listings…). */
export function interestingLinks(html, url, max = 4) {
  const out = [];
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const full = abs(m[1], url); const t = strip(m[2]);
    if (!full.startsWith(origin) || /\.(pdf|jpe?g|png|gif|zip)(\?|$)/i.test(full)) continue;
    const path = new URL(full).pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || out.includes(path)) continue;
    if (/menu|order|book|appointment|schedule|patient|forms?\b|new-patient|listing|propert|homes|search|reserv|quote|estimate|pricing|services|shop|store|portal|careers|apply/i.test(`${path} ${t}`)) out.push(path);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- industry profiles
const PROFILES = [
  ['real_estate', /real estate|realtor|estate agent|realty|brokerage|property management|homes for sale/i],
  ['health', /dent|orthodont|clinic|medical|doctor|physio|physical therap|chiropract|optometr|optician|veterinar|animal hospital|dermatolog|pediatric|health ?care|med ?spa|therapist|counsel/i],
  ['beauty', /salon|hair|beauty|barber|\bspa\b|nail|lash|brow|wax|massage|aesthetic|tattoo/i],
  ['fitness', /gym|fitness|yoga|pilates|crossfit|martial arts|boxing|personal train|dance studio/i],
  ['restaurant', /restaurant|caf[eé]|coffee|bakery|\bbar\b|\bpub\b|pizz|food|grill|kitchen|diner|bistro|taco|sushi|brewery|catering|eatery|deli\b/i],
  ['home_services', /plumb|electric|hvac|heating|cooling|air condition|roof|landscap|lawn|cleaning|pest|repair|contractor|remodel|painting|handyman|garage door|locksmith|pool|home services|builder/i],
  ['hotel', /hotel|motel|\binn\b|b&b|bed and breakfast|guest ?house|lodge|resort|hostel/i],
  ['auto', /car dealer|auto|car repair|mechanic|\btires?\b|body shop|collision/i],
  ['legal', /\blaw\b|legal|attorney|lawyer/i],
  ['finance', /account|\bcpa\b|\btax\b|bookkeep|insurance|financial|wealth/i],
  ['logistics', /logistic|freight|trucking|transport|3pl|shipping|courier|moving/i],
  ['wholesale', /wholesale|distribut|supply|manufactur/i],
  ['staffing', /recruit|staffing|talent|employment agency/i],
  ['retail', /\bshop\b|\bstore\b|retail|boutique|florist|clothing|furniture|gift|jewel|bookstore/i],
];
export function profileOf(c) {
  if (c.offer === 'B') return 'agency';
  // The category is the strongest signal (a law firm's description may mention "medical bills"), then the name, then the rest.
  for (const hay of [c.industry, `${c.name || ''} ${c.services || ''}`, c.description]) {
    const hit = PROFILES.find(([, re]) => re.test(String(hay || '')));
    if (hit) return hit[0];
  }
  return 'general';
}

const LOCAL = new Set(['real_estate', 'health', 'beauty', 'fitness', 'restaurant', 'home_services', 'hotel', 'auto', 'retail']);
const has = (sig, cat) => Object.entries(sig.vendors || {}).filter(([, v]) => v.cat === cat).map(([k]) => k);
const outbound = (sig, cat) => Object.entries(sig.outbound || {}).filter(([, v]) => v.cat === cat);
const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Turn the collected signals into findings for one company.
 * Returns { profile, has: {category: [names]}, findings: [{key, weight, observed, evidence, why, fix, keywords}], gaps: [keys] }
 */
export function auditSite(sig, c, { now = new Date() } = {}) {
  const domain = c.domain;
  const profile = profileOf(c);
  if (profile === 'agency') return agencyAudit(sig, c, now);
  const F = [];
  const add = (key, weight, observed, url, why, fix, keywords) => F.push({ key, weight, observed, evidence: url, why, fix, keywords });
  const home = `https://${domain}/`;
  const booking = [...has(sig, 'booking'), ...has(sig, 'fieldservice')];
  const crm = [...has(sig, 'crm'), ...has(sig, 'fieldservice')];
  const nativeForms = (sig.forms || []).filter((f) => !f.newsletter);
  const anyForm = nativeForms.length > 0 || has(sig, 'forms').length > 0 || (sig.forms || []).some((f) => f.kind === 'embed');
  const bookingCta = (sig.ctas || []).find((x) => !x.tel && !x.mail && /book|schedule|appointment|reserve/i.test(x.text));
  const free = freeHostOf(domain);

  // ---- every kind of business
  if (free) add('free_subdomain', 5, `Your website is on a free ${free[1]} address (${domain}) instead of a domain of your own`, home,
    'People tend to trust a business more when the website and the email are on its own name, and free addresses rank poorly on Google.',
    'move you to your own domain with a matching email address, and rebuild the site so it is quick on phones', ['domain', free[1].toLowerCase()]);
  if (sig.viewport === false) add('not_mobile', 4, `${domain} isn't set up for phones, so on a mobile screen it shows the desktop page shrunk down`, home,
    'Most people look up a local business on their phone, and Google ranks sites that work on phones higher.',
    'a fast version of the site built for phones first', ['phone', 'mobile']);
  if (sig.https === false) add('no_https', 3, `${domain} loads without https, so Chrome shows "Not secure" next to the address`, home,
    'That warning puts some visitors off before they read anything, and contact forms on an insecure page look risky.',
    'secure hosting with https', ['secure', 'https']);
  const thisYear = now.getUTCFullYear();
  if (sig.copyrightYear && sig.copyrightYear <= thisYear - 4 && sig.copyrightYear >= 1995) add('outdated', 2, `The footer on ${domain} still says © ${sig.copyrightYear}`, home,
    'Visitors often read that as a sign nobody is looking after the site.',
    'a refreshed site that you can update yourself in a few minutes', [String(sig.copyrightYear), 'footer']);
  if (sig.metaDescription === false && profile !== 'agency') add('no_meta', 1, `The homepage of ${domain} has no description set for Google, so Google picks random text from the page for your search result`, home,
    'The search result is the first thing people read about you.', 'proper titles and descriptions for every page so the search results read well', ['google', 'search']);

  // ---- per industry
  const phoneBook = sig.phoneOnly;
  const lacksBooking = !booking.length && !bookingCta;
  const bookingFinding = (what, fix, why) => {
    if (phoneBook) add('phone_booking', 5, `${domain} asks people to call ${what} ("${phoneBook.text}")`, phoneBook.url, why, fix, ['call', 'online', 'book']);
    else if (lacksBooking) add('no_booking', 4, `I couldn't find a way to ${what.replace(/^to /, '')} online on ${domain}`, home, why, fix, ['online', 'book']);
  };
  const pdf = (kind) => (sig.pdfs || []).find((p) => p.kind === kind);

  switch (profile) {
    case 'real_estate': {
      const idx = has(sig, 'idx');
      const portals = outbound(sig, 'listings');
      if (!idx.length && portals.length) {
        const [name, o] = portals[0];
        add('listings_offsite', 5, `The listings link on ${domain} ("${o.text}") sends buyers to ${name}`, o.url,
          `Buyers who search on ${name} usually contact whichever agent ${name} shows them, so the lead often goes to someone else.`,
          'home search on your own site from your MLS feed, with a "book a showing" button on every property', [name.toLowerCase().replace(/\..*/, ''), 'listing']);
      } else if (!idx.length && !sig.listingsPage) {
        add('no_listings', 4, `I couldn't find a way to search homes for sale on ${domain}`, home,
          'Buyers end up searching on Zillow or Realtor.com instead, where other agents get the enquiry.',
          'home search on your own site from your MLS feed, with a "book a showing" button on every property', ['listing', 'search']);
      }
      if (!sig.valuation) add('no_valuation', 3, `There's no "what's my home worth" page on ${domain}`, home,
        'That page is where most seller leads come from on agent websites.',
        'a home valuation page that captures seller leads and sends them straight to you', ['worth', 'valuation']);
      if (!crm.length) add('no_crm', 3, anyForm ? `Enquiries on ${domain} go through a plain contact form` : `The only way to reach you on ${domain} is the phone number or an email link`, home,
        'New leads then wait in an inbox until someone has time, and in real estate the agent who answers first usually wins the client.',
        'a simple CRM that texts and emails every new lead within a minute and reminds your agents to follow up', ['lead', 'follow']);
      break;
    }
    case 'health': {
      const form = pdf('form');
      if (form) add('pdf_forms', 5, `The patient forms on ${domain} are PDFs ("${form.text}") that people print and fill in by hand`, form.page || form.url,
        'Someone at the front desk then types the same details into your system again.',
        'online intake forms patients fill in on their phone before the visit, landing straight in your system', ['form', 'pdf', 'print']);
      bookingFinding('to book an appointment', 'online booking that shows your real open times and sends automatic reminders, so the front desk spends less time on the phone',
        'People who look you up in the evening rarely call back the next day, they book wherever they can do it online.');
      break;
    }
    case 'beauty':
    case 'fitness': {
      bookingFinding(profile === 'fitness' ? 'to book a class or session' : 'to book an appointment',
        profile === 'fitness' ? 'class booking, memberships and payments in one place, with reminders' : 'online booking with deposits and automatic reminders, so no-shows drop and the phone rings less',
        'Most people book wherever they can do it in a minute on their phone, often late in the evening.');
      const sched = pdf('schedule');
      if (profile === 'fitness' && sched) add('pdf_schedule', 3, `The class schedule on ${domain} is a PDF ("${sched.text}")`, sched.page || sched.url,
        'Members can\'t book from it and it goes out of date the moment a class changes.', 'a live class schedule people can book from', ['schedule', 'pdf']);
      if (profile === 'fitness' && !sig.apps.ios && !sig.apps.android && !booking.length) add('no_app', 2, `There's no app for members linked on ${domain}`, home,
        'Members expect to book and pay from their phone.', 'a simple member app for booking classes, payments and notifications', ['app']);
      break;
    }
    case 'restaurant': {
      const direct = has(sig, 'ordering');
      const apps = outbound(sig, 'delivery').map(([k]) => k);
      if (!direct.length && apps.length) add('delivery_apps', 5, `Online orders on ${domain} go through ${list(apps)}`, sig.outbound[apps[0]].url,
        'The delivery apps take a cut of every order and keep the customer details for themselves.',
        'your own online ordering page tied into your POS, so you keep the whole order and your customer list', ['order', ...apps.map((a) => a.toLowerCase().split(' ')[0])]);
      else if (!direct.length && !/\bbar\b|\bpub\b|brewery/i.test(`${c.industry} ${c.name}`)) add('no_ordering', 4, `I couldn't find a way to order online on ${domain}`, home,
        'People who want pickup or delivery go to the apps or somewhere else.',
        'online ordering for pickup and delivery, tied into your POS', ['order', 'online']);
      const menu = pdf('menu');
      if (menu) add('pdf_menu', 4, `The menu on ${domain} is a PDF ("${menu.text}")`, menu.page || menu.url,
        'PDF menus are hard to read on a phone and Google can\'t show your dishes in search.',
        'a menu page that reads well on phones, shows up on Google and that you can update in a minute', ['menu', 'pdf']);
      if (/restaurant|\bbar\b|bistro|grill|sushi|steak/i.test(`${c.industry} ${c.name}`) && !has(sig, 'reservations').length && !(sig.ctas || []).some((x) => /reserv/i.test(x.text) && !x.tel))
        add('no_reservations', 2, `There's no way to reserve a table online on ${domain}`, home, 'A lot of people book a table late at night when you can\'t pick up the phone.',
          'online reservations with automatic reminders', ['reserv', 'table']);
      break;
    }
    case 'home_services': {
      bookingFinding('for a quote or to book a job', 'online booking and quote requests that drop straight into a job schedule, with automatic confirmations, reminders and follow-ups',
        'Most homeowners contact two or three companies and go with whoever gets back to them first.');
      break;
    }
    case 'hotel': {
      const engine = has(sig, 'hotelbooking');
      const otas = outbound(sig, 'ota').map(([k]) => k);
      if (!engine.length && otas.length) add('ota_booking', 5, `Bookings on ${domain} go through ${list(otas)}`, sig.outbound[otas[0]].url,
        'The booking sites take a commission on every stay and keep the guest\'s details.', 'direct booking on your own site with instant confirmation', ['book', 'direct', ...otas.map((o) => o.toLowerCase().split('.')[0])]);
      else if (!engine.length) add('no_booking', 4, `I couldn't find a way to book a room directly on ${domain}`, home,
        'Guests who can\'t book on your site book through the big platforms instead, and you pay their commission.', 'direct booking on your own site with instant confirmation', ['book', 'direct']);
      break;
    }
    case 'retail': {
      if (!has(sig, 'ecommerce').length && !has(sig, 'ordering').length) add('no_store', 4, `There's no online shop on ${domain}`, home,
        'People check online whether you have something before they drive over, and buy elsewhere if they can\'t.',
        'an online shop or click and collect that keeps stock in sync with your POS', ['shop', 'online']);
      break;
    }
    case 'auto': {
      if (/repair|mechanic|tire|body|collision|service/i.test(`${c.industry} ${c.name}`)) bookingFinding('to book a service', 'online service booking with reminders and status updates by text', 'People book their car in wherever they can pick a time online.');
      break;
    }
    case 'legal':
    case 'finance': {
      if (!anyForm) add('no_intake', 4, `There's no intake or enquiry form on ${domain}, just a phone number and email`, home,
        'Every new enquiry then starts with a round of emails or a phone call to collect the basics.',
        `an online intake form that collects the ${profile === 'legal' ? 'case details' : 'client details'} up front and books the first consultation`, ['form', 'intake']);
      if (!booking.length && !bookingCta) add('no_consult_booking', 3, `I couldn't find a way to book a consultation online on ${domain}`, home,
        'People comparing firms often go with the first one that lets them pick a time.', 'consultation booking with automatic reminders', ['book', 'consultation']);
      if (!sig.portal && !has(sig, 'portal').length && !has(sig, 'crm').length) add('no_portal', 3, `There's no client portal on ${domain} for sharing documents`, home,
        'Clients end up emailing sensitive documents back and forth.', 'a secure client portal for documents, e-signatures and status updates', ['portal', 'document']);
      break;
    }
    case 'logistics':
    case 'wholesale': {
      if (!anyForm) add('no_quote_form', 4, `Quote requests on ${domain} come in by email or phone, there's no quote form`, home,
        'Each request then needs someone to chase the missing details before it can be priced.',
        profile === 'logistics' ? 'an online quote form that collects lanes, weights and dates and feeds your system' : 'an online quote and order form that feeds straight into your system', ['quote', 'form']);
      if (!sig.portal) add('no_portal', 4, profile === 'logistics' ? `There's no customer login or shipment tracking page on ${domain}` : `Customers can't log in or place orders online on ${domain}`, home,
        profile === 'logistics' ? 'Customers then call or email to ask where their shipment is.' : 'Every order then arrives by email or phone and gets typed in by hand.',
        profile === 'logistics' ? 'a customer portal for quotes, tracking and documents' : 'a B2B ordering portal connected to your inventory', ['portal', profile === 'logistics' ? 'tracking' : 'order']);
      break;
    }
    case 'staffing': {
      if (sig.resumeByEmail) add('resume_by_email', 4, `Candidates apply on ${domain} by emailing their resume ("${sig.resumeByEmail.text}")`, sig.resumeByEmail.url,
        'Resumes then pile up in an inbox and get copied into your system by hand.', 'an application form that drops candidates straight into your system and keeps them updated', ['resume', 'apply']);
      if (!sig.portal) add('no_portal', 3, `There's no client or candidate login on ${domain}`, home, 'Clients and candidates email for every update.', 'a portal for clients to see candidates and for candidates to track their applications', ['portal']);
      break;
    }
    default: break;
  }
  // Lead capture for local businesses without any form (and no stronger booking finding)
  if (LOCAL.has(profile) && !anyForm && !F.some((f) => ['phone_booking', 'no_booking', 'no_crm', 'no_intake'].includes(f.key)))
    add('no_form', 3, `The only way to get in touch on ${domain} is the phone number or an email link, there's no enquiry form`, home,
      'People who visit after hours usually leave instead of writing an email.', 'an enquiry form that sends every lead into a simple CRM with an automatic reply', ['form', 'enquir', 'inquir']);

  const hasMap = {};
  for (const [name, v] of Object.entries(sig.vendors || {})) (hasMap[v.cat] ||= []).push(name);
  if (sig.apps?.ios || sig.apps?.android) hasMap.app = ['mobile app'];
  F.sort((a, b) => b.weight - a.weight);
  return { at: now.toISOString(), profile, has: hasMap, findings: F, gaps: F.map((f) => f.key), pages: sig.pages };
}

/**
 * Agencies are partners, not clients: never critique their site. Instead note what kind of work they do
 * and where that work usually needs engineering help (custom apps, integrations, backends).
 */
function agencyAudit(sig, c, now) {
  let facts = {};
  try { facts = JSON.parse(c.scan_facts || '{}'); } catch { facts = {}; }
  const home = `https://${c.domain}/`;
  const tech = new Set([...(facts.tech || []).map((t) => t.name), ...Object.keys(sig.vendors || {})]);
  const heads = (facts.headings || []).map((h) => h.text).join(' \n ');
  const hay = `${c.industry || ''} ${c.services || ''} ${c.description || ''} ${heads}`;
  const cases = (facts.caseStudies || []).map((x) => String(x.text || '').trim())
    .filter((t) => t.split(/\s+/).length <= 8 && !/^(see|view|read|learn|explore|discover|more|all|our|case stud|project|work|portfolio)\b|\b(project|projects|case study|more|work)$/i.test(t)).slice(0, 2);
  const work = cases.length ? ` (on your site: ${cases.map((x) => `"${x}"`).join(' and ')})` : '';
  const F = [];
  const add = (key, weight, observed, fix, keywords, evidence = home) => F.push({ key, weight, observed, evidence, why: '', fix, keywords });
  if (tech.has('Shopify') || /shopify/i.test(hay)) add('fit_shopify', 5, `You build Shopify stores${work}`, 'custom Shopify apps, ERP and 3PL syncs, subscriptions and B2B pricing logic behind the store', ['shopify']);
  if (tech.has('Webflow') || /webflow/i.test(hay)) add('fit_webflow', 5, `You build on Webflow${work}`, 'member areas, logins, custom integrations and backend logic that Webflow cannot do on its own', ['webflow']);
  if (/wordpress|woocommerce/i.test(hay)) add('fit_wordpress', 4, `You build WordPress sites${work}`, 'custom plugins, client portals, integrations and speed work behind WordPress sites', ['wordpress']);
  if (/\b(app|apps|mobile|saas|product design|web app)\b/i.test(hay)) add('fit_apps', 4, `Your site talks about apps and product work${work}`, 'the engineering side of app projects: APIs, databases, admin panels and integrations', ['app']);
  if (/hubspot|crm|marketing automation|salesforce/i.test(hay) || tech.has('HubSpot')) add('fit_crm', 4, `You do CRM and marketing automation work${work}`, 'CRM and HubSpot integrations, custom reporting dashboards and automations your clients ask for', ['crm', 'hubspot']);
  const devRole = (facts.hiring || []).find((h) => /develop|engineer|programm|full.?stack|front.?end|back.?end/i.test(h.text));
  if (devRole) add('fit_hiring', 5, `You're hiring for "${devRole.text}"`, 'senior developers on demand while you hire, or instead of hiring for every project', ['hiring', 'developer'], devRole.url);
  if (!F.length && /brand|design|creative|ux|ui/i.test(hay)) add('fit_design', 3, `Your work is mostly brand and design${work}`, 'turning approved designs into working websites, web apps and portals, without you hiring developers', ['design']);
  if (!F.length) add('fit_general', 2, `You run client projects for ${c.industry ? c.industry.toLowerCase() : 'businesses'}${work}`, 'the backend, integration and automation work behind client projects', ['project']);
  F.sort((a, b) => b.weight - a.weight);
  const hasMap = {};
  for (const [name, v] of Object.entries(sig.vendors || {})) (hasMap[v.cat] ||= []).push(name);
  return { at: now.toISOString(), profile: 'agency', has: hasMap, findings: F, gaps: [], pages: sig.pages };
}

/** Findings for a business that has no website at all (found on the map with only a phone/email). */
export function auditNoWebsite(c, { email = c.contact_email, social = c.social_url, now = new Date() } = {}) {
  const profile = profileOf(c);
  const F = [];
  const where = c.profile_url || c.us_presence_url || '';
  const ownDomain = email && !FREE_MAIL.test(email) ? String(email).split('@')[1] : '';
  const extras = { restaurant: 'online ordering and a POS setup', retail: 'an online shop that syncs with a POS', health: 'online booking and intake forms', beauty: 'online booking with reminders',
    fitness: 'class booking and payments', home_services: 'online quote requests and job scheduling', real_estate: 'listing search and a lead CRM', hotel: 'direct booking' }[profile] || 'online booking or enquiries';
  if (ownDomain) F.push({ key: 'no_website', weight: 5, observed: `${ownDomain} has no website on it yet, even though you use it for email`, evidence: where,
    why: 'Most people look a business up online before they call or visit, and without a site there\'s nothing to show them.',
    fix: `a fast, simple website on ${ownDomain} with your services, hours and contact details, plus ${extras}`, keywords: ['website', 'site'] });
  else if (social) F.push({ key: 'social_only', weight: 5, observed: `${c.name} doesn't have its own website. The listing points to your ${socialOf(social) || 'social media'} page instead`, evidence: where,
    why: 'A social page can\'t take bookings or orders and Google shows it below proper websites.',
    fix: `a simple website of your own with your services, hours and ${extras}`, keywords: ['website', 'site', (socialOf(social) || '').toLowerCase()].filter(Boolean) });
  else F.push({ key: 'no_website', weight: 5, observed: `I couldn't find a website for ${c.name}, only the map listing with your phone and email`, evidence: where,
    why: 'Most people look a business up online before they call or visit, and without a site there\'s nothing to show them.',
    fix: `a fast, simple website with your services, hours and contact details, plus ${extras}`, keywords: ['website', 'site'] });
  if (email && FREE_MAIL.test(email)) F.push({ key: 'free_email', weight: 3, observed: `The business email is a ${MAIL_NAME(email)} address`, evidence: where,
    why: 'An address on your own domain looks more established and is less likely to land in spam.', fix: 'a professional email address on your own domain', keywords: [MAIL_NAME(email).toLowerCase(), 'domain', 'email'] });
  if (['restaurant', 'retail', 'beauty', 'fitness', 'home_services', 'health'].includes(profile)) F.push({ key: 'no_crm', weight: 2, observed: `There's no online way to ${profile === 'restaurant' ? 'order or reserve' : 'book or enquire'} with ${c.name}`, evidence: where,
    why: 'Customers who find you after hours can\'t do anything until you\'re open again.', fix: 'a simple CRM that keeps every customer and enquiry in one place with automatic follow-ups', keywords: ['crm', 'customer', 'online'] });
  return { at: now.toISOString(), profile, has: {}, findings: F, gaps: F.map((f) => f.key), pages: 0, noWebsite: true };
}

export const GAP_LABELS = {
  no_website: 'No website', social_only: 'Only a social media page', free_subdomain: 'Free website address', free_email: 'Gmail/Yahoo email',
  not_mobile: 'Not built for phones', no_https: 'No https', outdated: 'Outdated footer', no_meta: 'No Google description',
  listings_offsite: 'Listings go to Zillow etc.', no_listings: 'No home search', no_valuation: 'No home valuation page', no_crm: 'No lead follow-up system',
  pdf_forms: 'Paper/PDF forms', phone_booking: 'Booking by phone only', no_booking: 'No online booking', pdf_schedule: 'PDF class schedule', no_app: 'No member app',
  delivery_apps: 'Orders via delivery apps', no_ordering: 'No online ordering', pdf_menu: 'PDF menu', no_reservations: 'No online reservations',
  ota_booking: 'Bookings via Booking.com etc.', no_store: 'No online shop', no_intake: 'No intake form', no_consult_booking: 'No consultation booking',
  no_portal: 'No client portal', no_quote_form: 'No quote form', resume_by_email: 'Applications by email', no_form: 'No enquiry form',
};

/** Groups for the lead list filter. */
export const GAP_GROUPS = [
  ['no_website', 'No website', ['no_website', 'social_only', 'free_subdomain']],
  ['booking', 'No online booking', ['phone_booking', 'no_booking', 'no_consult_booking', 'ota_booking']],
  ['ordering', 'No own online ordering', ['delivery_apps', 'no_ordering', 'no_store']],
  ['crm', 'No CRM / lead follow-up', ['no_crm', 'no_form', 'no_intake', 'no_quote_form', 'resume_by_email']],
  ['paper', 'PDF menus & forms', ['pdf_forms', 'pdf_menu', 'pdf_schedule']],
  ['mobile', 'Not built for phones', ['not_mobile', 'no_https']],
  ['portal', 'No client portal', ['no_portal', 'listings_offsite', 'no_listings']],
];
