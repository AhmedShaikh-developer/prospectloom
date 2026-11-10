import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `ll-unit-audit-${process.pid}.db`);
process.env.APP_MODE = 'test';
process.env.ENV_FILE = '/nonexistent';

const { emptySignals, collectSignals, auditSite, auditNoWebsite, profileOf, interestingLinks, freeHostOf } = await import('../../src/lib/audit.js');
const { returnDate } = await import('../../src/services/replies.js');
const { validateDraft } = await import('../../src/services/outreach.js');
const { validateAnswer } = await import('../../src/services/responder.js');
const { setSetting } = await import('../../src/lib/settings.js');

const page = (body, head = '<meta name="viewport" content="width=device-width"><meta name="description" content="A family business in Austin, Texas since 1998.">') => `<!doctype html><html><head><title>x</title>${head}</head><body>${body}</body></html>`;
const audit = (pages, c) => {
  const sig = emptySignals();
  for (const [p, html] of pages) collectSignals(html, `https://${c.domain}${p}`, p, sig);
  return auditSite(sig, c, { now: new Date('2026-11-10T12:00:00Z') });
};

test('profile: the category decides first (a law firm that mentions medical bills is still legal)', () => {
  assert.equal(profileOf({ industry: 'Lawyers', description: 'We help with medical bills after an injury' }), 'legal');
  assert.equal(profileOf({ industry: 'Dentists' }), 'health');
  assert.equal(profileOf({ industry: 'Real estate agents' }), 'real_estate');
  assert.equal(profileOf({ industry: 'Restaurants' }), 'restaurant');
  assert.equal(profileOf({ offer: 'B', industry: 'Design studio' }), 'agency');
});

test('real estate: listings sent to Zillow, no valuation page, plain contact form', () => {
  const a = audit([['/', page('<a href="https://www.zillow.com/homes/for_sale/Austin-TX/">Search homes for sale</a><form><input type="email"><textarea></textarea></form>')]], { domain: 'lakeside.com', industry: 'Real estate agents' });
  assert.equal(a.findings[0].key, 'listings_offsite');
  assert.match(a.findings[0].observed, /Zillow/);
  assert.deepEqual(a.findings.map((f) => f.key).sort(), ['listings_offsite', 'no_crm', 'no_valuation'].sort());
  // an agent's Zillow review/profile icon is not "listings on Zillow"
  const b = audit([['/', page('<a href="https://www.zillow.com/profile/jane-doe/">Zillow icon</a><a href="/listings">Featured listings</a><a href="/home-value">What\'s my home worth?</a>')]], { domain: 'jane.com', industry: 'Real estate agents' });
  assert.ok(!b.findings.some((f) => f.key === 'listings_offsite'));
  assert.ok(!b.findings.some((f) => f.key === 'no_valuation'));
});

test('dentist: phone-only booking and PDF patient forms; no mobile layout; old footer', () => {
  const home = page('<p>To schedule an appointment, please call (512) 555-0188.</p><a href="/new-patients">New patients</a><p>© 2019 Brightway</p>', '<title>x</title>');
  assert.deepEqual(interestingLinks(home, 'https://brightway.com/'), ['/new-patients']);
  const a = audit([['/', home], ['/new-patients', page('<a href="/f/registration.pdf">New Patient Registration Form</a>')]], { domain: 'brightway.com', industry: 'Dentists' });
  const keys = a.findings.map((f) => f.key);
  assert.ok(keys.includes('pdf_forms') && keys.includes('phone_booking') && keys.includes('not_mobile') && keys.includes('outdated'), keys.join(','));
  assert.match(a.findings.find((f) => f.key === 'pdf_forms').observed, /New Patient Registration Form/);
  assert.equal(a.findings.find((f) => f.key === 'pdf_forms').evidence, 'https://brightway.com/new-patients');
  assert.ok(a.findings[0].weight >= a.findings[a.findings.length - 1].weight);
});

test('a dentist that already books online (and a salon with Vagaro) gets no booking finding', () => {
  const a = audit([['/', page('<a href="https://www.zocdoc.com/practice/x">Book online</a>')]], { domain: 'smile.com', industry: 'Dentists' });
  assert.ok(!a.findings.some((f) => ['phone_booking', 'no_booking'].includes(f.key)));
  assert.deepEqual(a.has.booking, ['Zocdoc']);
  const s = audit([['/', page('<script src="https://www.vagaro.com/widget.js"></script>')]], { domain: 'hair.com', industry: 'Hair & beauty salons' });
  assert.ok(!s.findings.some((f) => /booking/.test(f.key)));
});

test('restaurant: orders through delivery apps, PDF menu; Toast counts as its own ordering', () => {
  const a = audit([['/', page('<a href="https://www.doordash.com/store/x">Order on DoorDash</a><a href="https://www.ubereats.com/store/x">Uber Eats</a><a href="/menu.pdf">Dinner menu</a>')]], { domain: 'taco.com', industry: 'Restaurants', name: 'Taco Town' });
  assert.equal(a.findings[0].key, 'delivery_apps');
  assert.match(a.findings[0].observed, /DoorDash and Uber Eats/);
  assert.ok(a.findings.some((f) => f.key === 'pdf_menu'));
  const b = audit([['/', page('<a href="https://order.toasttab.com/online/x">Order online</a>')]], { domain: 'phocorner.com', industry: 'Restaurants' });
  assert.ok(!b.findings.some((f) => ['delivery_apps', 'no_ordering'].includes(f.key)));
  assert.deepEqual(b.has.ordering, ['Toast']);
});

test('free website address and businesses without a website', () => {
  assert.deepEqual(freeHostOf('joes-plumbing.wixsite.com'), ['wixsite.com', 'Wix']);
  const a = audit([['/', page('<p>Call us</p>')]], { domain: 'joes-plumbing.wixsite.com', industry: 'Plumbers' });
  assert.equal(a.findings[0].key, 'free_subdomain');
  const n = auditNoWebsite({ name: 'Corner Kitchen', industry: 'Restaurants', profile_url: 'https://www.openstreetmap.org/node/1' }, { email: 'cornerkitchen@gmail.com' });
  assert.deepEqual(n.findings.map((f) => f.key), ['no_website', 'free_email', 'no_crm']);
  assert.match(n.findings[0].fix, /online ordering and a POS setup/);
  const own = auditNoWebsite({ name: 'Ace Roofing', industry: 'Roofing' }, { email: 'info@aceroofing.com' });
  assert.match(own.findings[0].observed, /aceroofing\.com has no website on it yet/);
});

test('agencies are partners: no critique of their site, only where we fit', () => {
  const sig = emptySignals();
  collectSignals(page('<script src="https://assets.website-files.com/x/webflow.js"></script>', '<title>x</title>'), 'https://studio.com/', '/', sig);
  const a = auditSite(sig, { domain: 'studio.com', offer: 'B', industry: 'Web design', scan_facts: JSON.stringify({ caseStudies: [{ text: 'See Project' }, { text: 'Awardco' }], hiring: [{ text: 'Senior Frontend Developer', url: 'https://studio.com/careers' }] }) });
  assert.equal(a.profile, 'agency');
  assert.ok(!a.findings.some((f) => ['not_mobile', 'no_meta', 'no_https'].includes(f.key)));
  assert.deepEqual(a.findings.map((f) => f.key).slice(0, 2).sort(), ['fit_hiring', 'fit_webflow']);
  assert.match(a.findings.find((f) => f.key === 'fit_webflow').observed, /"Awardco"/);
  assert.doesNotMatch(a.findings.find((f) => f.key === 'fit_webflow').observed, /See Project/);
});

test('out of office: the return date is read from the message', () => {
  const rec = '2026-11-09T17:49:25Z';
  assert.equal(returnDate('OOO: 11/9 - 11/15 Re: tradeweb campaign', rec).toISOString().slice(0, 10), '2026-11-15');
  assert.equal(returnDate('I am out of the office until November 20th', rec).toISOString().slice(0, 10), '2026-11-20');
  assert.equal(returnDate('Away until 3 December with no access to email', rec).toISOString().slice(0, 10), '2026-12-03');
  assert.equal(returnDate('Back on Monday', rec).toISOString().slice(0, 10), '2026-11-16');
  assert.equal(returnDate('Out of office, limited access to email', rec), null);
  assert.equal(returnDate('Out until 1/5', '2026-12-20T10:00:00Z').toISOString().slice(0, 10), '2027-01-05'); // next year
});

test('detailed emails: 75–210 words, must say what was seen, no judgement words or lists', () => {
  setSetting('sender_name', 'Alex Rivera');
  const findings = [{ key: 'pdf_forms', observed: 'The patient forms are PDFs', why: 'typed twice', fix: 'online intake forms', keywords: ['form', 'pdf', 'print'] }];
  const para = 'People who look you up in the evening usually book wherever they can do it online, and the details then get typed in twice by hand at the front desk. ';
  const ok = { subject: 'patient forms on your site', body: `Hi there,\n\nI was on your site and saw the new patient forms are PDFs to print and fill in by hand.\n\n${para}${para}\n\nWe would build online intake forms patients fill in on their phone that land straight in your system.\n\nWould a short written plan with a fixed price be useful?\n\nAlex` };
  assert.deepEqual(validateDraft(ok, {}, { style: 'detailed', findings }), []);
  assert.match(validateDraft({ ...ok, body: ok.body.replace(/forms|PDFs|print/g, 'things') }, {}, { style: 'detailed', findings }).join(' '), /does not say what was noticed/);
  assert.match(validateDraft({ ...ok, body: ok.body.replace('I was on', 'Your outdated site, I was on') }, {}, { style: 'detailed', findings }).join(' '), /judges their business/);
  assert.match(validateDraft({ ...ok, body: ok.body.replace('We would build', '- We would build') }, {}, { style: 'detailed', findings }).join(' '), /uses a list/);
  assert.match(validateDraft({ subject: 'x', body: 'Hi there,\n\nShort note about forms.\n\nAlex' }, {}, { style: 'detailed', findings }).join(' '), /body length/);
  // websites must be theirs, spelled exactly (the AI once shortened a client's domain the same way)
  assert.match(validateDraft({ ...ok, subject: 'quote form on northpeak.com' }, { domain: 'getnorthpeak.com' }, { style: 'detailed', findings }).join(' '), /names a website that is not theirs \(northpeak\.com\)/);
  assert.deepEqual(validateDraft({ ...ok, subject: 'quote form on getnorthpeak.com' }, { domain: 'getnorthpeak.com' }, { style: 'detailed', findings }), []);
  assert.deepEqual(validateDraft({ ...ok, body: ok.body.replace('I was on your site', 'I was on your site and saw listings go to Realtor.com') }, { domain: 'home.com' }, { style: 'detailed', findings: [{ ...findings[0], observed: 'The listings link sends buyers to Realtor.com' }] }), []);
  // the short style keeps its own limits
  assert.match(validateDraft({ ...ok, body: `${ok.body}\n\n${para}${para}` }).join(' '), /too long for a first email|body length/);
});

test('answers to replies: no prices, links only to your booking page, signed', () => {
  setSetting('sender_name', 'Alex Rivera');
  const body = 'Hi Sam,\n\nThanks for getting back to me. I will put the plan together and send it within two working days.\n\nDo you take most bookings by phone today, and is there a calendar you already use?\n\nAlex';
  assert.deepEqual(validateAnswer(body), []);
  assert.match(validateAnswer(body.replace('two working days', 'two working days for $500')).join(' '), /price/);
  assert.match(validateAnswer(`${body} https://evil.example/x`).join(' '), /link/);
  assert.deepEqual(validateAnswer(body.replace('two working days.', 'two working days. Or pick a time: https://calendly.com/alex/15min'), { bookingLink: 'https://calendly.com/alex/15min' }), []);
  assert.match(validateAnswer(body.replace('\n\nAlex', '')).join(' '), /sign-off/);
});
