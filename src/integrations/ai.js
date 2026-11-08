// AI email writing via Groq (free tier, OpenAI-compatible API). The model only ever
// receives verified facts about the lead; the output is validated before use.
import { getSetting, getBool } from '../lib/settings.js';

export function isConfigured() { return !!getSetting('groq_api_key'); }
export function isEnabled() { return isConfigured() && getBool('ai_writing'); }

const base = () => getSetting('groq_base_url').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init = {}, attempt = 0) {
  const res = await fetch(base() + path, {
    ...init,
    headers: { authorization: `Bearer ${getSetting('groq_api_key')}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  }).catch((e) => { throw new Error(`Cannot reach Groq (${e.message})`); });
  if (res.status === 401) throw new Error('Groq rejected the API key — create a new one at console.groq.com/keys');
  if (res.status === 429) {
    // The free tier has a per-minute limit: wait as long as Groq asks (up to a minute) and try again.
    const wait = Math.min(60, Number(res.headers.get('retry-after')) || 15 * (attempt + 1));
    if (attempt < 3) { await sleep(wait * 1000); return call(path, init, attempt + 1); }
    throw new Error('Groq free-tier rate limit reached — try again in a minute (or lower the daily limit)');
  }
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
  const b = { model, messages, temperature: 0.7, max_completion_tokens: 1200 };
  if (/gpt-oss/.test(model)) b.reasoning_effort = 'low';
  else if (/qwen3/.test(model)) b.reasoning_effort = 'none';
  return b;
}

/** Draft an email using ONLY the verified facts provided. Returns { subject, body }. */
/** Clean typography that gives AI text away (non-breaking hyphens, em dashes, curly quotes). */
export function plainText(t) {
  return String(t || '')
    .replace(/[‐‑‒]/g, '-').replace(/ /g, ' ')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
    .replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, '-');
}

export async function draftEmail({ company, facts, offerPitch, angle, senderName, senderCompany, b2c = false, styleExample = '', feedback = '', greetName = 'there' }) {
  const first = String(senderName || '').split(' ')[0] || senderName;
  const greeting = greetName && greetName !== 'there' ? `"Hi ${greetName}," and do not use any other name` : '"Hi there," and do not address anyone by name';
  const system = `You are ${first}. You run ${senderCompany}. You are typing a short cold email yourself, by hand, the way a busy person writes a quick note in Gmail. It must read like a real person wrote it, not like marketing or AI.

HOW IT READS
- 45 to 90 words. Three or four very short paragraphs, one or two sentences each.
- Plain, everyday words. Contractions are fine (I'm, you're, we've).
- Write the facts the way a person would say them: "brand and product design", never "brand/product design".
- Start by mentioning ONE specific thing from their website, stated plainly and neutrally, like a note to yourself ("Saw the Linus Health project on your site." / "Noticed you do a lot of brand work for health companies."). No compliments and no adjectives about their work.
- Then say what we do in your own words, in one sentence, only the part that matters to them. Never copy the description you are given word for word.
- End with one short, low-pressure question. Vary it. Do not ask for "a brief call to explore".
- ${b2c ? 'Friendly and local, this is a small business owner, not a corporate buyer.' : 'Peer to peer, one business owner to another.'}
- Sign off with just "${first}". Nothing after it: no title, company, address or unsubscribe line (those are added automatically).

NEVER
- Do not invent facts, numbers, clients, tools, results, names or problems. Use only the verified facts given. Never say their business is doing something badly.
- No flattery: impressed, love, amazing, great work, stunning, vibrant, award-winning, innovative, cutting-edge, world-class, depth.
- No AI or sales words: delve, leverage, elevate, seamless, streamline, synergy, empower, unlock, robust, journey, game-changer, solutions, explore, touch base, reach out, circle back, "I hope this finds you well", "I came across", collaboration, opportunity, at the forefront, testament, blend.
- No dashes of any kind, no semicolons, no bullet points, no exclamation marks, no emojis, no links, no P.S., no placeholders like [Name].

SUBJECT: 2 to 5 words, all lowercase, the way a person would write it. Name the specific project, client or thing you mention (e.g. "linus health project", "the beeline case study", "your booking page"), not a generic phrase like "brand design work". Not "quick question", not "collaboration".

Output exactly:
SUBJECT: <subject>
BODY:
<email>`;
  const user = `Write ONE email to ${company.name}. Start with ${greeting}

What we do (put this in your own words, keep only what matters to them): ${offerPitch}
Why it might matter to them (optional, rephrase freely): ${angle}

VERIFIED FACTS from their own website (use one, at most two):
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}${styleExample ? `

Here is an email ${first} wrote by hand. Match its tone, length and rhythm, not its content:
---
${String(styleExample).slice(0, 1500)}
---` : ''}${feedback ? `

Your previous draft was rejected for: ${feedback}. Write a new one that fixes this.` : ''}`;
  const data = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(requestBody(getSetting('groq_model'), [{ role: 'system', content: system }, { role: 'user', content: user }])),
  });
  const raw = data.choices?.[0]?.message?.content || '';
  const subject = plainText((raw.match(/SUBJECT:\s*(.+)/i)?.[1] || `${company.name}`).trim().replace(/^["'*]+|["'*]+$/g, ''));
  const body = plainText((raw.split(/BODY:\s*/i)[1] || raw).split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/^\*+|\*+$/g, '').trim());
  return { subject: subject.slice(0, 120), body };
}
