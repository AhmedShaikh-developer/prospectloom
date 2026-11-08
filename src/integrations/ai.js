// AI email writing via Groq (free tier, OpenAI-compatible API). The model only ever
// receives verified facts about the lead; the output is validated before use.
import { getSetting, getBool } from '../lib/settings.js';

export function isConfigured() { return !!getSetting('groq_api_key'); }
export function isEnabled() { return isConfigured() && getBool('ai_writing'); }

const base = () => getSetting('groq_base_url').replace(/\/$/, '');

async function call(path, init = {}) {
  const res = await fetch(base() + path, {
    ...init,
    headers: { authorization: `Bearer ${getSetting('groq_api_key')}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  }).catch((e) => { throw new Error(`Cannot reach Groq (${e.message})`); });
  if (res.status === 401) throw new Error('Groq rejected the API key — create a new one at console.groq.com/keys');
  if (res.status === 429) throw new Error('Groq free-tier rate limit reached — try again in a minute (or lower the daily limit)');
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function testConnection() {
  if (!isConfigured()) throw new Error('No Groq API key. Add GROQ_API_KEY to .env or paste it in Settings → AI writing.');
  const models = ((await call('/models')).data || []).map((m) => m.id);
  const want = getSetting('groq_model');
  if (!models.includes(want)) throw new Error(`Key works, but model "${want}" is not available. Try: ${models.filter((m) => /llama|qwen|gemma|gpt-oss/.test(m)).slice(0, 4).join(', ')}`);
  return { ok: true, detail: `Groq OK — model ${want}` };
}

// Reasoning models (gpt-oss, qwen3) think before answering; keep that short and leave room for the email.
function requestBody(model, messages) {
  const b = { model, messages, temperature: 0.5, max_completion_tokens: 1200 };
  if (/gpt-oss/.test(model)) b.reasoning_effort = 'low';
  else if (/qwen3/.test(model)) b.reasoning_effort = 'none';
  return b;
}

/** Draft an email using ONLY the verified facts provided. Returns { subject, body }. */
export async function draftEmail({ company, facts, offerPitch, angle, senderName, senderCompany, b2c = false }) {
  const greeting = company.email_contact_type === 'decision_maker' && company.dm_name
    ? `addressed to ${String(company.dm_name).split(' ')[0]}` : '(general inbox — start with "Hi there,")';
  const system = `You write short, plain-text cold emails for ${senderCompany}. You never invent facts.
STRICT RULES:
- Use ONLY the verified facts given. Do not invent numbers, clients, tools, results, names, reviews or problems.
- Never claim the business is doing something badly. Say what we often see, not what they have.
- 60–110 words. No buzzwords, no exclamation marks, no emojis, no links, no placeholders like [Name], no P.S.
- ${b2c ? 'Friendly and local in tone — this is a small business owner, not a corporate buyer.' : 'Peer-to-peer B2B tone.'}
- Sign off with just the first name "${senderName}". Do not add a signature block, address or unsubscribe line (added automatically).
- Output format exactly:
SUBJECT: <max 7 words, lowercase except names>
BODY:
<email body>`;
  const user = `Write ONE email to ${company.name} ${greeting}.
Structure: one specific opener based on a fact, one sentence on what we do (${offerPitch}), one sentence using this angle: "${angle}", then a low-pressure question asking for a short call.

VERIFIED FACTS:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  const data = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(requestBody(getSetting('groq_model'), [{ role: 'system', content: system }, { role: 'user', content: user }])),
  });
  const raw = data.choices?.[0]?.message?.content || '';
  const subject = (raw.match(/SUBJECT:\s*(.+)/i)?.[1] || `Quick idea for ${company.name}`).trim().replace(/^["'*]+|["'*]+$/g, '');
  const body = (raw.split(/BODY:\s*/i)[1] || raw).split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/^\*+|\*+$/g, '').trim();
  return { subject: subject.slice(0, 120), body };
}
