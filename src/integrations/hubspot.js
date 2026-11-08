// Phase 7: HubSpot CRM (private app token). Reads are free; writes go through an
// approval queue (services/hubspotSync.js) and are confirmed by re-reading.
import { getSetting } from '../lib/settings.js';
import { HUBSPOT_PROPERTIES } from '../lib/constants.js';

export function isConfigured() {
  return !!getSetting('hubspot_token');
}

async function call(method, path, body) {
  const token = getSetting('hubspot_token');
  if (!token) throw new Error('HubSpot is not configured (add a private app token in Settings)');
  const base = getSetting('hubspot_base_url').replace(/\/$/, '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`HubSpot ${method} ${path} → ${res.status}: ${data.message || text.slice(0, 200)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  throw new Error('HubSpot rate limit: retries exhausted');
}

const COMPANY_PROPS = ['name', 'domain', 'website', 'industry', 'numberofemployees', 'city', 'state', 'country', 'description', ...HUBSPOT_PROPERTIES];

export async function testConnection() {
  const data = await call('GET', '/crm/v3/objects/companies?limit=1');
  return { ok: true, sample: data.results?.length ?? 0 };
}

/** Check that the ll_* custom properties exist on companies. */
export async function checkProperties() {
  const out = [];
  for (const name of HUBSPOT_PROPERTIES) {
    try {
      const p = await call('GET', `/crm/v3/properties/companies/${name}`);
      out.push({ name, exists: true, type: p.type, options: (p.options || []).map((o) => o.value) });
    } catch (e) {
      out.push({ name, exists: false, error: e.status === 404 ? 'missing' : e.message });
    }
  }
  return out;
}

export async function findCompanyByDomain(domain) {
  const data = await call('POST', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
    properties: COMPANY_PROPS,
    limit: 5,
  });
  return data.results?.[0] || null;
}

export async function findContactByEmail(email) {
  const data = await call('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'jobtitle', 'hs_email_optout'],
    limit: 1,
  });
  return data.results?.[0] || null;
}

export async function getCompanyById(id) {
  return call('GET', `/crm/v3/objects/companies/${encodeURIComponent(id)}?properties=${COMPANY_PROPS.join(',')}`);
}

/** Page through companies (read-only import). */
export async function listCompanies({ after, limit = 100 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), properties: COMPANY_PROPS.join(',') });
  if (after) qs.set('after', after);
  const data = await call('GET', `/crm/v3/objects/companies?${qs}`);
  return { results: data.results || [], next: data.paging?.next?.after || null };
}

export async function updateCompany(id, properties) {
  return call('PATCH', `/crm/v3/objects/companies/${encodeURIComponent(id)}`, { properties });
}

export async function createCompany(properties) {
  return call('POST', '/crm/v3/objects/companies', { properties });
}

const PROPERTY_DEFS = {
  ll_outreach_stage: { label: 'LL Outreach Stage', type: 'enumeration', fieldType: 'select',
    options: ['HOLD', 'READY', 'SENT', 'FOLLOW_UP', 'REPLIED', 'BOUNCED', 'DO_NOT_CONTACT'].map((v, i) => ({ label: v, value: v, displayOrder: i })) },
  ll_public_contact_email: { label: 'LL Public Contact Email', type: 'string', fieldType: 'text' },
  ll_email_source_url: { label: 'LL Email Source URL', type: 'string', fieldType: 'text' },
  ll_email_evidence_type: { label: 'LL Email Evidence Type', type: 'string', fieldType: 'text' },
  ll_last_verified_date: { label: 'LL Last Verified Date', type: 'date', fieldType: 'date' },
  ll_suppression_reason: { label: 'LL Suppression Reason', type: 'string', fieldType: 'textarea' },
  ll_last_sent_date: { label: 'LL Last Sent Date', type: 'date', fieldType: 'date' },
};

/** Create only the ll_* properties that are missing (needs crm.schemas.companies.write). */
export async function createMissingProperties() {
  const status = await checkProperties();
  const created = [];
  for (const p of status.filter((x) => !x.exists)) {
    await call('POST', '/crm/v3/properties/companies', { name: p.name, groupName: 'companyinformation', ...PROPERTY_DEFS[p.name] });
    created.push(p.name);
  }
  return { created, alreadyExisted: status.filter((x) => x.exists).map((x) => x.name) };
}
