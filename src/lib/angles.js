// Industry-specific angles: one honest sentence about where custom software typically
// helps in that industry. They describe common patterns, never claims about the lead.
const OFFER_A = [
  [/logistic|freight|trucking|transport|3pl|shipping|carrier|courier/i, 'For carriers and 3PLs we usually see the same pattern: dispatch, load tracking and customer updates living in separate tools, with people re-keying data between them.'],
  [/recruit|staffing|talent|hr services/i, 'Recruiting teams we work with often lose hours moving candidate data between the ATS, spreadsheets and client reports — that is very automatable.'],
  [/manufactur|fabricat|machin|industrial|production/i, 'Manufacturers we talk to often run quoting, job tracking and inventory across an ERP plus a lot of spreadsheets — small integrations there tend to pay back quickly.'],
  [/wholesale|distribut|supply|b2b/i, 'Distributors often juggle order intake from email/PDFs, inventory in an ERP and pricing in spreadsheets — a lightweight portal or integration usually removes most of the manual work.'],
  [/e-?commerce|retail|dtc|shopify|online store/i, 'Growing e-commerce brands usually hit a point where orders, inventory, fulfilment and reporting need to talk to each other without manual exports.'],
  [/account|law|legal|consult|professional services|advisory|insurance|financ/i, 'Professional-services firms often have client intake, documents and billing spread across tools — a simple internal portal or a few integrations can save a lot of admin time.'],
  [/health|clinic|medical|dental/i, 'Practices we talk to often have scheduling, intake forms and billing that don\'t sync — targeted integrations remove a lot of double entry.'],
  [/real estate|property|construction/i, 'Teams in property and construction often track projects, documents and client updates across several disconnected tools — a single dashboard tends to help.'],
];
const OFFER_B = [
  [/shopify|e-?commerce/i, 'Shopify agencies usually bring us in for the parts that go beyond the theme — custom apps, ERP/3PL integrations and data syncs.'],
  [/webflow|website|web design|wordpress/i, 'Website studios usually bring us in when a client project needs backend work — integrations, member areas, custom APIs or automations behind the site.'],
  [/ux|ui|product design|design studio/i, 'Design studios usually bring us in to turn approved designs into production web apps without having to staff a full engineering team.'],
  [/brand|creative/i, 'Creative studios usually bring us in when a client asks for something technical — a portal, an integration or a custom web app — that sits outside the core team.'],
  [/marketing|growth|digital|seo|ppc|advertising/i, 'Marketing agencies usually bring us in for CRM/HubSpot integrations, reporting dashboards and automations their clients ask for.'],
];
const OFFER_C = [
  [/restaurant|caf[eé]|coffee|bakery|pizza|bar\b|pub|food/i, 'Restaurants we work with usually want the same few things: online ordering or reservations that don\'t eat into margins, and a site that loads fast on a phone.'],
  [/dent|clinic|medical|doctor|physio|chiro|health|optician|veterinar/i, 'Practices we work with usually want online booking and intake forms that drop straight into their system, so the front desk spends less time on the phone.'],
  [/salon|hair|beauty|barber|spa|nail/i, 'Salons we work with usually want booking, reminders and deposits handled online so no-shows drop and the phone rings less.'],
  [/gym|fitness|yoga|pilates|studio/i, 'Studios and gyms we work with usually want class booking, memberships and payments in one place instead of three apps.'],
  [/real estate|estate agent|realtor|property/i, 'Agents we work with usually want listings, enquiries and follow-ups flowing into one place automatically instead of being copied around by hand.'],
  [/plumb|electric|hvac|roof|landscap|clean|repair|contractor|builder/i, 'Home-service businesses we work with usually want quote requests, scheduling and reminders to run on their own so jobs don\'t slip through the cracks.'],
  [/hotel|motel|b&b|guest|hostel/i, 'Small hotels we work with usually want direct bookings that don\'t pay the big platforms a commission on every stay.'],
  [/shop|retail|boutique|store|florist/i, 'Local shops we work with usually want a simple online store or click-and-collect that syncs with what\'s actually on the shelf.'],
];
const FALLBACK = {
  C: 'We usually start with the one thing that costs you the most time each week — bookings, enquiries or orders — and put it online so it runs itself.',
  A: 'We usually start by mapping one manual workflow end to end and automating the most repetitive step first.',
  B: 'We work behind your brand, inside your process, and only on the projects where you need extra engineering capacity.',
};

export function angleFor(company) {
  const hay = `${company.industry || ''} ${company.services || ''} ${company.description || ''}`;
  const offer = ['A', 'B', 'C'].includes(company.offer) ? company.offer : 'A';
  const list = { A: OFFER_A, B: OFFER_B, C: OFFER_C }[offer];
  return (list.find(([re]) => re.test(hay)) || [null, FALLBACK[offer]])[1];
}
