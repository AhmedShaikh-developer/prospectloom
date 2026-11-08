// Where leads come from, and which sources actually produce replies.
// Every company carries its origin (lead_origin); imported files can be labelled with the platform they
// came from (Clay, Apollo, LinkedIn…). Results are measured per company: emailed → replied → positive,
// plus bounces and opt-outs, so sources can be compared on outcomes rather than volume.
import { q } from '../db/index.js';
import { getSetting, setSetting } from '../lib/settings.js';

export const PLATFORMS = ['Map listings', 'Apollo', 'Clay', 'HubSpot', 'LinkedIn / Sales Navigator', 'Hunter.io', 'Google Sheets', 'Other list', 'Added by hand'];
const MIN_SAMPLE = 20; // emails per group before results are compared

function labels() { try { return JSON.parse(getSetting('origin_platforms') || '{}'); } catch { return {}; } }

/** Platform of one lead, from its origin (imported files use the label you gave them). */
export function platformOf(origin) {
  const o = String(origin || '').trim();
  const custom = labels()[o];
  if (custom) return custom;
  if (o === 'openstreetmap') return 'Map listings';
  if (o === 'apollo' || /^apollo/i.test(o)) return 'Apollo';
  if (o === 'hubspot') return 'HubSpot';
  if (/^clay/i.test(o)) return 'Clay';
  if (/^csv/i.test(o)) return 'Other list';
  return 'Added by hand';
}

export function setPlatform(origin, platform) {
  const map = labels();
  if (platform) map[origin] = String(platform).slice(0, 60); else delete map[origin];
  setSetting('origin_platforms', JSON.stringify(map));
  return map;
}

const EMAIL_SOURCE = { official_website: 'Their website', hunter_io: 'Hunter.io', imported_list: 'Your imported list', clay_enrichment: 'Clay enrichment', apollo_database: 'Apollo database', manual: 'Entered by hand' };
const CONTACT = { decision_maker: 'Decision-maker', general: 'General inbox', partnership: 'Partnership inbox' };

function rows() {
  return q.all(`SELECT c.id, c.lead_origin, c.status, c.offer, c.industry, c.email_contact_type, c.email_evidence_type,
      (c.contact_email IS NOT NULL AND c.contact_email != '') AS has_email,
      EXISTS (SELECT 1 FROM messages m WHERE m.company_id = c.id AND m.kind = 'intro' AND m.status IN ('sent','bounced')) AS emailed,
      EXISTS (SELECT 1 FROM messages m WHERE m.company_id = c.id AND m.status = 'bounced') AS bounced,
      EXISTS (SELECT 1 FROM replies r WHERE r.company_id = c.id AND r.classification IN ('positive','neutral','negative')) AS replied,
      EXISTS (SELECT 1 FROM replies r WHERE r.company_id = c.id AND r.classification = 'positive') AS positive,
      EXISTS (SELECT 1 FROM replies r WHERE r.company_id = c.id AND r.classification = 'opt_out') AS opted_out
    FROM companies c`);
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function group(list, keyFn, { limit = 0 } = {}) {
  const m = new Map();
  for (const r of list) {
    const k = keyFn(r) || '—';
    const g = m.get(k) || { key: k, leads: 0, withEmail: 0, ready: 0, emailed: 0, replied: 0, positive: 0, bounced: 0, optedOut: 0, origins: new Set() };
    g.leads++; g.withEmail += r.has_email ? 1 : 0; g.ready += r.status === 'READY' ? 1 : 0;
    g.emailed += r.emailed; g.replied += r.replied; g.positive += r.positive; g.bounced += r.bounced; g.optedOut += r.opted_out;
    if (r.lead_origin) g.origins.add(r.lead_origin);
    m.set(k, g);
  }
  let out = [...m.values()].map((g) => ({
    ...g, origins: [...g.origins],
    replyRate: pct(g.replied, g.emailed), positiveRate: pct(g.positive, g.emailed), bounceRate: pct(g.bounced, g.emailed),
  }));
  out.sort((a, b) => b.emailed - a.emailed || b.leads - a.leads);
  if (limit) out = out.slice(0, limit);
  return out;
}

function verdicts(groups, overall) {
  for (const g of groups) {
    if (g.emailed < MIN_SAMPLE) g.verdict = { tone: '', label: g.emailed ? `Too early (${g.emailed} sent)` : 'Not emailed yet' };
    else if (g.bounceRate > 5) g.verdict = { tone: 'bad', label: 'Too many bounces' };
    else if (overall.replyRate && g.replyRate >= overall.replyRate * 1.5) g.verdict = { tone: 'ok', label: 'Best source' };
    else if (g.replyRate >= overall.replyRate) g.verdict = { tone: 'ok', label: 'Good' };
    else g.verdict = { tone: 'warn', label: 'Below average' };
  }
  return groups;
}

/** Everything the Performance page shows. */
export function report() {
  const list = rows();
  const all = group(list, () => 'all')[0] || { leads: 0, emailed: 0, replied: 0, positive: 0, bounced: 0, replyRate: 0, positiveRate: 0, bounceRate: 0 };
  const byPlatform = verdicts(group(list, (r) => platformOf(r.lead_origin)), all);
  const byFile = group(list.filter((r) => /^csv|^clay/i.test(r.lead_origin || '')), (r) => r.lead_origin)
    .map((g) => ({ ...g, platform: platformOf(g.key), file: g.key.replace(/^csv:\s*/i, '') }));
  const byEmailSource = verdicts(group(list.filter((r) => r.has_email), (r) => EMAIL_SOURCE[r.email_evidence_type] || 'Other'), all);
  const byContact = verdicts(group(list.filter((r) => r.has_email), (r) => CONTACT[r.email_contact_type] || 'Unknown'), all);
  const byOffer = verdicts(group(list, (r) => (r.offer ? `Offer ${String(r.offer).toUpperCase()}` : 'No offer yet')), all);
  const byIndustry = verdicts(group(list.filter((r) => r.industry), (r) => r.industry, { limit: 10 }), all);
  return { overall: all, byPlatform, byFile, byEmailSource, byContact, byOffer, byIndustry, insights: insights(byPlatform, byContact, all), minSample: MIN_SAMPLE, platforms: PLATFORMS };
}

function insights(byPlatform, byContact, all) {
  const out = [];
  const ready = byPlatform.filter((g) => g.emailed >= MIN_SAMPLE);
  if (!all.emailed) out.push('No emails sent yet. Results per source appear here as replies come in.');
  else if (ready.length < 2) {
    out.push(`Too early to compare sources: each needs about ${MIN_SAMPLE} emails sent. So far: ${byPlatform.filter((g) => g.emailed).map((g) => `${g.key} ${g.emailed}`).join(', ') || 'none'}.`);
  } else {
    const best = [...ready].sort((a, b) => b.replyRate - a.replyRate)[0];
    const worst = [...ready].sort((a, b) => a.replyRate - b.replyRate)[0];
    if (best.key !== worst.key && best.replyRate > 0) {
      const x = worst.replyRate ? `${Math.round((best.replyRate / worst.replyRate) * 10) / 10}×` : 'clearly';
      out.push(`${best.key} leads reply ${x} better than ${worst.key} (${best.replyRate}% vs ${worst.replyRate}%). Find more leads from ${best.key}.`);
    }
    const pos = [...ready].sort((a, b) => b.positiveRate - a.positiveRate)[0];
    if (pos.positive) out.push(`Most interested replies: ${pos.key} (${pos.positiveRate}% of emails get a positive answer).`);
    for (const g of ready.filter((x) => x.bounceRate > 5)) out.push(`${g.key}: ${g.bounceRate}% of emails bounce — its addresses are often outdated. Check them before importing more.`);
  }
  const dm = byContact.find((g) => g.key === 'Decision-maker'); const gen = byContact.find((g) => g.key === 'General inbox');
  if (dm && gen && dm.emailed >= MIN_SAMPLE && gen.emailed >= MIN_SAMPLE) {
    out.push(`Emails to a named decision-maker get ${dm.replyRate}% replies; general inboxes ${gen.replyRate}%.`);
  }
  return out;
}
