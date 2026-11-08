// Offer selection. A = custom software for operations-heavy B2B, B = white-label for agencies,
// C = consumer-facing (B2C) local businesses.
export const OFFERS = ['A', 'B', 'C'];
export const offerKey = (offer) => (OFFERS.includes(offer) ? offer.toLowerCase() : 'a');

const AGENCY = /\b(agency|agencies|studio|web design|webflow|shopify partner|marketing firm|digital marketing|advertising|branding|creative|ux|ui design|seo|ppc)(s|es)?(?![a-z])/i;
const LOCAL = /\b(restaurant|caf[eé]|coffee|bakery|bar|pub|pizza|clinic|dentist|dental|doctor|medical practice|physio\w*|chiropract\w*|salon|hair|beauty|barber|spa|nail|gym|fitness|yoga|pilates|real estate|estate agent|realtor|plumber|electrician|hvac|roofing|landscaping|cleaning|home services|retail|shop|boutique|florist|hotel|motel|b&b|veterinar\w*|pet|car repair|auto repair|car dealer|daycare|tutor|driving school|optician|pharmac(y|ies))(s|es)?(?![a-z])/i;

/** Best-guess offer from what we know about the company (category, industry, description). */
export function autoOffer(c) {
  const hay = `${c.industry || ''} ${c.services || ''} ${c.description || ''} ${c.name || ''}`;
  if (AGENCY.test(hay)) return 'B';
  if (LOCAL.test(hay)) return 'C';
  return 'A';
}
