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
  const b = { model, messages, temperature: 0.7, max_completion_tokens: 1600 };
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
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2') // ranges stay ranges: 9–5
    .replace(/\s*[—–]\s*/g, ', ')                // any other dash becomes a comma, spaced or not
    .replace(/([a-z])-([A-Z])/g, '$1, $2');        // "projects-APIs" (a dash typed as a hyphen)
}

const NEVER = `NEVER
- Never invent anything: no facts, numbers, prices, timelines, clients, results, names or tools that are not in the notes. Never claim to know their revenue, traffic or how many customers they lose.
- No judgement words about their business or site: bad, poor, outdated, old, broken, ugly, behind, struggling, miss out, missing out.
- Only connect what you build to a tool that is listed under ALREADY USES and fits (booking talks to a booking or CRM tool, never to a website builder or shop system).
- No flattery: impressed, love, amazing, great work, stunning, vibrant, award-winning, innovative, cutting-edge, world-class.
- No AI or sales words: delve, leverage, elevate, seamless, streamline, synergy, empower, unlock, robust, journey, game-changer, solutions, explore, touch base, reach out, circle back, "I hope this finds you well", "I came across", collaboration, opportunity, at the forefront, testament, blend.
- No dashes of any kind, no semicolons, no bullet points or numbered lists, no exclamation marks, no emojis, no links, no P.S., no placeholders like [Name].`;

function parseDraft(raw, fallbackSubject) {
  const subject = plainText((raw.match(/SUBJECT:\s*(.+)/i)?.[1] || fallbackSubject).trim().replace(/^["'*]+|["'*]+$/g, ''));
  const body = plainText((raw.split(/BODY:\s*/i)[1] || raw).split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/^\*+|\*+$/g, '').trim());
  return { subject: subject.slice(0, 120), body };
}

/**
 * The detailed first email: what we saw on their site, what it usually costs a business like theirs,
 * what we would build, and a free, no-call offer. Uses only the audit findings and verified facts.
 */
export async function draftDetailedEmail({ company, audit, facts = [], offerPitch, senderName, senderCompany, freeOffer, b2c = false, styleExample = '', feedback = '', greetName = 'there' }) {
  const first = String(senderName || '').split(' ')[0] || senderName;
  const greeting = greetName && greetName !== 'there' ? `"Hi ${greetName}," and do not use any other name` : '"Hi there," and do not address anyone by name';
  const partner = audit.profile === 'agency';
  const system = `You are ${first}. You run ${senderCompany}. Before writing, you spent ten minutes on ${company.name}'s website and made notes. Now you are typing a cold email to ${partner ? 'the agency owner' : 'the owner'} yourself, in Gmail. It has to read like a thoughtful person who actually looked at their business, not like marketing and not like AI.

WHAT THE EMAIL DOES, in 4 or 5 short paragraphs, 110 to 170 words in total:
${partner ? `1. Open with ${greeting}. Then say plainly what you noticed about their work, using the NOTES (the kind of projects, platforms or clients). Be concrete. No compliments.
2. In one or two sentences, say where projects like theirs usually need extra engineering, using the WHERE WE FIT lines.
3. Say how we work with agencies: under their name, they keep the client relationship, we stay in the background. Put it in your own words.
4. Offer something useful for free with no call needed: ${freeOffer || 'a short note on how we would handle one of their typical projects, with how we price it'}. Ask if they would like it, in one short question.` : `1. Open with ${greeting}. Then say plainly what you noticed on their site, using one or two of the OBSERVATIONS. Be concrete: name the page, the link, the PDF or the platform. State it as a neutral fact, like a note you would write to yourself.
2. In one or two sentences, say what that usually means for a business like theirs, using the WHY lines. Frame it as what usually happens in their kind of business, never as a claim about their own numbers.
3. Say what you would build for them, specifically, using the FIX lines, in plain words. If they already use a tool listed under ALREADY USES, say you would connect to it, not replace it.
4. Offer something useful for free with no call needed: ${freeOffer || 'a short written plan for their site with a fixed price'}. Ask if they would like it, in one short question.`}
5. Sign off with just "${first}". Nothing after it: no title, company, address or unsubscribe line (those are added automatically).

STYLE
- Plain everyday words and short sentences. Contractions are fine. ${b2c ? 'Friendly and local, this is a small business owner, not a corporate buyer.' : 'Peer to peer, one business owner to another.'}
- Use their business name at most once.

${NEVER}

SUBJECT: 3 to 6 words, all lowercase, about the specific thing you noticed (e.g. "patient forms on brightsmile.com", "the listings link on your site", "online orders at taco town"${partner ? ', "backend help on shopify builds"' : ''}). Not "quick question", not "collaboration", not just their company name.

Output exactly:
SUBJECT: <subject>
BODY:
<email>`;
  const notes = audit.findings.slice(0, 3).map((f, i) => partner
    ? `${i + 1}. ${f.observed}${f.evidence ? `  [seen on ${f.evidence}]` : ''}\n   WHERE WE FIT: ${f.fix}`
    : `${i + 1}. ${f.observed}${f.evidence ? `  [seen on ${f.evidence}]` : ''}\n   WHY: ${f.why}\n   FIX: ${f.fix}`).join('\n');
  // Only tools that matter for what we would build (a real estate site's WooCommerce plugin is noise).
  const relevant = ['booking', 'fieldservice', 'hotelbooking', 'reservations', 'ordering', 'pos', 'crm', 'email', 'chat', 'idx', 'portal', 'payments', ...(['retail', 'restaurant'].includes(audit.profile) ? ['ecommerce'] : [])];
  const label = { booking: 'online booking', fieldservice: 'job scheduling', hotelbooking: 'booking engine', reservations: 'reservations', ordering: 'online ordering', pos: 'POS', crm: 'CRM', email: 'email marketing', chat: 'website chat', idx: 'listing search', portal: 'client portal', payments: 'payments', ecommerce: 'online shop' };
  const uses = Object.entries(audit.has || {}).filter(([k]) => relevant.includes(k)).map(([k, v]) => `${v.join(', ')} (${label[k] || k})`).join('; ');
  const user = `Write ONE email to ${company.name}${company.industry ? ` (${company.industry})` : ''}. Start with ${greeting}

${partner ? 'NOTES ABOUT THEIR WORK' : `OBSERVATIONS FROM THEIR WEBSITE (${company.domain}), the first is the strongest`}:
${notes}
${partner ? '' : `ALREADY USES: ${uses || 'nothing visible on the site'}\n`}OTHER VERIFIED FACTS: ${facts.slice(0, 6).join(' | ') || 'none'}

What we do (rephrase, keep only what matters to them): ${offerPitch}${styleExample ? `

Here is an email ${first} wrote by hand. Match its tone and rhythm, not its content or length:
---
${String(styleExample).slice(0, 1500)}
---` : ''}${feedback ? `

Your previous draft was rejected for: ${feedback}. Write a new one that fixes this.` : ''}`;
  const data = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(requestBody(getSetting('groq_model'), [{ role: 'system', content: system }, { role: 'user', content: user }])),
  });
  return parseDraft(data.choices?.[0]?.message?.content || '', company.name);
}

/**
 * Answer a prospect's reply. Returns { body } or { handoff: reason } when a person should answer
 * (prices, contracts, complaints, anything the notes don't cover).
 */
export async function draftReply({ company, ourEmail, theirReply, senderName, senderCompany, senderWebsite, offerPitch, bookingLink = '', freeOffer = '', facts = [], previousAnswers = 0 }) {
  const first = String(senderName || '').split(' ')[0] || senderName;
  const system = `You are ${first}, you run ${senderCompany}${senderWebsite ? ` (${senderWebsite})` : ''}. Someone answered your cold email. You are writing back yourself, by hand, in Gmail.

FIRST DECIDE: if the message needs ${first} personally, do not write an answer. Output exactly one line "HANDOFF: <short reason>". That is the case when they:
- ask for a price, a quote, a contract, a proposal or a deadline,
- complain, are upset, or mention legal steps,
- ask something the notes below do not answer,
- write in a way you are unsure how to read,
- want to talk to someone specific or already suggested an exact day and time.

OTHERWISE write the answer:
- 40 to 120 words, 2 or 3 short paragraphs, plain words, contractions are fine. Start with "Hi <their first name>," if they signed with a name, else "Hi,".
- Answer exactly what they said or asked, using only the notes. Do not repeat your first email.
- If they are interested: ${bookingLink ? `suggest a short call and give this booking link exactly as written: ${bookingLink}` : 'ask which day and time this week or next suits them for a short call, or whether they would rather keep it to email'}.
- If they said yes to the free offer${freeOffer ? ` (${freeOffer})` : ''}: thank them, say you will send it within two working days, and ask one or two short questions that help you prepare it.
- If they ask who you are or how you found them: say you run ${senderCompany}, you found their business${company.domain && !/no-website/.test(company.domain) ? ` and website (${company.domain})` : ''} while looking at ${company.industry || 'businesses'} in their area, and that you only emailed because of what you noticed.
- Sign off with just "${first}".

${NEVER.replace('no links,', bookingLink ? 'no links except the booking link,' : 'no links,')}

Output exactly:
BODY:
<answer>
or
HANDOFF: <reason>`;
  const user = `This is conversation number ${previousAnswers + 1} with them.

YOUR FIRST EMAIL (subject: ${ourEmail.subject}):
${ourEmail.body}

THEIR REPLY (from ${theirReply.from}, subject: ${theirReply.subject}):
${theirReply.text}

NOTES ABOUT THEM: ${facts.slice(0, 8).join(' | ') || company.name}
WHAT WE DO: ${offerPitch}`;
  const data = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(requestBody(getSetting('groq_model'), [{ role: 'system', content: system }, { role: 'user', content: user }])),
  });
  const raw = String(data.choices?.[0]?.message?.content || '').trim();
  const hand = raw.match(/^\s*HANDOFF:\s*(.+)$/im);
  if (hand && !/BODY:/i.test(raw)) return { handoff: hand[1].trim().slice(0, 200) };
  return { body: parseDraft(raw, '').body };
}

export async function draftEmail({ company, facts, offerPitch, angle, senderName, senderCompany, b2c = false, styleExample = '', feedback = '', greetName = 'there' }) {
  const first = String(senderName || '').split(' ')[0] || senderName;
  const greeting = greetName && greetName !== 'there' ? `"Hi ${greetName}," and do not use any other name` : '"Hi there," and do not address anyone by name';
  const system = `You are ${first}. You run ${senderCompany}. You are typing a short cold email yourself, by hand, the way a busy person writes a quick note in Gmail. It must read like a real person wrote it, not like marketing or AI.

HOW IT READS
- 45 to 90 words. Three or four very short paragraphs, one or two sentences each.
- Plain, everyday words. Contractions are fine (I'm, you're, we've).
- Write the facts the way a person would say them: "brand and product design", never "brand/product design".
- Start by mentioning ONE specific thing from their website, stated plainly and neutrally, like a note to yourself ("Saw the Harbor Dental project on your site." / "Noticed you do a lot of brand work for health companies."). No compliments and no adjectives about their work.
- Then say what we do in your own words, in one sentence, only the part that matters to them. Never copy the description you are given word for word.
- End with one short, low-pressure question. Vary it. Do not ask for "a brief call to explore".
- ${b2c ? 'Friendly and local, this is a small business owner, not a corporate buyer.' : 'Peer to peer, one business owner to another.'}
- Sign off with just "${first}". Nothing after it: no title, company, address or unsubscribe line (those are added automatically).

NEVER
- Do not invent facts, numbers, clients, tools, results, names or problems. Use only the verified facts given. Never say their business is doing something badly.
- No flattery: impressed, love, amazing, great work, stunning, vibrant, award-winning, innovative, cutting-edge, world-class, depth.
- No AI or sales words: delve, leverage, elevate, seamless, streamline, synergy, empower, unlock, robust, journey, game-changer, solutions, explore, touch base, reach out, circle back, "I hope this finds you well", "I came across", collaboration, opportunity, at the forefront, testament, blend.
- No dashes of any kind, no semicolons, no bullet points, no exclamation marks, no emojis, no links, no P.S., no placeholders like [Name].

SUBJECT: 2 to 5 words, all lowercase, the way a person would write it. Name the specific project, client or thing you mention (e.g. "harbor dental project", "the case study on your site", "your booking page"), not a generic phrase like "brand design work". Not "quick question", not "collaboration".

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
  return parseDraft(data.choices?.[0]?.message?.content || '', company.name);
}
