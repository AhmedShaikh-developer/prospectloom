// Build personalization suggestions from facts found on the lead's own website.
// Every suggestion quotes a real page element and carries the page URL as its source.
const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/[|•·].*$/, '').trim();
const short = (t, n = 90) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);

export function suggestions(company) {
  let facts = {};
  try { facts = JSON.parse(company.scan_facts || '{}'); } catch { facts = {}; }
  const out = [];
  const add = (kind, text, source_url, basis) => {
    if (text && source_url && !out.some((s) => s.text === text)) out.push({ kind, text, source_url, basis });
  };
  for (const c of (facts.caseStudies || []).slice(0, 3)) {
    add('case_study', `I was looking through your work and the "${short(clean(c.text))}" project stood out.`, c.url, `Case study link: ${c.text}`);
  }
  for (const h of (facts.hiring || []).slice(0, 2)) {
    add('hiring', `Saw you're hiring for a ${short(clean(h.text), 60)} — usually a sign the team is growing faster than the processes behind it.`, h.url, `Job posting: ${h.text}`);
  }
  const tech = (facts.tech || []).filter((t) => !['Google Analytics', 'React'].includes(t.name));
  const commerce = tech.find((t) => ['Shopify', 'WooCommerce', 'Magento', 'BigCommerce'].includes(t.name));
  const crm = tech.find((t) => ['HubSpot', 'Salesforce', 'Zoho'].includes(t.name));
  if (company.offer === 'B' && commerce) add('tech', `Noticed your own site runs on ${commerce.name}, so I'm guessing a lot of your client work lives there too.`, commerce.url, `Detected ${commerce.name} in page source`);
  else if (commerce && company.offer === 'C') add('tech', `Noticed your shop runs on ${commerce.name} — I help local businesses connect stores like that to bookings, stock and payments.`, commerce.url, `Detected ${commerce.name} in page source`);
  else if (commerce) add('tech', `Noticed your store runs on ${commerce.name} — I work on the integrations around platforms like that (inventory, ERP, fulfilment).`, commerce.url, `Detected ${commerce.name} in page source`);
  if (crm) add('tech', `I saw you use ${crm.name} on your site — connecting it properly to the rest of your systems is a lot of what we do.`, crm.url, `Detected ${crm.name} in page source`);
  const nameLc = String(company.name || '').toLowerCase();
  const pageHeads = (facts.headings || []).filter((h) => h.level <= 2
    && !/^(home|about|contact|services|blog|news|careers|menu|welcome)/i.test(h.text)
    && h.text.trim().split(/\s+/).length >= 4                       // skip logos / one-word headings
    && h.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() !== nameLc.replace(/[^a-z0-9 ]/g, '').trim());
  for (const h of pageHeads.slice(0, 2)) {
    add('headline', `Your site's line "${short(clean(h.text))}" caught my eye.`, h.url, `Heading on ${h.path || '/'}`);
  }
  if (company.us_presence && company.us_presence_url && company.industry) {
    const loc = (company.us_presence.match(/,\s*([A-Za-z .]+),\s*([A-Z]{2})\s+\d{5}/) || []).slice(1).join(', ');
    if (loc) add('location', `Came across ${company.name} while looking at ${company.industry.toLowerCase()} companies in ${loc}.`, company.us_presence_url, `Address: ${company.us_presence}`);
  }
  if (company.description && company.profile_url) {
    add('description', `Read that ${company.name} ${lowerFirst(short(stripName(company.description, company.name), 110))}`, company.profile_url, 'Site meta description');
  }
  return out;
}

function stripName(desc, name) {
  return String(desc).replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(is|are)\\s+`, 'i'), 'is ').replace(/\.$/, '') + '.';
}
function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
