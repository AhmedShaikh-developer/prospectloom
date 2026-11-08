// ProspectLoom — single-page dashboard (no build step).
import { chart, hydrateCharts, countUp, revealCards, setQuiet } from './charts.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
let META = null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Times are stored in UTC; show them in your local time (date-only values stay as they are).
const fmtDate = (s) => {
  if (!s) return '—';
  const str = String(s);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) return str.slice(0, 16);
  const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return str.replace('T', ' ').slice(0, 16);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
/** "just now", "5 min ago", "3 h ago" */
const since = (iso) => {
  if (!iso) return '—';
  const t = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(String(iso)) ? iso : `${String(iso).replace(' ', 'T')}Z`).getTime();
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const day = (s) => (s ? String(s).slice(0, 10) : '—');
const badge = (v, label) => `<span class="badge b-${esc(v)}" data-testid="badge">${esc(label ?? META?.statuses?.[v] ?? v ?? '—')}</span>`;
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text || url)}</a>` : '<span class="muted">—</span>');
const n = (v) => Number(v || 0).toLocaleString();
const ic = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
const empty = (title, hint = '') => `<div class="empty"><strong>${esc(title)}</strong>${esc(hint)}</div>`;

/** Standard page header: title, subtitle, actions on the right. */
function head(title, sub = '', actions = '', crumb = '') {
  return `<div class="page-head"><div>${crumb}<h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && data?.signIn) { location.href = '/login'; throw new Error('Signing you in again…'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);
const PUT = (p, b) => api('PUT', p, b);
const DEL = (p) => api('DELETE', p);

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  el.dataset.testid = err ? 'toast-error' : 'toast';
  $('#toast').append(el);
  setTimeout(() => el.remove(), err ? 7000 : 3500);
}

function modal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  return $('#modal-body');
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/** Run an async action from a button with busy state + error toast. */
let busyActs = 0;
async function act(btn, fn, okMsg) {
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Working…'; }
  busyActs++;
  setTimeout(pollJobs, 400); // show it in the activity panel right away
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    setTimeout(() => { busyActs--; }, 2500);
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = prev; }
  }
}

// ---------------------------------------------------------------- background jobs (activity panel)
// Long tasks run on the server. Their progress shows here on every page, and finishing
// tasks announce themselves — so leaving a page never loses track of work.
const JOB_ICON = { finder: 'pin', engine: 'bolt', research: 'search', import: 'download', autopilot: 'send', mailbox: 'inbox' };
const seenJobs = new Set(); let jobsReady = false; let jobTimer = null;
const jobListeners = new Set();
const ago = (iso) => { const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`; };
const jobBar = (j) => (j.total > 0 ? `<div class="bar"><span style="width:${Math.min(100, (j.done / j.total) * 100)}%"></span></div>` : '');
async function pollJobs() {
  clearTimeout(jobTimer);
  let active = [];
  try {
    const recent = await GET('/jobs?limit=15');
    active = recent.filter((j) => j.status === 'running');
    for (const j of [...recent].reverse()) {
      if (j.status === 'running' || seenJobs.has(j.id)) continue;
      seenJobs.add(j.id);
      if (!jobsReady) continue; // don't announce jobs that finished before this page loaded
      jobListeners.forEach((fn) => { try { fn(j); } catch { /* ignore */ } });
      if (busyActs > 0) continue; // the button that started it already reported the result
      if (j.status === 'done') toast(`${j.label} — ${j.message || 'done'}`);
      else if (j.status === 'failed') toast(`${j.label}: ${j.error || j.message}`, true);
    }
    jobsReady = true;
    $('#jobs-tray').innerHTML = active.slice(0, 4).map((j) => `<div class="job" data-testid="job-running" data-kind="${esc(j.kind)}"><span class="spin"></span><div class="grow">
      <div class="job-l">${esc(j.label)}</div><div class="job-m">${esc(j.message || 'Working…')} · ${ago(j.started_at)}</div>${jobBar(j)}</div></div>`).join('');
  } catch { /* offline — try again */ }
  jobTimer = setTimeout(pollJobs, active.length ? 2000 : 8000);
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else out[el.name] = el.value;
  }
  return out;
}

// ---------------------------------------------------------------- router
const routes = {
  dashboard: renderDashboard,
  engine: renderEngine,
  companies: renderCompanies,
  company: renderCompany,
  import: renderImport,
  research: renderResearch,
  outreach: renderOutreach,
  replies: renderReplies,
  hubspot: renderHubspot,
  suppression: renderSuppression,
  setup: renderSetup,
  settings: renderSettings,
  integrations: renderIntegrations,
};

// Page changes take turns: a slow page that finishes late can never overwrite the page you opened after it.
let routeChain = Promise.resolve();
function route() {
  routeChain = routeChain.then(renderRoute, renderRoute);
  return routeChain;
}
// Live pages re-load their numbers every minute (quietly: no animations, scroll position kept).
const LIVE_PAGES = new Set(['dashboard', 'engine', 'research']);
let quietRender = false; let lastRender = Date.now();
setInterval(() => {
  const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split(/[/?]/)[0];
  const busyTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!LIVE_PAGES.has(name) || document.hidden || busyTyping || !$('#modal').hidden || (name === 'engine' && engineDirty)) return;
  quietRender = true;
  route().finally(() => { quietRender = false; });
}, 60_000);
setInterval(() => { const el = $('#live-pill'); if (el) el.textContent = `Live · updated ${since(new Date(lastRender).toISOString())}`; }, 15_000);

async function renderRoute() {
  const quiet = quietRender; const scrollY = window.scrollY;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, query = ''] = hash.split('?');
  const [name, id] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (name === 'company' ? 'companies' : name)));
  const fn = routes[name] || renderDashboard;
  if (!quiet) app.innerHTML = '<div class="muted">Loading…</div>';
  try {
    await fn({ id, params });
    setQuiet(quiet);
    hydrateCharts(app);
    if (!quiet) { countUp(app); revealCards(app); } else window.scrollTo(0, scrollY);
    setQuiet(false);
    lastRender = Date.now();
    const lp = $('#live-pill'); if (lp) { lp.textContent = 'Live · updated just now'; lp.hidden = !LIVE_PAGES.has(name); }
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
  refreshNav();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

async function refreshNav() {
  try {
    const d = await GET('/dashboard');
    $('#nav-outreach').textContent = d.today.drafts + d.today.approved || '';
    const unhandled = d.blockers.find((b) => b.area === 'Replies');
    $('#nav-replies').textContent = unhandled ? unhandled.message.match(/\d+/)[0] : '';
    const ops = d.blockers.find((b) => b.area === 'HubSpot' && /awaiting/.test(b.message));
    $('#nav-hubspot').textContent = ops ? ops.message.match(/\d+/)[0] : '';
    $('nav a[data-nav="hubspot"]').hidden = !(d.integrations.hubspot.configured || ops);
    $('#nav-engine').textContent = d.engine?.enabled ? 'on' : '';
    $('#bell-dot').hidden = !unhandled;
    const attention = d.blockers.filter((b) => ['Apollo', 'Hunter.io', 'HubSpot'].includes(b.area) && b.severity !== 'low').length;
    $('#nav-integrations').textContent = attention || '';
  } catch { /* ignore */ }
}

const blockerHtml = (b) => `<div class="alert blocker sev-${b.severity}">${ic('alert')}<div class="grow"><strong>${esc(b.area)}</strong> — ${esc(b.message)}</div>${b.link ? `<a href="${b.link}" class="small-t">Fix →</a>` : ''}</div>`;

// ---------------------------------------------------------------- dashboard (Phase 8/11/12)
/** Today's send times and the warm-up stage, in plain words. */
function sendPlanStrip(t) {
  const p = t.plan; const w = t.warmup;
  if (!p) return '';
  const chip = (x) => `<span class="chip slot ${x.sent ? 'sent' : x.at === p.next ? 'active' : ''}" data-testid="plan-slot" title="${x.sent ? 'sent' : 'planned'}">${x.at}${x.sent ? ' ✓' : ''}</span>`;
  // Up to 12 times are shown; with more, the next 12 upcoming ones plus a count.
  const shown = p.slots.length <= 12 ? p.slots : p.slots.filter((x) => !x.sent).slice(0, 12);
  const chips = shown.map(chip).join('') + (p.slots.length > shown.length ? `<span class="chip slot muted">+${p.slots.length - shown.length} more</span>` : '');
  const warm = !w?.enabled ? `Fixed limit: ${w?.limit ?? t.limit}/day (warm-up off)`
    : w.braked ? `Warm-up paused at ${w.limit}/day — too many bounces this week`
      : !w.started ? `Warm-up starts with your first email: ${w.base}/day for ${w.hold} days, then +${w.step} every ${w.every} days up to ${w.max}/day`
        : `Warm-up day ${w.day}: ${w.limit}/day${w.nextLimit ? ` → ${w.nextLimit}/day from ${fmtDate(w.nextDate)}` : ' (maximum reached)'}`;
  return `<div class="plan-strip" data-testid="send-plan">
    <div class="small-t"><strong>Today: ${p.limit} emails at ${p.spread ? 'random times' : 'the window start'}, ${p.windowStart}–${p.windowEnd}</strong> <span class="muted">(${esc(p.timezone)})</span> · ${p.sent} sent${p.next ? ` · next ≈ <strong>${p.next}</strong>` : ''}</div>
    <div class="slot-chips">${chips}</div>
    <div class="hint" data-testid="warmup-status">${esc(warm)} · <a href="#/settings?tab=schedule">change</a></div></div>`;
}

// ---------------------------------------------------------------- dashboard
let dashRange = (() => { try { return Number(localStorage.getItem('pl-range')) || 14; } catch { return 14; } })();
const SOURCE_LOOK = {
  osm: { mono: 'OS', bg: 'linear-gradient(135deg,#7ebc6f,#3f8f3a)', unit: 'leads' },
  csv: { mono: 'CSV', bg: 'linear-gradient(135deg,#8b8cf6,#5b5bd6)', unit: 'leads' },
  apollo: { mono: 'A', bg: 'linear-gradient(135deg,#f7d046,#d9a400)', unit: 'leads' },
  hubspot: { mono: 'H', bg: 'linear-gradient(135deg,#ff8f6b,#ff5c35)', unit: 'leads' },
  hunter: { mono: 'Hu', bg: 'linear-gradient(135deg,#ff7a45,#e9461c)', unit: 'emails found' },
  clay: { mono: 'C', bg: 'linear-gradient(135deg,#55555e,#26262b)', unit: 'leads' },
  manual: { mono: '+', bg: 'linear-gradient(135deg,#9a968f,#6b6761)', unit: 'leads' },
};
const STATE_BADGE = {
  ready: ['ok', 'Active'], done: ['ok', 'Up to date'], running: ['info', 'Running'], idle: ['ok', 'Connected'],
  waiting_credits: ['warn', 'Waiting for credits'], rate_limited: ['warn', 'Paused · rate limit'], plan: ['bad', 'Not in your plan'], auth: ['bad', 'Key rejected'], error: ['warn', 'Retrying'],
};
const deltaChip = (cur, prev) => {
  if (!prev) return cur ? '<span class="delta">new</span>' : '<span class="delta flat">—</span>';
  const p = Math.round(((cur - prev) / prev) * 100);
  return `<span class="delta ${p < 0 ? 'down' : p === 0 ? 'flat' : ''}">${p > 0 ? '↗' : p < 0 ? '↘' : ''} ${Math.abs(p)}%</span>`;
};

function autopilotCard(d, ap, ov) {
  const t = d.today; const p = ov.plan;
  const [ws, we] = (ap.window.match(/(\d+):00–(\d+):00/) || [0, 9, 16]).slice(1).map(Number);
  const startM = ws * 60; const endM = Math.max(startM + 60, we * 60);
  const pos = (m) => Math.max(0, Math.min(100, ((m - startM) / (endM - startM)) * 100));
  const timeline = `<div class="timeline" data-testid="send-timeline" aria-label="Today's send times">
      <div class="track"></div><div class="done" style="width:${pos(p.nowMin)}%"></div>
      ${p.slots.map((x) => `<div class="sd ${x.sent ? 'ok' : x.at === p.next ? 'nx' : ''}" style="left:${pos(x.atMin)}%" title="${x.at} — ${x.sent ? 'sent' : 'planned'}"></div>`).join('')}
      ${p.nowMin > startM && p.nowMin < endM ? `<div class="now" style="left:${pos(p.nowMin)}%"></div>` : ''}
      <div class="tl" style="left:0;transform:none">${String(ws).padStart(2, '0')}:00</div><div class="tl" style="left:100%;transform:translateX(-100%)">${String(we).padStart(2, '0')}:00</div></div>`;
  return `<div class="card autopilot reveal span-4 ${ap.enabled ? 'on' : ''}" data-testid="autopilot-card">
    <div class="card-head"><h2>${ic('bolt')}Autopilot ${ap.enabled ? badge('ok', 'On') : badge('warn', 'Off')}</h2>
      <button id="ap-toggle" class="small ${ap.enabled ? '' : 'primary'}" data-testid="autopilot-toggle">${ap.enabled ? 'Turn off' : `${ic('bolt')}Turn on autopilot`}</button></div>
    <p class="sub small-t" style="margin:-4px 0 6px">${ap.enabled
    ? (ap.review
      ? `Researches and writes one email per lead${ap.ai ? ' with AI' : ''}, then <strong>waits for your approval</strong>. Approved emails go out at random times, ${esc(ap.window)} (${esc(ap.timezone)}).`
      : `Researches, writes${ap.ai ? ' with AI' : ''} and sends up to <strong>${t.limit}</strong> a day at random, human-like times, ${esc(ap.window)} (${esc(ap.timezone)}) — no need to press Send.`)
    : 'You approve and send each email yourself. Turn autopilot on to research, write and send every day automatically.'}
      ${ap.ai ? '' : ' <a href="#/settings?tab=ai">Add a free Groq key</a> so every email is written for that lead.'}</p>
    ${timeline}
    ${sendPlanStrip(t)}
    <div class="row mt"><button id="ap-run" class="small" data-testid="autopilot-run">${ic('play')}Prepare today's emails now</button><a href="#/outreach" class="small-t">Review queue →</a></div>
    <div id="ap-result"></div></div>`;
}

function insightsList(d, ov, eng) {
  const c = ov.composition; const w = ov.warmup; const out = [];
  const perDay = d.today.limit || 1;
  out.push(`<strong>${n(c.ready)}</strong> companies are ready to email — about <strong>${n(Math.ceil(c.ready / perDay))} days</strong> of sending at ${perDay} a day.`);
  if (eng?.targets) out.push(`The lead engine has run <strong>${n(eng.searched)} of ${n(eng.targets)}</strong> searches and added <strong>${n(eng.imported)}</strong> businesses${eng.enabled ? ' — it keeps going around the clock' : ' (paused)'}.`);
  if (c.offline) out.push(`Research retired <strong>${n(c.offline)}</strong> companies whose website no longer exists, so your list stays clean.`);
  const hunter = ov.sourceStates.find((s) => s.name === 'hunter');
  if (c.no_email) out.push(`<strong>${n(c.no_email)}</strong> companies publish no email on their website. ${hunter?.configured && hunter.enabled ? `Hunter.io is looking them up${hunter.status === 'waiting_credits' ? ' (waiting for credits to renew)' : ''}.` : '<a href="#/integrations">Connect Hunter.io</a> to find them automatically.'}`);
  if (w.enabled) out.push(w.started ? `Warm-up day <strong>${w.day}</strong>: ${w.limit} emails a day${w.nextLimit ? `, rising to <strong>${w.nextLimit}</strong> on ${fmtDate(w.nextDate)}` : ''}.` : `Warm-up starts with your first email at <strong>${w.base}</strong> a day, then rises by ${w.step} every ${w.every} days.`);
  if (ov.totals.sent) out.push(`<strong>${n(ov.totals.sent)}</strong> emails sent · reply rate <strong>${ov.replyRate}%</strong> · bounce rate <strong>${ov.bounce.rate}%</strong>.`);
  return out.slice(0, 5);
}

async function renderDashboard() {
  const [d, missing, ap, ov, se, eng] = await Promise.all([GET('/dashboard'), GET('/insights/missing'), GET('/autopilot/status'), GET('/insights/overview'), GET(`/insights/series?days=${dashRange}`), GET('/engine').catch(() => null)]);
  const inv = d.inventory; const f = d.funnel; const t = d.today; const c = ov.composition;
  const reserveBar = (r) => {
    const pct = Math.min(100, Math.round((inv.eligibleUnsent / (r.demand || 1)) * 100));
    return `<div class="metric-row"><span>${r.days}-day reserve (${n(r.demand)})</span><span class="${r.covered ? 'ok-i' : 'muted'}">${r.covered ? 'covered' : `short ${n(r.shortfall)}`}</span></div>
      <div class="bar ${r.covered ? 'ok' : 'warn'}" style="margin-bottom:12px"><span style="width:${pct}%"></span></div>`;
  };
  const rangeTotal = se.leadsTotal.reduce((a, b) => a + b, 0);
  const readyInRange = se.ready.reduce((a, b) => a + b, 0);
  const todayNew = se.leadsTotal[se.leadsTotal.length - 1] || 0;
  const kpi = (icon, label, value, tid, hint, extra = '') => `<div class="card kpi lift reveal">
      <div class="label"><span class="ico-chip">${ic(icon)}</span>${label}</div>
      <div class="value" data-testid="${tid}" data-count="${value}">${n(value)}</div><div class="hint">${hint}</div>${extra}</div>`;

  // pipeline composition (fixed slot order: color follows the stage, never its size)
  const comp = [
    ['Ready to email', c.ready, 'var(--s2)', '#/companies?status=READY', 'READY'],
    ['Contacted', c.contacted, 'var(--s1)', '#/companies?contacted=yes', ''],
    ['Researching', c.researching, 'var(--s3)', '#/companies?status=RESEARCHING', ''],
    ['No email on their site', c.no_email, 'var(--s4)', '#/companies?status=HOLD_VERIFY&hasEmail=no', ''],
    ['Waiting on checks', c.checks, 'var(--s5)', '#/companies?status=HOLD_VERIFY&hasEmail=yes', ''],
    ['Blocks automated visits', c.blocked, 'var(--faint)', '#/companies?site=blocked', 'tex'],
    ['Excluded or offline', c.out, 'var(--line-strong)', '#/companies?status=EXCLUDED', 'tex'],
  ];
  const compTotal = comp.reduce((a, x) => a + (x[1] || 0), 0) || 1;
  const pct = (v) => `${Math.round(((v || 0) / compTotal) * 1000) / 10}%`;

  const sourcesHtml = [
    ...ov.sources.map((s) => ({ g: s.g, label: s.label, value: s.total, sub: `${n(s.ready)} ready · ${n(s.contacted)} contacted`, spark: s.spark, state: ov.sourceStates.find((x) => x.name === s.g) })),
    ...ov.sourceStates.filter((s) => s.configured && !ov.sources.some((x) => x.g === s.name)).map((s) => ({ g: s.name, label: s.label, value: s.name === 'hunter' ? s.found : s.imported, sub: s.message || (s.enabled ? 'connected' : 'connected · auto-pull off'), spark: null, state: s })),
  ].map((s) => {
    const look = SOURCE_LOOK[s.g] || SOURCE_LOOK.manual;
    const st = s.state && s.state.configured ? (s.state.enabled ? STATE_BADGE[s.state.status] || STATE_BADGE.idle : ['', 'Auto-pull off']) : null;
    return `<a class="src" href="${s.g === 'osm' ? '#/engine' : ['apollo', 'hunter', 'hubspot', 'clay'].includes(s.g) ? '#/integrations' : `#/companies?origin=${s.g === 'csv' ? 'csv' : s.g}`}">
      <span class="mono-ic" style="background:${look.bg}">${look.mono}</span>
      <div><div class="src-l">${esc(s.label)}</div><div class="src-n" data-count="${s.value || 0}">${n(s.value)}</div></div>
      ${s.spark ? chart({ type: 'spark', values: s.spark, color: 'var(--brand)' }, { height: 34, label: `${s.label}: new leads per day` }) : ''}
      <div class="src-s"><span>${esc(s.sub)} ${look.unit === 'emails found' ? '· emails found' : ''}</span>${st ? badge(st[0], st[1]) : ''}</div></a>`;
  }).join('') + ov.sourceStates.filter((s) => !s.configured).map((s) => {
    const look = SOURCE_LOOK[s.name] || SOURCE_LOOK.manual;
    return `<a class="src ghost-src" href="#/integrations"><span class="mono-ic" style="background:${look.bg}">${look.mono}</span>
      <div><div class="src-l">${esc(s.label)}</div><div class="src-n" style="font-size:15px">Connect →</div></div>
      <div class="src-s"><span>${esc(s.what.split('.')[0])}</span></div></a>`;
  }).join('');

  const bounce = ov.bounce;
  const bounceColor = bounce.rate >= 5 ? 'var(--st-critical)' : bounce.rate >= 2 ? 'var(--st-warning)' : 'var(--st-good)';
  const bounceLabel = bounce.rate >= 5 ? 'Too high — sending paused' : bounce.rate >= 2 ? 'Watch closely' : 'Healthy';
  const rampIdx = ov.ramp.findIndex((r, i) => i > 0 && r.limit > ov.ramp[i - 1].limit);
  const funnelRows = [['Emails sent', f.sent], ['Bounced', f.bounced], ['Replies', f.replies], ['Positive', f.positive], ['Meetings / calls', f.meetings], ['Proposals', f.proposals], ['Won', f.won]];
  const fmax = Math.max(1, ...funnelRows.map((x) => x[1]));

  app.innerHTML = `
    ${head('Pipeline dashboard', 'Find leads → research → one personal email per lead → replies. Everything below updates on its own.',
    `<button id="go-outreach" data-testid="go-outreach">${ic('send')}Today's outreach</button><button id="run-research" data-testid="run-research">${ic('play')}Run research batch</button><a class="btn primary" href="#/import">${ic('pin')}Find leads</a>`)}

    <div class="kpis" data-testid="kpis">
      ${kpi('users', 'Total leads', inv.total, 'kpi-total', `${todayNew ? `+${n(todayNew)} today · ` : ''}${n(inv.hold)} being researched`)}
      ${kpi('check', 'Ready to email', inv.eligibleUnsent, 'kpi-eligible', `${inv.reserveDays ?? 0} days at ${inv.dailyVolume}/day`)}
      ${kpi('search', 'Research-qualified', inv.researchQualified, 'kpi-qualified', `target ${n(inv.qualifiedTarget)}`, `<div class="bar"><span style="width:${Math.min(100, (inv.researchQualified / (inv.qualifiedTarget || 1)) * 100)}%"></span></div>`)}
      ${kpi('send', 'Emails sent', ov.totals.sent, 'kpi-sent', `<span data-testid="kpi-sent-today">${t.sent} / ${t.limit}</span> today · ${t.approved} queued`)}
      ${kpi('inbox', 'Replies', ov.totals.replies, 'kpi-replies', `${ov.replyRate}% reply rate · ${ov.totals.positive} positive`)}
    </div>

    <div class="dash mt">
      <div class="card hero reveal span-8" data-testid="hero">
        <div class="card-head" style="align-items:flex-start">
          <div><div class="eyebrow">${ic('trend')}Leads collected · last ${dashRange} days</div>
            <div class="row" style="align-items:flex-end;gap:12px;margin-top:12px"><span class="big-num" data-count="${rangeTotal}">${n(rangeTotal)}</span>${deltaChip(rangeTotal, se.prevTotal)}</div>
            <div class="hint" style="margin-top:6px">${n(readyInRange)} became ready to email in this period · ${n(inv.total)} companies in total</div></div>
          <div class="seg" id="range" role="tablist" aria-label="Time range">${[7, 14, 30, 90].map((r) => `<button type="button" data-r="${r}" class="${r === dashRange ? 'active' : ''}">${r}D</button>`).join('')}</div>
        </div>
        ${chart({ type: 'area', labels: se.days, xFormat: 'date', series: [{ label: 'New leads', values: se.leadsTotal, color: 'var(--hero-ink)' }] }, { height: 236, label: `New leads per day over the last ${dashRange} days` })}
      </div>
      ${autopilotCard(d, ap, ov)}

      <div class="card reveal span-7" data-testid="blockers"><div class="card-head"><h2>${ic('alert')}Blockers &amp; next actions</h2><span class="hint">${d.blockers.length} open</span></div>
        ${d.blockers.length ? d.blockers.map(blockerHtml).join('') : empty('No blockers', ' — the pipeline is clear.')}</div>
      <div class="card insight reveal span-5" data-testid="insights"><div class="card-head"><h2>${ic('sparkle')}Insights</h2><span class="hint">from your live data</span></div>
        <ul>${insightsList(d, ov, eng).map((x) => `<li>${ic('arrow')}<span>${x}</span></li>`).join('')}</ul></div>

      <div class="card reveal span-7" data-testid="inventory-breakdown"><div class="card-head"><h2>${ic('chart')}Pipeline mix</h2><span class="hint">${n(compTotal)} companies</span></div>
        <div class="segbar" role="img" aria-label="Companies by stage">${comp.filter((x) => x[1]).map(([label, v, color, , k]) => `<span class="seg-i ${k === 'tex' ? 'tex' : ''}" style="flex-grow:${v};background-color:${color}" title="${esc(label)}: ${n(v)} (${pct(v)})"></span>`).join('')}</div>
        <div class="comp-list">${comp.map(([label, v, color, href]) => `<a href="${href}"><span class="sw" style="background:${color}"></span>${esc(label === 'Ready to email' ? 'Ready' : label)}<span class="muted small-t">${pct(v)}</span><strong>${n(v)}</strong></a>`).join('')}</div></div>
      <div class="card reveal span-5"><div class="card-head"><h2>${ic('send')}Outreach activity</h2>
        <div class="legend"><span class="legend-i"><span class="sw" style="background:var(--s1)"></span>Sent</span><span class="legend-i"><span class="sw" style="background:var(--s2)"></span>Replies</span></div></div>
        ${chart({ type: 'bars', labels: se.days, xFormat: 'date', series: [{ label: 'Sent', values: se.sent, color: 'var(--s1)' }, { label: 'Replies', values: se.replies, color: 'var(--s2)' }] }, { height: 210, label: 'Emails sent and replies per day' })}
        <p class="hint small-t" style="margin:6px 0 0">${ov.totals.sent ? `${n(ov.totals.sent)} sent in total · ${ov.replyRate}% reply rate` : 'Your first emails go out at today\'s first send time.'}</p></div>

      <div class="card reveal span-12" data-testid="lead-sources"><div class="card-head"><h2>${ic('pin')}Lead sources</h2><a href="#/integrations" class="small-t">Manage integrations →</a></div>
        <div class="sources">${sourcesHtml}</div></div>

      <div class="card reveal span-4" data-testid="deliverability"><div class="card-head"><h2>${ic('shield')}Deliverability</h2>${badge(bounce.rate >= 5 ? 'bad' : bounce.rate >= 2 ? 'warn' : 'ok', bounceLabel)}</div>
        ${chart({ type: 'gauge', value: Math.min(bounce.rate, 10), max: 10, color: bounceColor }, { height: 132, label: `Bounce rate ${bounce.rate}% of the last 7 days` })}
        <div style="text-align:center;margin-top:-34px"><span class="big-num" style="font-size:30px">${bounce.rate}%</span><div class="hint small-t">bounce rate · ${n(bounce.sent)} sent in 7 days · pauses above 5%</div></div>
        <div class="row mt" id="auth-chips" style="justify-content:center;gap:6px"></div></div>
      <div class="card reveal span-4" data-testid="warmup-card"><div class="card-head"><h2>${ic('trend')}Warm-up ramp</h2><a href="#/settings?tab=schedule" class="small-t">Change →</a></div>
        ${chart({ type: 'line', step: true, labels: ov.ramp.map((r) => r.date), xFormat: 'date', series: [{ label: 'Daily limit', values: ov.ramp.map((r) => r.limit), color: 'var(--brand)' }], marker: 0, markerLabel: 'today', annotations: rampIdx > 0 ? [{ i: rampIdx, v: ov.ramp[rampIdx].limit, text: `${ov.ramp[rampIdx].limit}/day` }] : [], unit: '/day' }, { height: 188, label: 'Daily sending limit over the next 10 weeks' })}
        <p class="hint small-t" style="margin:6px 0 0">${ov.warmup.enabled ? `Grows by itself up to ${ov.warmup.max}/day. Drops back if bounces rise.` : 'Warm-up is off — the limit stays fixed.'}</p></div>
      <div class="card reveal span-4"><h2>What's holding companies back</h2>
        ${missing.length ? `<table class="plain"><tbody>${missing.slice(0, 7).map((m) => `<tr><td>${esc(m.item)}</td><td class="num"><strong>${n(m.count)}</strong></td></tr>`).join('')}</tbody></table>` : empty('Nothing on hold')}</div>

      <div class="card reveal span-3"><h2>Sales funnel</h2>
        ${funnelRows.map(([k, v]) => `<div class="metric-row"><span class="muted">${k}</span><strong>${n(v)}</strong></div><div class="bar"><span style="width:${(v / fmax) * 100}%"></span></div>`).join('')}
        <div class="metric-row mt"><span class="muted">Revenue</span><strong>$${n(f.revenue)}</strong></div></div>
      <div class="card reveal span-3"><div class="card-head"><h2>Send reserve</h2><span class="hint">milestones</span></div>${reserveBar(inv.reserve14)}${reserveBar(inv.reserve30)}${reserveBar(inv.forecast60)}
        <div class="row" style="gap:6px">${inv.milestones.map((m) => `<span class="badge ${m.reached ? 'b-ok' : ''}">${m.target}</span>`).join('')}</div></div>
      <div class="card reveal span-6 order-last"><h2>Last research run</h2>${d.lastRun ? `<pre data-testid="last-run">${esc(d.lastRun.report || 'running…')}</pre>` : empty('No research runs yet', ' — run your first batch.')}</div>
      <div class="card reveal span-6"><div class="card-head"><h2>Integrations</h2><a href="#/integrations" class="small-t">Manage →</a></div><table class="plain"><tbody>
        ${[['Hostinger SMTP (sending)', d.integrations.smtp.configured, d.integrations.smtp.mode === 'capture' ? 'test capture mode' : ''], ['Hostinger IMAP (replies)', d.integrations.imap.configured, d.integrations.imap.lastSync ? 'synced ' + fmtDate(d.integrations.imap.lastSync) : ''], ['Groq AI (email writing)', d.integrations.ai.configured, d.integrations.ai.model],
          ['HubSpot', d.integrations.hubspot.configured, 'optional CRM', true], ['Apollo', d.integrations.apollo.configured, 'optional lead source', true], ['Hunter.io', ov.sourceStates.find((s) => s.name === 'hunter')?.configured, 'optional email finder', true], ['Clay', d.integrations.clay.configured, 'optional · CSV import works without it', true]]
          .map(([k, ok, note, optional]) => {
            const st = ov.sourceStates.find((x) => x.label === k || (k === 'Hunter.io' && x.name === 'hunter'));
            const rejected = ok && st && st.enabled && st.status === 'auth';
            return `<tr><td><span class="status-dot ${ok && !rejected ? 'on' : ''}"></span>&nbsp; ${k}</td><td class="muted small-t">${esc(note || '')}</td><td class="num">${rejected ? badge('bad', 'Key rejected') : ok ? badge('ok', 'Connected') : optional ? badge('', 'Optional') : badge('warn', 'Not set up')}</td></tr>`;
          }).join('')}</tbody></table></div>
    </div>`;

  $$('#range button').forEach((b) => { b.onclick = () => { dashRange = Number(b.dataset.r); try { localStorage.setItem('pl-range', dashRange); } catch { /* ignore */ } route(); }; });
  $('#run-research').onclick = (e) => act(e.currentTarget, () => POST('/research/run', {}), (r) => `Run #${r.runId}: screened ${r.stats.screened}, newly READY ${r.stats.newlyReady}`).then((r) => r && route());
  $('#go-outreach').onclick = () => { location.hash = '#/outreach'; };
  $('#ap-toggle').onclick = (e) => act(e.currentTarget, () => PUT('/settings', { autopilot_enabled: ap.enabled ? '0' : '1' }), ap.enabled ? 'Autopilot off' : 'Autopilot on — it runs every day while this app is open').then((r) => r && route());
  $('#ap-run').onclick = (e) => act(e.currentTarget, () => POST('/autopilot/run')).then((r) => {
    if (!r) return;
    const held = r.held != null;
    $('#ap-result').innerHTML = `<div class="alert mt" data-testid="autopilot-result">${ic('check')}<div class="grow"><strong>${held ? `${r.held} email${r.held === 1 ? '' : 's'} waiting for your approval` : `${r.approved} email${r.approved === 1 ? '' : 's'} ready to send`}</strong> (${r.drafted} new, ${r.aiWritten} written by AI${r.followups ? `, ${r.followups} follow-ups` : ''}${r.blocked ? `, ${r.blocked} blocked by checks` : ''}). ${held ? 'Approve them in Outreach.' : r.approved ? (ap.enabled ? 'They go out automatically at random times in the sending window.' : 'Send them from Outreach, or turn autopilot on.') : 'No READY leads left for today — find more leads.'}
      ${r.notes.length ? `<details class="small-t"><summary>Details</summary><ul>${r.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div><a href="#/outreach" class="small-t">Review →</a></div>`;
  });
  // Domain authentication chips (DNS lookup — filled in when it answers)
  GET('/sender/auth').then((a) => {
    const el = $('#auth-chips'); if (!el) return;
    const chip = (ok, label) => `<span class="signal ${ok ? 'y' : 'n'}">${ok ? '✓' : '✕'} ${label}</span>`;
    el.innerHTML = chip(a.spf, 'SPF') + chip(a.dkim, 'DKIM') + chip(a.dmarc, 'DMARC') + chip(a.mx, 'MX');
  }).catch(() => {});
}

// ---------------------------------------------------------------- lead engine (24/7)
let engineDirty = false;
jobListeners.add((j) => { if (j.kind === 'engine' && location.hash.startsWith('#/engine') && !engineDirty) route(); });

async function renderEngine() {
  const e = await GET('/engine');
  engineDirty = false;
  const cats = new Set(e.categories);
  const groups = [...new Set(META.finderCategories.map((c) => c.group))];
  const pct = e.targets ? Math.round((e.searched / e.targets) * 100) : 0;
  const nOptions = (vals, cur) => vals.map((v) => `<option ${Number(cur) === v ? 'selected' : ''}>${v}</option>`).join('');
  const est = (c, l) => (c && l ? `${c} type${c === 1 ? '' : 's'} × ${l} cit${l === 1 ? 'y' : 'ies'} = <strong>${n(c * l)} searches</strong> · first full sweep ≈ ${Math.ceil((c * l) / e.perHour)} h at ${e.perHour}/hour, then each is re-checked every ${e.rescanDays} days` : 'Pick at least one business type and one city.');
  app.innerHTML = `
    ${head('Lead engine', 'Finds new leads 24/7: it works through every business type × city you choose, adds businesses that have their own website, and research checks each one for a published email. No manual searching.',
    `<button id="eng-run" data-testid="engine-run-now">${ic('play')}Run one search now</button><button id="eng-toggle" class="${e.enabled ? '' : 'primary'}" data-testid="engine-toggle">${e.enabled ? 'Pause engine' : `${ic('bolt')}Start engine`}</button>`)}
    <div class="card autopilot ${e.enabled ? 'on' : ''}" data-testid="engine-status">
      <div class="card-head"><h2>${ic('bolt')}Status ${e.enabled ? badge('ok', 'Running 24/7') : badge('warn', 'Paused')}</h2><span class="hint">${e.lastRun ? `last search ${since(e.lastRun)} (${fmtDate(e.lastRun)})` : 'no searches yet'}</span></div>
      ${e.paused ? `<div class="int-msg warn" style="margin:0 0 14px" data-testid="engine-paused">${ic('clock')} ${esc(e.paused.text)}${e.paused.code === 'cap' ? ' You can raise the limit under “Pace” below.' : ''}</div>` : ''}
      ${e.running ? `<div class="working" style="margin:0 0 14px"><span class="spin"></span><div><strong>${esc(e.running.message || e.running.label)}</strong><div class="small-t muted">started ${ago(e.running.started_at)} ago</div></div></div>` : ''}
      <div class="ap-steps">
        <div class="ap-step"><div class="grow"><div class="ap-t">${ic('search')}Searches done</div><div class="ap-v" data-testid="engine-searched">${n(e.searched)} / ${n(e.targets)}</div><div class="bar"><span style="width:${pct}%"></span></div><div class="hint">${e.errors ? `${e.errors} will retry · ` : ''}${e.etaHours ? `≈ ${e.etaHours} h to finish this sweep` : e.targets ? 'sweep complete — re-checking on schedule' : 'set up below'}</div>
          ${(e.bySource || []).length > 1 ? `<div class="hint" data-testid="engine-by-source">${e.bySource.map((x) => `${x.source === 'osm' ? 'Map listings' : x.source === 'apollo' ? 'Apollo' : esc(x.source)} ${n(x.searched)}/${n(x.targets)}${x.waiting ? ' (waiting for credits)' : ''}`).join(' · ')} — sources take turns</div>` : ''}</div></div>
        <div class="ap-step"><div class="grow"><div class="ap-t">${ic('pin')}Businesses found</div><div class="ap-v">${n(e.found)}</div><div class="hint">with their own website</div></div></div>
        <div class="ap-step"><div class="grow"><div class="ap-t">${ic('plus')}New leads added</div><div class="ap-v" data-testid="engine-imported">${n(e.imported)}</div><div class="hint">${n(e.importedToday)} today · cap ${n(e.dailyCap)}/day</div></div></div>
        <div class="ap-step"><div class="grow"><div class="ap-t">${ic('building')}Your whole list</div><div class="ap-v">${n(e.leads.total)}</div><div class="hint">${n(e.leads.withEmail || 0)} with email · ${n(e.leads.ready || 0)} ready · ${n(e.leads.contacted || 0)} contacted</div></div></div>
      </div></div>

    <form id="eng-form" class="stack mt">
      <div class="card"><div class="card-head"><h2>1 · Business types</h2><span class="hint" id="eng-cat-count">${cats.size} selected</span></div>
        ${groups.map((g) => `<div class="cat-group"><h3>${esc(g)} <button type="button" class="small ghost cat-all" data-g="${esc(g)}">select all</button></h3><div class="cat-grid">
          ${META.finderCategories.filter((c) => c.group === g).map((c) => `<label class="check"><input type="checkbox" class="eng-cat" value="${c.id}" data-g="${esc(g)}" ${cats.has(c.id) ? 'checked' : ''} data-testid="engine-cat-${c.id}"> <span>${esc(c.label)} <span class="muted small-t">Offer ${c.offer}</span></span></label>`).join('')}</div></div>`).join('')}
      </div>
      <div class="card"><div class="card-head"><h2>2 · Cities</h2><span class="hint" id="eng-loc-count">${e.locations.length} cities</span></div>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">${Object.entries(META.cityPresets).map(([k, v]) => `<button type="button" class="small preset" data-k="${k}" data-testid="preset-${k}">${ic('plus')}${esc(v.label)}</button>`).join('')}<button type="button" class="small ghost" id="loc-clear">Clear</button></div>
        <div class="field"><label for="eng-locs">One city per line — any country ("Austin, TX, USA", "Manchester, United Kingdom")</label><textarea id="eng-locs" name="engine_locations" style="min-height:160px" class="mono" data-testid="engine-locations">${esc(e.locations.join('\n'))}</textarea></div>
      </div>
      <div class="card"><h2>3 · Pace</h2>
        <div class="grid g3">
          <div class="field"><label>Searches per hour</label><select name="engine_searches_per_hour">${nOptions([6, 12, 20, 30], e.perHour)}</select></div>
          <div class="field"><label>Re-check each city after (days)</label><select name="engine_rescan_days">${nOptions([7, 14, 30, 60, 90], e.rescanDays)}</select></div>
          <div class="field"><label>Max new leads per day</label><select name="engine_daily_cap">${nOptions([200, 500, 1000, 1500, 3000, 5000], e.dailyCap)}</select></div>
        </div>
        <p class="small-t muted" id="eng-est">${est(cats.size, e.locations.length)}</p>
        <p class="small-t muted">Uses the free OpenStreetMap servers politely (one search at a time). The app must be running; keep the Mac awake with <span class="code">caffeinate -i npm start</span>.</p>
      </div>
      <div class="card"><div class="card-head"><h2>4 · Apollo (optional)</h2>${e.apollo ? badge('ok', 'Active') : badge('', 'Off')}</div>
        <p class="sub" style="margin:-6px 0 12px">Adds companies from Apollo's people search for each keyword × city (company websites only — no emails, no credits). Needs an Apollo API key and “Allow API people search” in <a href="#/settings?tab=integrations">Settings → Integrations</a>.</p>
        <label class="check"><input type="checkbox" name="engine_apollo_enabled" ${e.apolloWanted ? 'checked' : ''}> <span>Also search Apollo${e.apolloWanted && !e.apolloReady ? ' <span class="small-t" style="color:var(--warn)">— waiting for an Apollo key with API search allowed</span>' : ''}</span></label>
        <div class="grid g2 mt"><div class="field"><label>Keywords (one per line)</label><textarea name="engine_apollo_keywords" style="min-height:90px" placeholder="shopify agency&#10;logistics company">${esc(e.apolloKeywords.join('\n'))}</textarea></div>
        <div class="field"><label>Job titles to look for</label><input name="engine_apollo_titles" value="${esc(e.apolloTitles || '')}"></div></div>
      </div>
      <div class="row" style="justify-content:flex-end"><button class="primary" data-testid="engine-save">${ic('check')}Save engine setup</button></div>
    </form>

    <div class="card mt"><h2>Recent searches</h2><div class="table-wrap"><table data-testid="engine-recent"><thead><tr><th>Search</th><th>Status</th><th class="num">Found</th><th class="num">New</th><th>When</th></tr></thead><tbody>
      ${e.recent.map((t) => `<tr><td>${t.source === 'apollo' ? '<span class="tag">Apollo</span> ' : ''}${esc(META.finderCategories.find((c) => c.id === t.category)?.label || t.category)} <span class="muted">in</span> ${esc(t.location)}</td>
        <td>${t.status === 'error' ? `${badge('bad', 'retrying')}<div class="cell-sub">${esc((t.error || '').slice(0, 120))}</div>` : badge('ok', 'done')}</td><td class="num">${n(t.found)}</td><td class="num">${n(t.imported)}</td><td class="cell-sub">${fmtDate(t.last_run_at)}</td></tr>`).join('') || `<tr><td colspan="5">${empty('No searches yet', ' — set it up above and start the engine.')}</td></tr>`}</tbody></table></div></div>`;

  const form = $('#eng-form');
  const refreshEst = () => {
    const c = $$('.eng-cat:checked').length;
    const l = $('#eng-locs').value.split('\n').map((x) => x.trim()).filter(Boolean).length;
    $('#eng-cat-count').textContent = `${c} selected`; $('#eng-loc-count').textContent = `${l} cities`;
    $('#eng-est').innerHTML = est(c, l);
  };
  form.addEventListener('input', () => { engineDirty = true; refreshEst(); });
  form.addEventListener('change', () => { engineDirty = true; refreshEst(); });
  $$('.cat-all').forEach((b) => { b.onclick = () => { const boxes = $$(`.eng-cat[data-g="${b.dataset.g}"]`); const on = !boxes.every((x) => x.checked); boxes.forEach((x) => { x.checked = on; }); engineDirty = true; refreshEst(); }; });
  $$('.preset').forEach((b) => { b.onclick = () => {
    const cur = $('#eng-locs').value.split('\n').map((x) => x.trim()).filter(Boolean);
    $('#eng-locs').value = [...new Set([...cur, ...META.cityPresets[b.dataset.k].cities])].join('\n');
    engineDirty = true; refreshEst();
  }; });
  $('#loc-clear').onclick = () => { $('#eng-locs').value = ''; engineDirty = true; refreshEst(); };
  const payload = () => {
    const f = formData(form);
    return { ...f, engine_categories: $$('.eng-cat:checked').map((x) => x.value).join(','), engine_apollo_enabled: f.engine_apollo_enabled ? '1' : '0' };
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const r = await act(ev.submitter, () => PUT('/engine', payload()), (x) => `Saved — ${n(x.targets)} search${x.targets === 1 ? '' : 'es'} planned`);
    if (r) route();
  };
  $('#eng-toggle').onclick = (ev) => act(ev.currentTarget, () => PUT('/engine', { ...(engineDirty ? payload() : {}), engine_enabled: e.enabled ? '0' : '1' }),
    e.enabled ? 'Lead engine paused' : 'Lead engine started — it searches around the clock while the app runs').then((r) => r && route());
  $('#eng-run').onclick = (ev) => act(ev.currentTarget, async () => { if (engineDirty) await PUT('/engine', payload()); return POST('/engine/run'); }, 'Search started — progress shows in the activity panel').then((r) => r && setTimeout(route, 300));
}

// ---------------------------------------------------------------- companies list
async function renderCompanies({ params }) {
  const qs = new URLSearchParams({ limit: '500', ...params });
  const { rows, total } = await GET('/companies?' + qs);
  const statusOpts = Object.entries(META.statuses).map(([k, v]) => `<option value="${k}" ${params.status === k ? 'selected' : ''}>${v}</option>`).join('');
  app.innerHTML = `
    ${head('Companies', `${n(total)} matching · unique by normalized domain`,
    `<a class="btn" href="/api/companies/export.csv?${qs}" data-testid="export-csv">${ic('file')}Export CSV</a><button class="primary" id="add-co" data-testid="add-company">${ic('plus')}Add company</button>`)}
    <div class="chips" data-testid="company-chips">${[
    ['All', {}], ['Not contacted yet', { contacted: 'no' }], ['Ready to email', { status: 'READY' }], ['Being researched', { status: 'RESEARCHING,HOLD_VERIFY' }],
    ['No email found', { hasEmail: 'no' }], ['Contacted', { contacted: 'yes' }], ['Replied', { status: 'REPLIED' }],
  ].map(([label, f]) => { const active = ['status', 'contacted', 'hasEmail'].every((k) => (params[k] || '') === (f[k] || '')); return `<a class="chip ${active ? 'active' : ''}" href="#/companies?${new URLSearchParams(f)}">${label}</a>`; }).join('')}</div>
    <form class="filters" id="filters">
      ${params.contacted ? `<input type="hidden" name="contacted" value="${esc(params.contacted)}">` : ''}${params.hasEmail ? `<input type="hidden" name="hasEmail" value="${esc(params.hasEmail)}">` : ''}
      <input name="search" placeholder="Search name, domain, email, person…" value="${esc(params.search || '')}" data-testid="search">
      <select name="status" data-testid="filter-status"><option value="">All statuses</option>${statusOpts}</select>
      <select name="offer"><option value="">All offers</option>${['A', 'B', 'C'].map((o) => `<option value="${o}" ${params.offer === o ? 'selected' : ''}>Offer ${o}</option>`).join('')}</select>
      <select name="sort"><option value="updated">Recently updated</option><option value="fit" ${params.sort === 'fit' ? 'selected' : ''}>Highest fit</option><option value="name" ${params.sort === 'name' ? 'selected' : ''}>Name</option></select>
      <button>Filter</button>
      <button type="button" id="verify-sel" data-testid="verify-selected" class="ghost">${ic('play')}Run checks on selected</button>
      <button type="button" id="contacted-sel" data-testid="mark-contacted" class="ghost">${ic('check')}Mark as already contacted</button>
    </form>
    <div class="table-wrap"><table data-testid="companies-table"><thead><tr><th style="width:36px"><input type="checkbox" id="sel-all"></th><th>Company</th><th>Status</th><th>Offer</th><th class="num">Fit</th><th>Contact</th><th>Decision-maker</th><th>Updated</th></tr></thead>
    <tbody>${rows.map((c) => `<tr data-testid="company-row" data-domain="${esc(c.domain)}">
      <td><input type="checkbox" class="sel" value="${c.id}"></td>
      <td><a href="#/company/${c.id}" class="cell-title">${esc(c.name)}</a><div class="cell-sub">${esc(c.domain)}${c.lead_origin ? ` · ${esc(String(c.lead_origin).replace(/^csv: /, '').slice(0, 40))}` : ''}</div></td>
      <td>${badge(c.status)}<div class="cell-sub" style="max-width:280px;margin-top:3px">${esc((c.status_reason || '').slice(0, 110))}</div></td>
      <td>${c.offer ? `<span class="tag">${esc(c.offer)}</span>` : '<span class="muted">—</span>'}</td><td class="num">${c.fit_score ?? '—'}</td>
      <td class="small-t">${esc(c.contact_email || '—')}</td>
      <td class="small-t">${esc(c.dm_name || '—')}${c.dm_title ? `<div class="cell-sub">${esc(c.dm_title)}</div>` : ''}</td>
      <td class="cell-sub">${fmtDate(c.updated_at)}</td></tr>`).join('') || `<tr><td colspan="8">${empty('No companies yet', ' — add one or import a list.')}</td></tr>`}</tbody></table></div>`;
  $('#filters').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(Object.entries(formData(e.target)).filter(([, v]) => v));
    location.hash = '#/companies?' + new URLSearchParams(f);
  };
  $('#sel-all').onchange = (e) => $$('.sel').forEach((c) => { c.checked = e.target.checked; });
  $('#verify-sel').onclick = (e) => {
    const ids = $$('.sel:checked').map((c) => Number(c.value));
    if (!ids.length) return toast('Select companies first', true);
    act(e.currentTarget, () => POST('/research/run', { ids }), (r) => `Checked ${r.stats.screened}: ${r.stats.newlyReady} newly READY`).then((r) => r && route());
  };
  $('#contacted-sel').onclick = (e) => {
    const ids = $$('.sel:checked').map((c) => Number(c.value));
    if (!ids.length) return toast('Select companies first', true);
    if (!confirm(`Mark ${ids.length} compan${ids.length === 1 ? 'y' : 'ies'} as already contacted? They will never get an intro from this app.`)) return;
    act(e.currentTarget, () => POST('/companies/mark-contacted', { ids }), (r) => `${r.affected} marked as already contacted`).then((r) => r && route());
  };
  $('#add-co').onclick = () => {
    const body = modal(`<h2>Add company</h2><p class="sub" style="margin-bottom:16px">Start with the name and domain — research and verification happen on the company page.</p><form id="add-form">
      <div class="grid g2"><div class="field"><label>Company name</label><input name="name" required data-testid="new-name"></div>
      <div class="field"><label>Website or domain</label><input name="domain" required placeholder="acme.com" data-testid="new-domain"></div></div>
      <div class="grid g2"><div class="field"><label>Offer</label><select name="offer" data-testid="new-offer"><option value="">Decide automatically</option>${Object.entries(META.offers).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
      <div class="field"><label>Lead origin</label><select name="lead_origin"><option>manual</option><option>linkedin</option><option>google maps</option><option>clutch</option><option>apollo</option><option>clay</option><option>directory</option><option>referral</option><option>website</option></select></div></div>
      <div class="row" style="justify-content:flex-end"><button type="button" data-close>Cancel</button><button class="primary" data-testid="save-new">Add &amp; open</button></div></form>`);
    $('#add-form', body).onsubmit = async (e) => {
      e.preventDefault();
      const r = await act(e.submitter, () => POST('/companies', formData(e.target)));
      if (!r) return;
      closeModal();
      toast(r.merged ? 'Company already existed — merged into the existing record' : 'Company added');
      location.hash = `#/company/${r.company.id}`;
    };
  };
}

// ---------------------------------------------------------------- company detail (Phase 3/4/5/6 + studio)
function input(c, name, label, opts = {}) {
  const v = c[name] ?? '';
  const t = opts.type || 'text';
  const tid = `f-${name}`;
  if (t === 'textarea') return `<div class="field"><label for="${tid}">${label}</label><textarea id="${tid}" name="${name}" data-testid="${tid}" placeholder="${esc(opts.ph || '')}">${esc(v)}</textarea></div>`;
  if (t === 'select') return `<div class="field"><label for="${tid}">${label}</label><select id="${tid}" name="${name}" data-testid="${tid}"><option value="">—</option>${Object.entries(opts.options).map(([k, l]) => `<option value="${k}" ${String(v) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  if (t === 'checkbox') return `<div class="field"><label class="check"><input type="checkbox" name="${name}" data-testid="${tid}" ${Number(v) === 1 ? 'checked' : ''}> <span>${label}</span></label></div>`;
  return `<div class="field"><label for="${tid}">${label}</label><input id="${tid}" type="${t}" name="${name}" value="${esc(v)}" data-testid="${tid}" placeholder="${esc(opts.ph || '')}"></div>`;
}

function researchLinks(c) {
  const q = encodeURIComponent;
  const name = c.name;
  return [
    ['LinkedIn: decision-makers', `https://www.linkedin.com/search/results/people/?keywords=${q(`${name} (founder OR CEO OR COO OR owner OR "managing director")`)}`],
    ['LinkedIn: company page', `https://www.linkedin.com/search/results/companies/?keywords=${q(name)}`],
    ['Google: team / leadership page', `https://www.google.com/search?q=${q(`site:${c.domain} (team OR leadership OR about OR founder)`)}`],
    ['Google: published emails', `https://www.google.com/search?q=${q(`"@${c.domain}"`)}`],
    ['Google: case studies & news', `https://www.google.com/search?q=${q(`"${name}" (case study OR announces OR launches OR expands)`)}`],
    ['Clutch profile', `https://www.google.com/search?q=${q(`site:clutch.co "${name}"`)}`],
    ['US legal entity (OpenCorporates)', `https://opencorporates.com/companies?q=${q(name)}`],
    ['BBB business profile', `https://www.bbb.org/search?find_text=${q(name)}`],
  ];
}

function signalsHtml(c) {
  let facts = {}; let auth = {};
  try { facts = JSON.parse(c.scan_facts || '{}'); } catch { /* none */ }
  try { auth = JSON.parse(c.mail_auth || '{}'); } catch { /* none */ }
  const sig = (ok, text) => `<span class="signal ${ok ? 'y' : 'n'}">${ok ? '✓' : '·'} ${esc(text)}</span>`;
  if (!c.scan_at) return '<p class="muted small-t">Run automated checks to scan the official website for signals.</p>';
  const reachable = JSON.parse(c.scan_emails || '[]').length || facts.headings?.length;
  return `<div>
    ${sig(reachable, reachable ? 'Website reachable' : 'Website not readable')}
    ${sig(!!c.us_presence_url, 'US address on site')}
    ${sig(facts.phones?.length, facts.phones?.length ? `US phone ${facts.phones[0].number}` : 'No US phone found')}
    ${sig(!!facts.social?.linkedin, 'LinkedIn page linked')}
    ${sig(!!facts.social?.clutch, 'Clutch profile linked')}
    ${sig(auth.spf, 'SPF record')}${sig(auth.dmarc, 'DMARC record')}
    ${sig(facts.hiring?.length, facts.hiring?.length ? `Hiring (${facts.hiring.length})` : 'No open roles found')}
    ${sig(facts.caseStudies?.length, `${facts.caseStudies?.length || 0} case studies`)}
  </div>${facts.tech?.length ? `<div class="small-t muted" style="margin-top:6px">Tech detected: ${facts.tech.map((t) => `<span class="tag">${esc(t.name)}</span>`).join(' ')}</div>` : ''}`;
}

async function renderCompany({ id }) {
  const [d, st] = await Promise.all([GET('/companies/' + id), GET(`/companies/${id}/studio`)]);
  const c = d.company; const ev = d.evaluation;
  const scanEmails = JSON.parse(c.scan_emails || '[]');
  const offers = META.offers;
  const simple = st.mode === 'simple';
  const done = ev.research.filter((r) => r.ok).length + ev.clearance.filter((r) => r.ok).length;
  const totalChecks = ev.research.length + ev.clearance.length;
  const canDraftTemplate = c.status === 'READY' && !d.messages.some((m) => m.kind === 'intro' && m.status !== 'cancelled');
  const checkLi = (r) => `<li data-testid="check-${r.key}" data-ok="${r.ok}"><span class="ck ${r.ok ? 'y' : 'n'}">${r.ok ? '✓' : '✕'}</span><div>${esc(r.label)}${r.detail ? `<div class="cell-sub">${esc(r.detail)}</div>` : ''}</div></li>`;

  app.innerHTML = `
    ${head(`<span data-testid="company-name">${esc(c.name)}</span>`,
    `${link(c.website, c.domain)} · origin ${esc(c.lead_origin || '—')} · added ${day(c.created_at)} · screened ${c.screen_count}× (last ${fmtDate(c.last_screened_at)})`,
    `${badge(c.status)}${canDraftTemplate ? `<button id="draft" data-testid="draft-intro">${ic('mail')}Draft intro email</button>` : ''}<button id="dnc" class="danger" data-testid="mark-dnc">Do not contact</button><button class="primary" id="verify" data-testid="verify">${ic('play')}Run automated checks</button>`,
    `<a href="#/companies" class="crumb">${ic('back')} Companies</a>`)}
    <div class="alert ${ev.status === 'READY' ? '' : 'sev-high'}" data-testid="status-reason">${ic(ev.status === 'READY' ? 'check' : 'alert')}<div class="grow"><strong>Decision:</strong> ${badge(ev.status)} ${esc(ev.reason)}
      ${ev.warnings.length ? `<div class="small-t" style="margin-top:6px;color:var(--warn)">⚠ ${ev.warnings.map(esc).join(' · ')}</div>` : ''}</div><span class="small-t muted">${done}/${totalChecks} checks</span></div>

    <div class="split mt">
      <form id="co-form" class="stack">
        <div class="card"><div class="card-head"><h2>Company verification</h2><span class="hint">every claim needs a source URL</span></div>
          <div class="grid g2">${input(c, 'name', 'Canonical company name')}<div class="field"><label>Canonical domain</label><input name="domain" value="${esc(c.domain)}" data-testid="f-domain"></div></div>
          <div class="grid g2">${input(c, 'offer', 'Offer', { type: 'select', options: offers })}${input(c, 'lead_origin', 'Lead origin')}</div>
          <div class="grid g2">${input(c, 'us_presence', 'US presence evidence', { ph: 'HQ: 120 Main St, Austin, TX 78701' })}${input(c, 'us_presence_url', 'Source URL')}</div>
          <div class="grid g2">${input(c, 'industry', 'Industry')}${input(c, 'services', 'Services')}</div>
          ${input(c, 'description', 'Business description', { type: 'textarea' })}${input(c, 'profile_url', 'Description source URL (official site)')}
          <div class="grid g3">${input(c, 'employee_count', 'Approx. employees', { type: 'number' })}${input(c, 'employee_count_url', 'Employee source URL')}${input(c, 'employee_count_date', 'Source date', { type: 'date' })}</div>
          <h3>Decision-maker${simple ? ' <span class="muted small-t">(optional — without one, emails start “Hi there”)</span>' : ''}</h3>
          <div class="grid g3">${input(c, 'dm_name', 'Name')}${input(c, 'dm_title', 'Current title')}${input(c, 'dm_url', 'Source URL (LinkedIn / team page)')}</div>
          ${input(c, 'dm_verified', 'I opened the source and confirmed this person currently holds this title at this company', { type: 'checkbox' })}
          <h3>Evidence &amp; fit</h3>
          <div class="grid g2">${input(c, 'portfolio_url', 'Portfolio / case study / workflow URL')}${input(c, 'portfolio_note', 'What it shows')}</div>
          ${input(c, 'personalization', 'Personalization — the email\'s first line (a verified fact; pick one in Email studio)', { type: 'textarea', ph: 'Saw your case study on migrating Acme Freight to a new TMS…' })}
          ${input(c, 'personalization_url', 'Personalization source URL')}
          <div class="grid g2">${input(c, 'fit_score', 'Fit score (1–10)', { type: 'number' })}${input(c, 'fit_rationale', 'Fit rationale')}</div>
        </div>
        <div class="card"><div class="card-head"><h2>Contact channel</h2><span class="hint">exact published email only</span></div>
          <div class="grid g2">${input(c, 'contact_email', 'Exact published email')}${input(c, 'email_source_url', 'Email source URL')}</div>
          <div class="grid g2">${input(c, 'email_evidence_type', 'Evidence classification', { type: 'select', options: META.evidenceTypes })}${input(c, 'email_contact_type', 'Contact type', { type: 'select', options: META.contactTypes })}</div>
          ${input(c, 'email_purpose', 'Contact purpose', { ph: 'Partnerships inbox listed on /partners page' })}
          ${input(c, 'email_manual_confirmed', 'I personally saw this exact email on the source page (use when the page hides it from automated checks)', { type: 'checkbox' })}
          ${input(c, 'manual_application_url', 'Vendor / partnership application form URL (→ Manual application)')}
          <div class="row small-t muted">
            <span>Source check: ${c.email_source_confirmed === 1 ? '<span class="ok-i">found on page</span>' : c.email_source_confirmed === 0 ? '<span class="no-i">NOT found</span>' : 'not checked'}</span>·
            <span>MX: ${c.mx_valid === 1 ? '<span class="ok-i">ok</span>' : c.mx_valid === 0 ? '<span class="no-i">none</span>' : 'not checked'}</span>·
            <span>checked ${fmtDate(c.email_checked_at)}</span>${c.email_auto_selected ? '<span>· auto-selected from website</span>' : ''}</div>
          ${scanEmails.length ? `<h3>Emails published on the website</h3><table data-testid="scan-emails"><tbody>${scanEmails.map((e) => `<tr><td class="mono">${esc(e.email)}</td><td class="small-t">${link(e.url)}</td><td class="num"><button type="button" class="small use-email" data-email="${esc(e.email)}">Use</button></td></tr>`).join('')}</tbody></table>` : ''}
        </div>
        <div class="card">${input(c, 'notes', 'Notes', { type: 'textarea' })}
          <div class="row spread"><button type="button" id="del" class="danger ghost">Delete company</button><button class="primary" data-testid="save-company">${ic('check')}Save evidence</button></div></div>
      </form>

      <div class="stack">
        <div class="card" data-testid="checklist"><div class="card-head"><h2>Readiness checklist</h2><span class="hint">${done}/${totalChecks}</span></div>
          <div class="bar ${done === totalChecks ? 'ok' : ''}"><span style="width:${(done / totalChecks) * 100}%"></span></div>
          <h3>Research facts</h3><ul class="checklist">${ev.research.map(checkLi).join('')}</ul>
          <h3>Contact, dedup &amp; compliance</h3><ul class="checklist">${ev.clearance.map(checkLi).join('')}</ul>
        </div>

        <div class="card" data-testid="studio"><div class="card-head"><h2>Email studio</h2><span class="hint">one email per lead, from verified facts</span></div>
          <h3 style="margin-top:0">1 · Pick a personal opener (from their website)</h3>
          ${st.suggestions.length ? st.suggestions.map((s, i) => `<div class="sugg ${c.personalization === s.text ? 'active' : ''}" data-testid="suggestion"><div class="grow"><div class="kind">${esc(s.kind.replace('_', ' '))}</div><div>${esc(s.text)}</div><div class="cell-sub">Source: ${link(s.source_url)} · ${esc(s.basis)}</div></div>
            <button type="button" class="small use-sugg" data-i="${i}" data-testid="use-suggestion" ${c.personalization === s.text ? 'disabled' : ''}>${c.personalization === s.text ? 'In use' : 'Use'}</button></div>`).join('')
    : '<p class="muted small-t">No suggestions yet — run automated checks so the website can be scanned, or write your own opener in the Personalization field.</p>'}
          <h3>2 · Industry angle</h3><div class="msg-body" data-testid="studio-angle">${esc(st.angle)}</div>
          <h3>3 · Review &amp; edit the email</h3>
          <div class="field"><label>Subject</label><input id="studio-subject" data-testid="studio-subject" value="${esc(st.draft.subject)}"></div>
          <div class="field"><label>Body</label><textarea id="studio-body" data-testid="studio-body" style="min-height:230px">${esc(st.draft.body)}</textarea></div>
          <details class="small-t"><summary>Footer added automatically &amp; facts the writer may use</summary><pre style="margin-top:8px">${esc(st.footer)}</pre><ul>${st.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>
          <div class="row spread mt">
            ${st.aiEnabled ? `<button type="button" id="studio-ai" data-testid="studio-ai">${ic('sparkle')}Write with AI</button>` : '<a href="#/settings?tab=ai" class="small-t">Add a free Groq key to write with AI →</a>'}
            <button type="button" class="primary" id="studio-save" data-testid="studio-save" ${st.canDraft ? '' : 'disabled'}>${ic('mail')}Save as draft</button></div>
          ${st.canDraft ? '' : `<p class="small-t muted" style="margin-top:8px">${st.existing ? `An intro already exists (${esc(st.existing.status)}).` : 'Saving a draft unlocks once the company is <strong>Ready</strong>.'}</p>`}
        </div>

        <div class="card"><div class="card-head"><h2>Research assistant</h2><span class="hint">free, one click</span></div>
          <div data-testid="signals">${signalsHtml(c)}</div>
          <h3>Find &amp; verify</h3><div class="link-grid" data-testid="research-links">${researchLinks(c).map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${ic('link')}${esc(t)}</a>`).join('')}</div>
        </div>

        <div class="card"><h2>Conflicts</h2>${ev.conflicts.length ? `<ul class="checklist" data-testid="conflicts">${ev.conflicts.map((x) => `<li><span class="ck ${x.hard ? 'n' : 'y'}">!</span>${esc(x.detail)}</li>`).join('')}</ul>` : '<div class="muted small-t" data-testid="no-conflicts">No duplicates or suppression conflicts found.</div>'}
          <div class="cell-sub" style="margin-top:8px">Dedup checked ${fmtDate(c.dedup_checked_at)} · HubSpot ${c.hubspot_id ? `#${esc(c.hubspot_id)} (stage ${esc(c.hubspot_stage || 'none')})` : 'no record linked'}</div></div>
        <div class="card"><h2>Messages</h2>${d.messages.length ? d.messages.map((m) => `<div style="margin-bottom:10px">${badge(m.status)} <strong>${esc(m.subject)}</strong><div class="cell-sub">${esc(m.kind)} → ${esc(m.to_email)} · ${fmtDate(m.sent_at || m.created_at)}</div>${m.status_reason ? `<div class="cell-sub">${esc(m.status_reason)}</div>` : ''}</div>`).join('') : '<div class="muted small-t">None yet.</div>'}
          ${d.replies.length ? `<h3>Replies</h3>${d.replies.map((r) => `<div>${badge(r.classification)} ${esc(r.from_email)} — ${esc(r.subject)}<div class="msg-body" style="margin-top:6px">${esc(r.snippet)}</div></div>`).join('')}` : ''}</div>
        <div class="card"><h2>Activity log</h2><div style="max-height:300px;overflow:auto">${d.activity.map((a) => `<div class="small-t" style="padding:6px 0;border-bottom:1px solid var(--line-2)"><span class="muted">${fmtDate(a.created_at)} · ${esc(a.actor)}</span> <strong>${esc(a.action)}</strong> <span class="muted mono">${esc(String(a.detail || '').slice(0, 200))}</span></div>`).join('')}</div></div>
      </div>
    </div>`;

  $('#co-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await act(e.submitter, () => PUT('/companies/' + id, formData(e.target)), (x) => `Saved — status ${META.statuses[x.status]}`);
    if (r) route();
  };
  $('#verify').onclick = (e) => act(e.currentTarget, () => POST(`/companies/${id}/verify`), (r) => `Checks done: ${r.log.length} steps → ${META.statuses[r.after]}`).then((r) => r && route());
  if ($('#draft')) $('#draft').onclick = (e) => act(e.currentTarget, () => POST('/outreach/drafts', { companyIds: [Number(id)] }), (r) => (r.created ? 'Draft created — review it in Outreach' : 'No draft created')).then((r) => r && route());
  $('#dnc').onclick = (e) => {
    const reason = prompt('Reason for do-not-contact?', 'Requested no contact');
    if (reason === null) return;
    act(e.currentTarget, () => POST(`/companies/${id}/status`, { status: 'DO_NOT_CONTACT', reason }), 'Marked do-not-contact').then((r) => r && route());
  };
  $('#del').onclick = (e) => {
    if (!confirm('Delete this company record?')) return;
    act(e.currentTarget, () => DEL('/companies/' + id), 'Deleted').then((r) => { if (r) location.hash = '#/companies'; });
  };
  $$('.use-email').forEach((b) => { b.onclick = (e) => act(e.currentTarget, () => POST(`/companies/${id}/use-email`, { email: b.dataset.email }), 'Contact email set from website').then((r) => r && route()); });
  $$('.use-sugg').forEach((b) => { b.onclick = (e) => act(e.currentTarget, () => POST(`/companies/${id}/personalize`, { index: Number(b.dataset.i) }), 'Personalization set from website (with source)').then((r) => r && route()); });
  if ($('#studio-ai')) $('#studio-ai').onclick = (e) => act(e.currentTarget, () => POST(`/companies/${id}/ai-draft`), 'Draft written by AI from verified facts — read it before saving').then((r) => {
    if (!r) return;
    $('#studio-subject').value = r.subject;
    $('#studio-body').value = r.body;
    if (r.problems?.length) toast(`Check before saving — ${r.problems.join('; ')}`, true);
  });
  $('#studio-save').onclick = (e) => act(e.currentTarget, () => POST(`/companies/${id}/custom-draft`, { subject: $('#studio-subject').value, body: $('#studio-body').value }), 'Draft saved — approve it in Outreach').then((r) => r && route());
}

// ---------------------------------------------------------------- import (Phase 2)
async function renderImport({ params }) {
  const [settings, d] = await Promise.all([GET('/settings'), GET('/dashboard')]);
  const I = d.integrations;
  app.innerHTML = `
    ${head('Find leads', 'Pull companies in from any source. Duplicates are merged automatically, and research checks each one before any email is written.')}
    <div class="tabs" id="imp-tabs"><button data-t="local" class="active" data-testid="tab-local">${ic('pin')}Local businesses</button><button data-t="domains">Paste websites</button><button data-t="csv">CSV files</button><button data-t="folder" data-testid="tab-folder">Leads folder</button><button data-t="history" data-testid="tab-history">Already contacted</button><button data-t="clay">Clay webhook</button><button data-t="free">More free sources</button>${I.apollo.configured ? '<button data-t="apollo">Apollo search</button>' : ''}${I.hubspot.configured ? '<button data-t="hubspot">HubSpot</button>' : ''}</div>
    <div id="imp-body"></div><div id="imp-result" class="mt"></div>`;
  const body = $('#imp-body');
  const showResult = (r) => { $('#imp-result').innerHTML = `<div class="card" data-testid="import-result"><h2>Import result</h2><pre>${esc(r.report || JSON.stringify(r, null, 2))}</pre><div class="row mt"><a class="btn" href="#/companies">Open companies →</a><a class="btn" href="#/research">Run a research batch →</a></div></div>`; };
  const tabs = {
    local: async () => {
      const groups = [...new Set(META.finderCategories.map((c) => c.group))];
      let saved = {}; try { saved = JSON.parse(localStorage.getItem('ll.finder') || '{}'); } catch { /* private mode */ }
      body.innerHTML = `<div class="card"><div class="card-head"><h2>Find local businesses</h2><span class="hint">free · OpenStreetMap · B2C &amp; local B2B</span></div>
        <p class="sub" style="margin:-6px 0 14px">Like searching Google Maps: pick a type of business and a city. Only businesses that list their <strong>own website</strong> are shown, because that's where research finds their published email. Want this done for every city, around the clock? Use the <a href="#/engine">Lead engine</a>.</p>
        <form id="fx-form" class="grid g4" style="align-items:start" novalidate>
          <div class="field"><label for="fx-cat">Type of business</label><select id="fx-cat" data-testid="finder-category">${groups.map((g) => `<optgroup label="${esc(g)}">${META.finderCategories.filter((c) => c.group === g).map((c) => `<option value="${c.id}" ${saved.category === c.id ? 'selected' : ''}>${esc(c.label)} (Offer ${c.offer})</option>`).join('')}</optgroup>`).join('')}<option value="custom" ${saved.category === 'custom' ? 'selected' : ''}>Other — OpenStreetMap tag…</option></select></div>
          <div class="field"><label for="fx-loc">City</label><input id="fx-loc" placeholder="e.g. Austin, TX" data-testid="finder-location" value="${esc(params.location || saved.location || '')}" autocomplete="off"><div class="field-err" id="fx-err" data-testid="finder-field-error" hidden></div></div>
          <div class="field"><label for="fx-limit">Max results</label><select id="fx-limit">${[20, 40, 100].map((x) => `<option ${Number(saved.limit || 40) === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div class="field"><label>&nbsp;</label><button class="primary" style="width:100%" data-testid="finder-search">${ic('search')}Search</button></div>
          <div class="field" id="fx-tag-wrap" ${saved.category === 'custom' ? '' : 'hidden'} style="grid-column:span 2"><label for="fx-tag">OpenStreetMap tag (key=value)</label><input id="fx-tag" placeholder="shop=bicycle" value="${esc(saved.customTag || '')}"></div>
        </form><div id="fx-res" data-testid="finder-panel"></div>
        <p class="small-t muted" style="margin-top:12px">Business data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>. Searches run in the background — you can switch pages and come back.</p></div>`;
      $('#fx-cat').onchange = () => { $('#fx-tag-wrap').hidden = $('#fx-cat').value !== 'custom'; };
      const res = $('#fx-res');
      let timer = null;
      const renderJob = (j) => {
        const p = j.params || {};
        if (j.status === 'running') {
          res.innerHTML = `<div class="working" data-testid="finder-working"><span class="spin lg"></span><div><strong>${esc(j.label)}…</strong><div class="small-t muted">Running for ${ago(j.started_at)} — the free servers usually answer in 20–60 seconds. You can leave this page; the result will be waiting here.</div></div></div>`;
          return;
        }
        if (j.status !== 'done') {
          res.innerHTML = `<div class="alert sev-high mt" data-testid="finder-error">${ic('alert')}<div class="grow"><strong>Search didn't finish.</strong> ${esc(j.error || j.message || 'Interrupted')}</div></div>`;
          return;
        }
        const r = j.result; const found = r.results;
        const fresh = found.filter((x) => !x.known).length;
        res.innerHTML = `<div class="row spread mt"><div><strong data-testid="finder-count">${found.length} business${found.length === 1 ? '' : 'es'} with a website</strong> <span class="muted small-t">· ${esc(p.location || '')} · ${r.skipped} skipped without their own website · searched ${fmtDate(j.finished_at)}${r.capped ? ' · central area of a large city' : ''}</span></div></div>
          ${found.length ? `<div class="table-wrap mt"><table data-testid="finder-results"><thead><tr><th style="width:36px"><input type="checkbox" id="fx-all" ${fresh ? 'checked' : ''} aria-label="Select all"></th><th>Business</th><th>Address</th><th>Phone</th><th></th></tr></thead><tbody>
          ${found.map((x, i) => `<tr data-testid="finder-row"><td><input type="checkbox" class="fx-sel" value="${i}" ${x.known ? 'disabled' : 'checked'} aria-label="Select ${esc(x.name)}"></td>
            <td><div class="cell-title">${esc(x.name)}</div><div class="cell-sub">${link(x.website, x.domain)} · ${esc(x.category)}</div></td>
            <td class="small-t">${esc(x.address || '—')}</td><td class="small-t">${esc(x.phone || '—')}</td>
            <td class="num">${x.known ? '<span class="tag">already in list</span>' : `<a href="${esc(x.osm_url)}" target="_blank" rel="noopener" class="small-t">map</a>`}</td></tr>`).join('')}</tbody></table></div>
          <div class="row spread mt"><label class="check"><input type="checkbox" id="fx-research" checked> <span>Research them right away (scan website, find published email)</span></label>
            <button class="primary" id="fx-import" data-testid="finder-import" ${fresh ? '' : 'disabled'}>${ic('plus')}Add ${fresh} selected</button></div>`
    : empty('Nothing found here', ' — try another category or a bigger nearby city.')}`;
        const count = () => { const k = $$('.fx-sel:checked').length; const b = $('#fx-import'); if (b) { b.innerHTML = `${ic('plus')}Add ${k} selected`; b.disabled = !k; } };
        if ($('#fx-all')) $('#fx-all').onchange = (ev) => { $$('.fx-sel:not(:disabled)').forEach((c) => { c.checked = ev.target.checked; }); count(); };
        $$('.fx-sel').forEach((c) => { c.onchange = count; });
        if ($('#fx-import')) $('#fx-import').onclick = (ev) => {
          const picked = $$('.fx-sel:checked').map((c) => found[Number(c.value)]);
          act(ev.currentTarget, () => POST('/finder/import', { results: picked, research: $('#fx-research').checked }),
            (x) => `${x.created} added${x.researchStarted ? ' — research is running (see the activity panel)' : ''}`).then((x) => { if (x) { showResult(x); follow(j.id); } });
        };
      };
      const follow = async (id) => {
        clearTimeout(timer);
        let j; try { j = await GET('/finder/job/' + id); } catch { return; }
        if (!res.isConnected) return;
        renderJob(j);
        if (j.status === 'running') timer = setTimeout(() => follow(id), 1500);
      };
      $('#fx-form').onsubmit = async (e) => {
        e.preventDefault();
        const loc = $('#fx-loc').value.trim();
        const err = $('#fx-err');
        if (!loc) { err.textContent = 'Type a city first, e.g. Austin, TX'; err.hidden = false; $('#fx-loc').focus(); return; }
        err.hidden = true;
        const cat = $('#fx-cat').value;
        const p = { category: cat, customTag: cat === 'custom' ? $('#fx-tag').value : undefined, location: loc, limit: Number($('#fx-limit').value) };
        try { localStorage.setItem('ll.finder', JSON.stringify(p)); } catch { /* private mode */ }
        const r = await act(e.submitter, () => POST('/finder/search', { ...p, async: true }));
        if (r?.jobId) follow(r.jobId);
      };
      // Coming back to this tab: show the running search or the last result.
      const last = await GET('/finder/latest');
      if (!last.none && res.isConnected) { renderJob(last); if (last.status === 'running') follow(last.id); }
    },
    csv: () => {
      body.innerHTML = `<div class="card"><div class="grid g2"><div class="field"><label>Source</label><select id="csv-source"><option value="auto">Auto-detect</option><option value="clay">Clay export</option><option value="apollo">Apollo export</option><option value="csv">Other CSV</option></select></div>
        <div class="field"><label>CSV file(s) — Clay, Apollo, Sales Navigator, Google Sheets…</label><input type="file" id="csv-file" accept=".csv,text/csv" multiple data-testid="csv-file"></div></div>
        <div id="csv-files"></div>
        <div class="field"><label>…or paste CSV</label><textarea id="csv-text" style="min-height:150px" class="mono" data-testid="csv-text" placeholder="name,domain,industry,employees&#10;Acme Logistics,acmelogistics.com,Logistics,85"></textarea></div>
        <div class="row" style="justify-content:flex-end"><button id="csv-preview" data-testid="csv-preview">Preview columns</button><button class="primary" id="csv-import" data-testid="csv-import">${ic('download')}Import</button></div><div id="csv-prev"></div></div>`;
      let files = [];
      $('#csv-file').onchange = async (e) => {
        files = [...e.target.files];
        if (files.length === 1) { $('#csv-text').value = await files[0].text(); $('#csv-files').innerHTML = ''; return; }
        $('#csv-text').value = '';
        $('#csv-files').innerHTML = `<p class="small-t">${files.length} files selected — each is imported separately: ${files.map((f) => esc(f.name)).join(', ')}</p>`;
      };
      $('#csv-preview').onclick = (e) => act(e.currentTarget, () => POST('/import/preview', { csv: $('#csv-text').value })).then((p) => {
        if (!p) return;
        $('#csv-prev').innerHTML = `<h3>Detected source: ${esc(p.source)}</h3><div class="table-wrap"><table data-testid="mapping"><thead><tr><th>Column</th><th>Maps to</th></tr></thead><tbody>${p.headers.map((h) => `<tr><td>${esc(h)}</td><td>${p.mapping[h] ? `<span class="tag">${esc(p.mapping[h])}</span>` : '<span class="muted">ignored</span>'}</td></tr>`).join('')}</tbody></table></div>`;
      });
      $('#csv-import').onclick = (e) => {
        if (files.length > 1) {
          return act(e.currentTarget, async () => {
            const out = [];
            for (const f of files) out.push({ file: f.name, ...(await POST('/import/csv', { csv: await f.text(), source: $('#csv-source').value, filename: f.name })) });
            return { report: out.map((r) => `${r.file}: ${r.created} new, ${r.merged} merged, ${r.skipped} skipped`).join('\n'), created: out.reduce((a, r) => a + r.created, 0) };
          }, (r) => `${r.created} new companies`).then((r) => r && showResult(r));
        }
        return act(e.currentTarget, () => POST('/import/csv', { csv: $('#csv-text').value, source: $('#csv-source').value, filename: files[0]?.name }), (r) => `${r.created} new, ${r.merged} merged`).then((r) => r && showResult(r));
      };
    },
    domains: () => {
      body.innerHTML = `<div class="card"><p class="sub" style="margin:-4px 0 12px">Copy websites from anywhere — LinkedIn company pages, Google Maps, Clutch, Apollo search results — and paste them here.</p>
        <div class="field"><label>Websites or domains (one per line, commas OK)</label><textarea id="dom-text" style="min-height:160px" class="mono" data-testid="domains-text" placeholder="acme-logistics.com&#10;https://www.brightpixel.studio"></textarea></div>
        <div class="row spread"><div class="field" style="margin:0;min-width:260px"><label>Offer</label><select id="dom-offer"><option value="">Decide automatically</option>${Object.entries(META.offers).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <button class="primary" id="dom-import" data-testid="domains-import">${ic('plus')}Add websites</button></div></div>`;
      $('#dom-import').onclick = (e) => act(e.currentTarget, () => POST('/import/domains', { text: $('#dom-text').value, offer: $('#dom-offer').value }), (r) => `${r.created} new, ${r.merged} existing`).then((r) => r && showResult(r));
    },
    hubspot: () => {
      body.innerHTML = `<div class="card"><p>Pull existing HubSpot companies into the local inventory (read-only). Existing <span class="code">ll_*</span> stages are kept so previously contacted companies are never re-introduced.</p>
        <button class="primary" id="hs-import" data-testid="hubspot-import">${ic('download')}Import from HubSpot</button></div>`;
      $('#hs-import').onclick = (e) => act(e.currentTarget, () => POST('/import/hubspot'), (r) => `Read ${r.read}: ${r.created} new, ${r.merged} merged`).then((r) => r && showResult(r));
    },
    apollo: () => {
      body.innerHTML = `<div class="card"><p>${settings.apollo_api_search_enabled === '1' ? '' : '<strong>API search is disabled</strong> (credit protection). Enable it in Settings → Integrations only if your plan allows credit-free people search. '}Recommended: export a list from Apollo and use the CSV tab.</p>
        <div class="grid g3"><div class="field"><label>Titles (comma separated)</label><input id="ap-titles" value="Founder, CEO, COO, Owner, Managing Director"></div>
        <div class="field"><label>Keywords</label><input id="ap-kw" placeholder="shopify agency"></div>
        <div class="field"><label>Employee range</label><input id="ap-emp" value="11,50"></div></div>
        <div class="row" style="justify-content:flex-end"><button id="ap-search">Search (no import)</button><button class="primary" id="ap-import">Search &amp; import</button></div><div id="ap-res"></div></div>`;
      const payload = (imp) => ({ titles: $('#ap-titles').value.split(',').map((s) => s.trim()).filter(Boolean), keywords: $('#ap-kw').value, employeeRanges: [$('#ap-emp').value], import: imp });
      $('#ap-search').onclick = (e) => act(e.currentTarget, () => POST('/import/apollo-search', payload(false))).then((r) => {
        if (r) $('#ap-res').innerHTML = `<table class="mt"><tbody>${r.results.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.domain)}</td><td>${esc(p.dm_name)} — ${esc(p.dm_title)}</td></tr>`).join('')}</tbody></table>`;
      });
      $('#ap-import').onclick = (e) => act(e.currentTarget, () => POST('/import/apollo-search', payload(true)), (r) => `${r.created} new`).then((r) => r && showResult(r));
    },
    folder: async () => {
      const f = await GET('/import/folder');
      const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
      body.innerHTML = `<div class="card" data-testid="folder-card"><div class="card-head"><h2>Leads folder</h2><span class="hint">${settings.watch_leads_folder === '1' ? 'watched · checked every 10 minutes' : 'not watched'}</span></div>
        <p class="sub" style="margin:-6px 0 12px">Drop CSV files into <span class="code">${esc(f.dir)}</span> and they are imported automatically — new files and changed files only. Duplicates merge by website.</p>
        ${f.files.length ? `<div class="table-wrap"><table data-testid="folder-files"><thead><tr><th>File</th><th>Size</th><th>Status</th><th>Result</th></tr></thead><tbody>
          ${f.files.map((x) => `<tr data-testid="folder-row"><td class="mono small-t">${esc(x.file)}</td><td class="small-t">${kb(x.size)}</td>
            <td>${x.importedAt ? (x.changed ? badge('warn', 'Changed — will re-import') : badge('ok', `Imported ${day(x.importedAt)}`)) : badge('warn', 'New')}</td>
            <td class="small-t muted">${x.stats ? `${x.stats.received} rows → ${x.stats.created} new, ${x.stats.merged} merged` : '—'}</td></tr>`).join('')}</tbody></table></div>`
    : empty('No CSV files in the folder yet')}
        <div class="row mt" style="justify-content:flex-end"><button id="fold-all">Re-import all</button><button class="primary" id="fold-new" data-testid="folder-import">${ic('download')}Import new files now</button></div></div>`;
      const run = (all) => (e) => act(e.currentTarget, () => POST('/import/folder', { all }), (r) => r.summary).then((r) => { if (r) { showResult({ report: r.files.map((x) => `${x.file}: ${x.error || `${x.received} rows → ${x.created} new, ${x.merged} merged, ${x.skipped} skipped`}`).join('\n') || r.summary }); tabs.folder(); } });
      $('#fold-new').onclick = run(false);
      $('#fold-all').onclick = run(true);
    },
    history: () => {
      body.innerHTML = `<div class="card" data-testid="history-card"><h2>People you already contacted</h2>
        <p class="sub" style="margin:-6px 0 12px">Paste emails or domains you emailed before — from HeyReach, Skymail, Gmail, another tool or a spreadsheet. They are never introduced again. Mail in your Hostinger <strong>Sent</strong> folder is picked up automatically once IMAP is connected.</p>
        <div class="field"><label>Emails and/or domains (any format — they are picked out of the text)</label><textarea id="hist-text" style="min-height:160px" class="mono" data-testid="history-text" placeholder="jane@acme.com&#10;bob@pixelforge.co, otherco.com"></textarea></div>
        <div class="grid g2"><div class="field"><label>…or a CSV file</label><input type="file" id="hist-file" accept=".csv,.txt,text/csv"></div><div class="field"><label>Where were they contacted?</label><input id="hist-note" value="Contacted before this app" data-testid="history-note"></div></div>
        <div class="row" style="justify-content:flex-end"><button class="primary" id="hist-go" data-testid="history-import">${ic('check')}Mark as already contacted</button></div></div>`;
      $('#hist-file').onchange = async (e) => { const fl = e.target.files[0]; if (fl) $('#hist-text').value = await fl.text(); };
      $('#hist-go').onclick = (e) => act(e.currentTarget, () => POST('/history/import', { text: $('#hist-text').value, note: $('#hist-note').value }),
        (r) => `${r.emails} emails and ${r.domains} domains recorded — ${r.affected} companies marked as contacted`).then((r) => r && showResult({ report: `${r.emails} emails and ${r.domains} domains recorded as already contacted.\n${r.affected} companies in your list are now marked Sent and will not get an intro.` }));
    },
    clay: () => {
      const url = `${location.origin}/hooks/clay`;
      body.innerHTML = `<div class="card"><p>In Clay, add an <strong>HTTP API</strong> column (POST, JSON body of the row) pointing to:</p>
        <pre data-testid="clay-url">${esc(url)}</pre><p class="small-t muted">Header <span class="code">x-clay-secret</span>: your secret. Clay must be able to reach this URL — see <a href="#/setup">Setup guide → Clay</a>. Otherwise export the Clay table as CSV and use the CSV tab.</p>
        <div class="row spread"><span>Secret: <span class="mono" id="clay-secret">${esc(settings.clay_webhook_secret || 'not set')}</span></span><button id="clay-gen" data-testid="clay-generate">Generate new secret</button></div></div>`;
      $('#clay-gen').onclick = (e) => act(e.currentTarget, () => POST('/integrations/clay/secret')).then((r) => { if (r) { $('#clay-secret').textContent = r.secret; toast('New secret generated — copy it into Clay now'); } });
    },
    free: () => {
      const src = [
        ['LinkedIn', 'https://www.linkedin.com/search/results/companies/', 'Search companies by industry, location and size. LinkedIn forbids scraping (accounts get banned), so copy each company\'s website into “Paste websites”. For people, export from Sales Navigator via Clay or Apollo and use the CSV tab.'],
        ['Google Maps / Google Business', 'https://www.google.com/maps/search/dentist+Austin+TX', 'The “Local businesses” tab is the free equivalent (Google\'s own API needs a billing account). For a business it misses, copy the website from its Google listing into “Paste websites”.'],
        ['Apollo (free plan)', 'https://app.apollo.io/#/companies', 'Search companies with filters, then copy websites into “Paste websites” — zero credits. Exported CSVs (uses credits) go in the CSV tab.'],
        ['Clay (free plan)', 'https://app.clay.com', 'Build a table, then Export → CSV and use the CSV tab, or push rows automatically with the Clay webhook tab.'],
        ['Clutch.co', 'https://clutch.co/agencies', 'Agencies by service and city, with size and portfolio — best for Offer B.'],
        ['Shopify / Webflow / HubSpot partner directories', 'https://www.shopify.com/partners/directory', 'Agencies listed by the platforms themselves — Offer B.'],
        ['Yelp / Tripadvisor', 'https://www.yelp.com/search?find_desc=salon&find_loc=Austin%2C+TX', 'Consumer-facing businesses (B2C) — copy their own website, not the Yelp page.'],
        ['Chambers of commerce & associations', 'https://www.google.com/search?q=%22member+directory%22+chamber+of+commerce+Austin', 'Member directories list local businesses with their websites.'],
      ];
      body.innerHTML = `<div class="card"><h2>More free places to find leads</h2><p class="sub" style="margin:-6px 0 12px">No scraping of sites that forbid it — collect websites by hand, paste them, and research does the rest.</p>
        <table class="plain"><tbody>${src.map(([t, u, d]) => `<tr><td style="width:240px"><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></td><td class="muted small-t">${esc(d)}</td></tr>`).join('')}</tbody></table></div>`;
    },
  };
  $$('#imp-tabs button').forEach((b) => { b.onclick = () => { $$('#imp-tabs button').forEach((x) => x.classList.toggle('active', x === b)); $('#imp-result').innerHTML = ''; tabs[b.dataset.t](); }; });
  const start = tabs[params.tab] ? params.tab : 'local';
  $$('#imp-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.t === start));
  tabs[start]();
}

// ---------------------------------------------------------------- research runs / reports (Phase 11)
async function renderResearch() {
  const [runs, daily, next] = await Promise.all([GET('/runs'), GET('/reports/daily'), GET('/research/next-batch')]);
  app.innerHTML = `
    ${head('Research runs &amp; reports', 'Each run screens up to the batch size (default 50), oldest-checked first. It never sends email or writes to HubSpot.',
    `<button id="save-daily" data-testid="save-daily">${ic('file')}Save daily summary</button><button class="primary" id="run" data-testid="run-research">${ic('play')}Run batch now</button>`)}
    <div class="split">
      <div class="card"><h2>Daily summary (live)</h2><pre data-testid="daily-summary">${esc(daily.text)}</pre></div>
      <div class="card"><h2>Next batch</h2><p class="small-t">${next.ids.length ? `${next.ids.length} companies queued: ${next.ids.slice(0, 50).map((i) => `<a href="#/company/${i}">#${i}</a>`).join(', ')}` : 'No companies are due for screening.'}</p></div>
    </div>
    <div class="card mt"><h2>History</h2><div class="table-wrap"><table data-testid="runs-table"><thead><tr><th>#</th><th>Type</th><th>Started</th><th>Status</th><th>Report</th></tr></thead>
      <tbody>${runs.map((r) => `<tr><td>${r.id}</td><td><span class="tag">${esc(r.kind)}</span></td><td class="cell-sub">${fmtDate(r.started_at)}</td><td>${badge(r.status)}</td><td><pre>${esc(r.report || '')}</pre>
        ${r.kind === 'research' && r.stats?.outstanding?.length ? `<details style="margin-top:6px"><summary class="small-t">Outstanding verification tasks (${r.stats.outstanding.length})</summary><ul class="small-t">${r.stats.outstanding.map((o) => `<li><a href="#/company/${o.id}">${esc(o.name)}</a> — ${o.missing.map(esc).join('; ')}</li>`).join('')}</ul></details>` : ''}</td></tr>`).join('') || `<tr><td colspan="5">${empty('No runs yet')}</td></tr>`}</tbody></table></div></div>`;
  $('#run').onclick = (e) => act(e.currentTarget, () => POST('/research/run', {}), (r) => `Run #${r.runId} complete`).then((r) => r && route());
  $('#save-daily').onclick = (e) => act(e.currentTarget, () => POST('/reports/daily'), 'Daily summary saved').then((r) => r && route());
}

// ---------------------------------------------------------------- outreach (Phase 9)
let AI_ON = false;
async function renderOutreach() {
  const [quota, msgs, d, sent] = await Promise.all([GET('/outreach/quota'), GET('/outreach/messages?status=draft,approved,blocked'), GET('/dashboard'), GET('/outreach/messages?status=sent,bounced,failed,cancelled')]);
  AI_ON = !!d.integrations.ai.configured;
  const row = (m) => `<tr data-testid="msg-row" data-status="${m.status}" data-id="${m.id}">
    <td><input type="checkbox" class="msel" value="${m.id}"></td>
    <td style="min-width:200px"><a href="#/company/${m.company_id}" class="cell-title">${esc(m.company_name)}</a><div class="cell-sub">${esc(m.to_email)}</div><div class="cell-sub">${esc(m.kind)} · fit ${m.fit_score ?? '—'}</div></td>
    <td><div class="cell-title" style="margin-bottom:6px">${esc(m.subject)}</div><div class="msg-body clamp" data-testid="msg-body">${esc(m.body)}</div>
      <button type="button" class="linkish small-t toggle-full" data-testid="toggle-full">Show full email ▾</button>${m.status_reason ? `<div class="small-t" style="color:var(--bad);margin-top:4px">${esc(m.status_reason)}</div>` : ''}</td>
    <td>${badge(m.status)}</td>
    <td class="num"><div class="grid" style="gap:6px"><button class="small edit" data-id="${m.id}" data-testid="preview">Preview / edit</button>${m.kind === 'intro' && AI_ON ? `<button class="small rewrite" data-id="${m.id}" data-testid="rewrite">${ic('sparkle')}Rewrite</button>` : ''}${m.status === 'approved' ? `<button class="small primary send" data-id="${m.id}" data-testid="send-now">${ic('send')}Send now</button>` : ''}</div></td></tr>`;
  app.innerHTML = `
    ${head('Outreach', 'Drafts → you approve → sent from your Hostinger mailbox within the daily limit. Every message is re-checked right before sending.')}
    ${d.compliance.ok ? '' : `<div class="alert sev-critical" data-testid="compliance-warning">${ic('alert')}<div class="grow"><strong>Compliance settings missing:</strong> ${esc(d.compliance.missing.join(', '))}.</div><a href="#/settings">Open settings →</a></div>`}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><div class="label">Sent today</div><div class="value" data-testid="quota-sent">${quota.sent} / ${quota.limit}</div><div class="bar"><span style="width:${Math.min(100, (quota.sent / (quota.limit || 1)) * 100)}%"></span></div></div>
      <div class="card kpi"><div class="label">Remaining today</div><div class="value">${quota.remaining}</div></div>
      <div class="card kpi"><div class="label">Approved, queued</div><div class="value" data-testid="quota-approved">${quota.approved}</div><div class="hint">auto-send ${quota.autoSend ? 'on (spaced, in window)' : 'off — use “Send now”'}</div></div>
      <div class="card kpi"><div class="label">Eligible READY</div><div class="value">${d.inventory.eligibleUnsent}</div></div>
    </div>
    <div class="card"><div class="card-head"><h2>Queue</h2><div class="row">
      <button id="cancel" class="danger ghost">Cancel selected</button>
      ${d.integrations.ai.configured ? `<button id="rewrite-sel" data-testid="rewrite-selected">${ic('sparkle')}Rewrite selected</button>` : ''}
      <button id="gen-fu" data-testid="generate-followups">Generate follow-ups</button>
      <button id="approve" data-testid="approve-selected">${ic('check')}Approve selected</button>
      <button class="primary" id="gen" data-testid="generate-drafts">${ic('sparkle')}Generate today's drafts</button></div></div>
      <div class="table-wrap"><table data-testid="queue-table"><thead><tr><th style="width:36px"><input type="checkbox" id="msel-all" data-testid="select-all-msgs"></th><th>Company</th><th>Message</th><th>Status</th><th></th></tr></thead>
      <tbody>${msgs.map(row).join('') || `<tr><td colspan="5">${empty('Queue is empty', ' — generate drafts from READY companies, or write one in a company’s Email studio.')}</td></tr>`}</tbody></table></div></div>
    <div class="card"><h2>Sent log</h2><div class="table-wrap"><table data-testid="sent-table"><thead><tr><th>Company</th><th>Subject</th><th>Status</th><th>Sent</th></tr></thead>
      <tbody>${sent.map((m) => `<tr data-testid="sent-row"><td><a href="#/company/${m.company_id}" class="cell-title">${esc(m.company_name)}</a><div class="cell-sub">${esc(m.to_email)} · ${esc(m.kind)}</div></td><td>${esc(m.subject)}${m.status_reason ? `<div class="cell-sub">${esc(m.status_reason)}</div>` : ''}</td><td>${badge(m.status)}</td><td class="cell-sub">${fmtDate(m.sent_at)}</td></tr>`).join('') || `<tr><td colspan="4">${empty('Nothing sent yet')}</td></tr>`}</tbody></table></div></div>`;
  const selected = () => $$('.msel:checked').map((c) => Number(c.value));
  $$('.toggle-full').forEach((b) => { b.onclick = () => { const box = b.previousElementSibling; const open = box.classList.toggle('clamp'); b.textContent = open ? 'Show full email ▾' : 'Show less ▴'; }; });
  const rewrite = (btn, list) => act(btn, () => POST('/outreach/rewrite', { ids: list }), (r) => r.summary).then((r) => { if (r) { if (r.notes?.length) showResult({ report: r.notes.join('\n') }); route(); } });
  $$('.rewrite').forEach((b) => { b.onclick = (e) => rewrite(e.currentTarget, [Number(b.dataset.id)]); });
  if ($('#rewrite-sel')) $('#rewrite-sel').onclick = (e) => { const list = selected(); if (!list.length) return toast('Select emails first', true); rewrite(e.currentTarget, list); };
  $('#msel-all').onchange = (e) => $$('.msel').forEach((c) => { c.checked = e.target.checked; });
  $('#gen').onclick = (e) => act(e.currentTarget, () => POST('/outreach/drafts', {}), (r) => `${r.created} draft(s) created`).then((r) => r && route());
  $('#gen-fu').onclick = (e) => act(e.currentTarget, () => POST('/outreach/followups'), (r) => `${r.created} follow-up draft(s)`).then((r) => r && route());
  $('#approve').onclick = (e) => {
    const ids = selected(); if (!ids.length) return toast('Select messages first', true);
    act(e.currentTarget, () => POST('/outreach/approve', { ids }), (r) => `${r.approved.length} approved, ${r.blocked.length} blocked`).then((r) => r && route());
  };
  $('#cancel').onclick = (e) => {
    const ids = selected(); if (!ids.length) return toast('Select messages first', true);
    act(e.currentTarget, () => POST('/outreach/cancel', { ids }), (r) => `${r.cancelled} cancelled`).then((r) => r && route());
  };
  $$('.send').forEach((b) => { b.onclick = (e) => act(e.currentTarget, () => POST('/outreach/send/' + b.dataset.id)).then((r) => { if (!r) return; r.ok ? toast('Sent ✓') : toast(r.reason, true); route(); }); });
  $$('.edit').forEach((b) => {
    b.onclick = async () => {
      const m = await GET('/outreach/preview/' + b.dataset.id);
      const body = modal(`<h2>Email to ${esc(m.to_email)}</h2>
        <div class="alert ${m.eligibility.ok ? '' : 'sev-critical'}">${ic(m.eligibility.ok ? 'check' : 'alert')}<div class="grow">${m.eligibility.ok ? 'Passes all pre-send checks' : `Blocked: ${esc(m.eligibility.reasons.join('; '))}`}</div></div>
        <h3>Exactly what they will receive</h3>
        <div class="email-view" data-testid="email-view"><div class="ev-head"><div><span>From</span>${esc(m.from || '')}</div><div><span>To</span>${esc(m.to_email)}</div><div><span>Subject</span><strong>${esc(m.subject)}</strong></div></div><div class="ev-body">${esc(m.fullText)}</div></div>
        <form id="edit-form"><h3>Edit</h3><div class="field"><label>Subject</label><input name="subject" value="${esc(m.subject)}" data-testid="edit-subject"></div>
        <div class="field"><label>Body</label><textarea name="body" style="min-height:260px" data-testid="edit-body">${esc(m.body)}</textarea></div>
        <div class="row mt" style="justify-content:flex-end"><button type="button" data-close>Close</button>${['draft', 'approved', 'blocked'].includes(m.status) ? '<button class="primary" data-testid="save-draft">Save (returns to draft)</button>' : ''}</div></form>`);
      $('#edit-form', body).onsubmit = async (e) => {
        e.preventDefault();
        const r = await act(e.submitter, () => PUT('/outreach/messages/' + m.id, formData(e.target)), 'Draft saved');
        if (r) { closeModal(); route(); }
      };
    };
  });
}

// ---------------------------------------------------------------- replies & pipeline (Phase 10)
async function renderReplies({ params }) {
  const [list, opps, d] = await Promise.all([GET('/replies?' + new URLSearchParams(params)), GET('/opportunities'), GET('/dashboard')]);
  const clsOpts = (cur) => ['positive', 'neutral', 'negative', 'opt_out', 'bounce', 'auto_reply', 'other'].map((k) => `<option ${k === cur ? 'selected' : ''}>${k}</option>`).join('');
  const others = params.other === '1' ? null : (await GET('/replies?classification=other')).length;
  app.innerHTML = `
    ${head('Replies &amp; pipeline', 'Replies, bounces and opt-outs are read from your Hostinger inbox. Opt-outs and bounces are suppressed automatically.',
    `<button class="primary" id="sync" data-testid="sync-mailbox">${ic('sync')}Sync mailbox now</button>`)}
    <div class="card"><div class="card-head"><h2>Inbox</h2><span class="hint">${list.length} message(s)${others ? ` · <a href="#/replies?other=1" data-testid="show-other">${others} other mail not related to your outreach (welcome emails, codes, newsletters) — show</a>` : params.other === '1' ? ' · <a href="#/replies">hide other mail</a>' : ''}</span></div><div class="table-wrap"><table data-testid="replies-table"><thead><tr><th>From</th><th>Message</th><th>Class</th><th>Done</th><th></th></tr></thead>
      <tbody>${list.map((r) => `<tr data-testid="reply-row" data-class="${r.classification}"><td style="min-width:180px">${r.company_id ? `<a href="#/company/${r.company_id}" class="cell-title">${esc(r.company_name)}</a>` : '<span class="muted">Unmatched</span>'}<div class="cell-sub">${esc(r.from_email)}</div><div class="cell-sub">${fmtDate(r.received_at)}</div></td>
        <td><div class="cell-title" style="margin-bottom:6px">${esc(r.subject)}</div><div class="msg-body">${esc(r.snippet)}</div></td>
        <td>${badge(r.classification)}<select class="small-t recls" data-id="${r.id}" style="margin-top:6px;width:auto">${clsOpts(r.classification)}</select></td>
        <td><input type="checkbox" class="handled" data-id="${r.id}" ${r.handled ? 'checked' : ''}></td>
        <td class="num"><button class="small suggest" data-id="${r.id}">Suggested reply</button></td></tr>`).join('') || `<tr><td colspan="5">${empty('No replies yet', ' — they appear here after each mailbox sync.')}</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h2>Sales pipeline</h2><span class="hint">Local only — nothing is created in HubSpot automatically · Revenue $${n(d.funnel.revenue)}</span></div>
      <div class="kanban" data-testid="pipeline">${META.pipelineStages.map(([k, label]) => { const items = opps.filter((o) => o.stage === k); return `<div class="col" data-stage="${k}"><div class="col-head"><span>${esc(label)}</span><span class="muted">${items.length}</span></div>
        ${items.map((o) => `<div class="item" data-testid="opp"><a href="#/company/${o.company_id}" class="cell-title">${esc(o.company_name)}</a>
          <div class="cell-sub">${o.value ? '$' + n(o.value) : ''} ${esc(o.notes || '')}</div>
          <select class="opp-stage" data-id="${o.id}">${META.pipelineStages.map(([s, l]) => `<option value="${s}" ${s === o.stage ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <input class="opp-value" data-id="${o.id}" placeholder="Value $" value="${o.value ?? ''}"></div>`).join('')}</div>`; }).join('')}</div></div>`;
  $('#sync').onclick = (e) => act(e.currentTarget, () => POST('/mailbox/sync'), (r) => `Synced: ${r.replies} replies, ${r.bounces} bounces, ${r.optOuts} opt-outs`).then((r) => r && route());
  $$('.recls').forEach((s) => { s.onchange = () => act(null, () => PUT('/replies/' + s.dataset.id, { classification: s.value }), 'Reclassified').then(() => route()); });
  $$('.handled').forEach((s) => { s.onchange = () => act(null, () => PUT('/replies/' + s.dataset.id, { handled: s.checked })); });
  $$('.opp-stage').forEach((s) => { s.onchange = () => act(null, () => PUT('/opportunities/' + s.dataset.id, { stage: s.value }), 'Stage updated').then(() => route()); });
  $$('.opp-value').forEach((s) => { s.onchange = () => act(null, () => PUT('/opportunities/' + s.dataset.id, { value: s.value }), 'Value saved').then(() => route()); });
  $$('.suggest').forEach((b) => {
    b.onclick = async () => {
      const r = await GET(`/replies/${b.dataset.id}/suggest`);
      modal(`<h2>Suggested response</h2><p class="sub" style="margin-bottom:12px">Copy into your mail client and personalize. Nothing is sent automatically.</p><textarea style="min-height:220px" data-testid="suggested">${esc(r.text)}</textarea><div class="row mt" style="justify-content:flex-end"><button data-close>Close</button></div>`);
    };
  });
}

// ---------------------------------------------------------------- HubSpot (Phase 7)
async function renderHubspot() {
  const [d, ops] = await Promise.all([GET('/dashboard'), GET('/hubspot/ops')]);
  app.innerHTML = `
    ${head('HubSpot sync', 'Propose → review the diff → approve → execute. A write counts only after HubSpot is re-read and matches.',
    `<button id="hs-test" data-testid="hs-test">Test connection</button><button id="hs-props" data-testid="hs-props">Check ll_* properties</button><button class="primary" id="hs-propose" data-testid="hs-propose">${ic('sync')}Propose sync batch</button>`)}
    ${d.integrations.hubspot.configured ? '' : `<div class="alert sev-high">${ic('alert')}<div class="grow">HubSpot is not configured. Follow the <a href="#/setup">Setup guide → HubSpot</a> (the free CRM works).</div></div>`}
    <div id="hs-info"></div>
    <div class="card"><div class="card-head"><h2>Operations</h2><div class="row"><button id="op-discard" class="danger ghost">Discard selected</button><button id="op-approve" data-testid="hs-approve">${ic('check')}Approve selected</button>
      <button class="primary" id="op-exec" data-testid="hs-execute">${ic('play')}Execute approved</button></div></div>
      <div class="table-wrap"><table data-testid="hs-ops"><thead><tr><th style="width:36px"><input type="checkbox" id="op-all" data-testid="hs-select-all"></th><th>Company</th><th>Op</th><th>Changes (before → after)</th><th>Status</th><th>Result</th></tr></thead>
      <tbody>${ops.map((o) => `<tr data-testid="hs-op" data-status="${o.status}"><td>${['proposed', 'approved'].includes(o.status) ? `<input type="checkbox" class="osel" value="${o.id}">` : ''}</td>
        <td><a href="#/company/${o.company_id}" class="cell-title">${esc(o.name)}</a><div class="cell-sub">${esc(o.domain)}</div></td><td><span class="tag">${esc(o.operation)}</span>${o.hubspot_id ? `<div class="cell-sub">#${esc(o.hubspot_id)}</div>` : ''}</td>
        <td class="small-t">${Object.entries(o.payload).map(([k, v]) => `<div><span class="mono">${esc(k)}</span>: <span class="muted">${esc(o.before?.[k] ?? '∅')}</span> → <strong>${esc(v)}</strong></div>`).join('')}</td>
        <td>${badge(o.status)}</td><td class="cell-sub">${esc(o.response ? (o.response.error || o.response.reason || (o.response.confirmedAt ? 'confirmed ' + fmtDate(o.response.confirmedAt) : '')) : '')}</td></tr>`).join('') || `<tr><td colspan="6">${empty('No operations proposed yet')}</td></tr>`}</tbody></table></div></div>`;
  const sel = () => $$('.osel:checked').map((c) => Number(c.value));
  $('#op-all').onchange = (e) => $$('.osel').forEach((c) => { c.checked = e.target.checked; });
  $('#hs-test').onclick = (e) => act(e.currentTarget, () => POST('/hubspot/test'), 'HubSpot connection OK');
  $('#hs-props').onclick = (e) => act(e.currentTarget, () => GET('/hubspot/properties')).then((r) => {
    if (!r) return;
    const missing = r.filter((p) => !p.exists).length;
    $('#hs-info').innerHTML = `<div class="card" data-testid="hs-prop-list"><div class="card-head"><h2>Custom properties</h2>${missing ? `<button class="primary small" id="hs-create-props" data-testid="hs-create-props">Create ${missing} missing</button>` : ''}</div><table class="plain"><tbody>${r.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td>${p.exists ? badge('ok', 'exists') : badge('bad', 'missing')}</td><td class="cell-sub">${esc(p.type || p.error || '')} ${p.options?.length ? 'options: ' + esc(p.options.join(', ')) : ''}</td></tr>`).join('')}</tbody></table></div>`;
    if ($('#hs-create-props')) $('#hs-create-props').onclick = (ev) => act(ev.currentTarget, () => POST('/hubspot/properties/create'), (x) => `Created ${x.created.length} propert${x.created.length === 1 ? 'y' : 'ies'}`).then((x) => x && $('#hs-props').click());
  });
  $('#hs-propose').onclick = (e) => act(e.currentTarget, () => POST('/hubspot/propose', {}), (r) => `${r.filter((x) => x.opId && !x.skipped).length} proposed, ${r.filter((x) => x.skipped).length} up to date`).then((r) => r && route());
  $('#op-approve').onclick = (e) => act(e.currentTarget, () => POST('/hubspot/ops/status', { ids: sel(), status: 'approved' }), (r) => `${r.changed} approved`).then((r) => r && route());
  $('#op-discard').onclick = (e) => act(e.currentTarget, () => POST('/hubspot/ops/status', { ids: sel(), status: 'discarded' }), (r) => `${r.changed} discarded`).then((r) => r && route());
  $('#op-exec').onclick = (e) => act(e.currentTarget, () => POST('/hubspot/execute'), (r) => `Attempted ${r.attempted}: confirmed ${r.confirmed}, failed ${r.failed}, blocked ${r.blocked}`).then((r) => r && route());
}

// ---------------------------------------------------------------- suppression (Phase 5)
async function renderSuppression({ params }) {
  const rows = await GET('/suppressions?' + new URLSearchParams(params));
  app.innerHTML = `
    ${head('Suppression list', 'Checked before a company can become READY and again right before every send. Opt-outs and complaints are permanent.')}
    <div class="card"><form id="sup-form" class="grid g4" style="align-items:end">
      <div class="field" style="grid-column:span 2"><label>Emails or domains (one per line)</label><textarea name="value" style="min-height:42px" data-testid="sup-value"></textarea></div>
      <div class="field"><label>Reason</label><select name="reason" data-testid="sup-reason">${Object.entries(META.suppressionReasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
      <div class="field"><label>Note</label><input name="note"></div>
      <div class="field"><button class="primary" data-testid="sup-add">${ic('shield')}Add to suppression</button></div></form></div>
    <div class="card"><div class="table-wrap"><table data-testid="sup-table"><thead><tr><th>Type</th><th>Value</th><th>Reason</th><th>Source</th><th>Added</th><th></th></tr></thead>
    <tbody>${rows.map((s) => `<tr data-testid="sup-row"><td><span class="tag">${esc(s.kind)}</span></td><td class="mono">${esc(s.value)}</td><td>${badge(['opt_out', 'complaint', 'bounce'].includes(s.reason) ? 'bad' : 'warn', META.suppressionReasons[s.reason] || s.reason)}</td><td class="cell-sub">${esc(s.source || '')}${s.note ? ` — ${esc(s.note)}` : ''}</td><td class="cell-sub">${fmtDate(s.created_at)}</td>
      <td class="num">${['opt_out', 'complaint'].includes(s.reason) ? '<span class="muted small-t">permanent</span>' : `<button class="small danger rm" data-id="${s.id}">Remove</button>`}</td></tr>`).join('') || `<tr><td colspan="6">${empty('Nothing suppressed yet')}</td></tr>`}</tbody></table></div></div>`;
  $('#sup-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await act(e.submitter, () => POST('/suppressions', formData(e.target)), (x) => `${x.added.length} added`);
    if (r) route();
  };
  $$('.rm').forEach((b) => { b.onclick = (e) => act(e.currentTarget, () => DEL('/suppressions/' + b.dataset.id), 'Removed').then((r) => r && route()); });
}

// ---------------------------------------------------------------- setup guide
async function renderSetup() {
  const [d, s] = await Promise.all([GET('/dashboard'), GET('/settings')]);
  const I = d.integrations;
  const section = (key, title, on, sub, steps, extra = '') => `<div class="card" data-testid="setup-${key}"><div class="card-head"><h2><span class="status-dot ${on ? 'on' : ''}"></span>&nbsp; ${title}</h2>${on ? badge('ok', 'Done') : badge('warn', 'Not set up')}</div>
    <p class="sub" style="margin:-6px 0 16px">${sub}</p><ol class="steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>${extra}</div>`;
  app.innerHTML = `
    ${head('Setup guide', 'Five steps, all free. Enter credentials only in <a href="#/settings">Settings</a> or the private <span class="code">.env</span> file — never paste passwords or keys into chats or emails.')}
    ${section('compliance', '1 · Sender identity &amp; compliance', d.compliance.ok, 'Required by anti-spam law (US CAN-SPAM). Nothing becomes READY until this is done. Tip: use the same domain for your sender email and website.', [
    'Open <a href="#/settings">Settings → Sender &amp; compliance</a>.',
    'Enter your name, title, sender email (your Hostinger mailbox), website and a <strong>physical postal address</strong> (a registered-agent or PO box address is fine).',
    'Keep the opt-out line and click <strong>Save settings</strong>.',
  ])}
    ${section('hostinger', '2 · Hostinger mailbox (sending + replies)', I.smtp.configured && I.smtp.mode !== 'capture' && I.imap.configured, 'Used to send outreach (SMTP) and to read replies, bounces and your Sent folder (IMAP).', [
    'Log in to <a href="https://hpanel.hostinger.com" target="_blank" rel="noopener">hPanel</a> → <strong>Emails</strong> → choose your domain → <strong>Email accounts</strong>. Create a mailbox (e.g. <span class="code">you@yourdomain.com</span>) or use an existing one; set or reset its password there.',
    'Open <a href="#/settings?tab=integrations">Settings → Integrations → Hostinger mailbox</a>. The servers are already filled in (<span class="code">smtp.hostinger.com</span> port 465 SSL/TLS, <span class="code">imap.hostinger.com</span> port 993). Enter the mailbox email and its password — one login is used for sending and reading.',
    'Click <strong>Save &amp; test connection</strong>, then <strong>Send a test email to myself</strong> and check it arrives in your inbox (not spam). The first successful test reads your Sent folder so nobody you already emailed gets a second intro.',
    'Deliverability (free, important): in hPanel → Emails → your domain, make sure <strong>SPF, DKIM and DMARC</strong> are configured. If DMARC is missing, add a DNS TXT record: name <span class="code">_dmarc</span>, value <span class="code">v=DMARC1; p=none; rua=mailto:you@yourdomain.com</span>.',
    'Check your domain with the button below, then start slowly: 5–10 emails/day for the first two weeks and raise the daily limit gradually.',
  ], `<div class="row mt"><button id="sender-auth" data-testid="sender-auth">${ic('shield')}Check my sending domain</button><span id="sender-auth-res" class="small-t" data-testid="sender-auth-res"></span></div>`)}
    ${section('ai', '3 · AI email writing — Groq (free)', I.ai.configured, 'Writes one email per lead from facts found on their website. Free tier, nothing to install on your Mac.', [
    'Go to <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>, sign in with Google or email (no card needed) and click <strong>Create API key</strong>.',
    'Put it in the <span class="code">.env</span> file in the app folder as <span class="code">GROQ_API_KEY=gsk_…</span> and restart the app — or paste it in <a href="#/settings?tab=ai">Settings → AI writing</a>. Never put it in <span class="code">.env.example</span> or share it.',
    'Click <strong>Test AI</strong>. The default model <span class="code">openai/gpt-oss-120b</span> writes best; switch to <span class="code">openai/gpt-oss-20b</span> if you hit the free daily limit.',
    'Every AI email passes a quality check (no invented numbers, links or placeholders) — if it fails, your template is used instead.',
  ])}
    ${section('leads', '4 · Leads on autopilot (free)', d.engine?.enabled, 'B2B and B2C. Every source is deduplicated by website, and everyone you already emailed is skipped.', [
    '<a href="#/engine">Lead engine</a>: tick the business types and add cities (one click for the 50 or 100 largest US cities, or UK, Canada, Australia, Germany, UAE), then <strong>Start engine</strong>. It searches around the clock, adds every business with its own website and re-checks each city every 30 days.',
    '<strong>Your existing lists</strong>: drop CSV files into the <span class="code">leads csv</span> folder inside the app — new and changed files are imported automatically every 10 minutes (Find &amp; import → Leads folder shows what was imported).',
    '<strong>Already emailed people?</strong> Find &amp; import → <strong>Already contacted</strong>: paste emails/domains from HeyReach, Skymail or any other tool. Your Hostinger Sent folder is read automatically once IMAP is connected. Nobody gets a second intro.',
    'Research runs by itself: it reads each website, finds the published email, checks MX/SPF/DMARC and picks an opener from a real fact on the site.',
  ])}
    ${section('autopilot', '5 · Turn on autopilot', s.autopilot_enabled === '1', 'Daily, hands-free: research → personal email → send, within your limit.', [
    'In <a href="#/settings?tab=schedule">Settings → Autopilot &amp; schedule</a> pick the timezone your recipients are in (sending window 9:00–16:00 their time, Mon–Fri).',
    'Start with a daily limit of <strong>10</strong> for two weeks, then raise it by about 5 per week. A new mailbox that suddenly sends a lot lands in spam.',
    'Switch on <strong>Autopilot</strong> on the dashboard. Keep the app running (and the Mac awake) during the sending window — <span class="code">caffeinate -i npm start</span> keeps it awake.',
    'Check <a href="#/replies">Replies</a> daily. Opt-outs and bounces are suppressed automatically.',
  ])}
    <h2 class="mt" style="margin-bottom:12px">Optional</h2>
    ${section('hubspot', 'HubSpot CRM (optional)', I.hubspot.configured, 'Skip this unless you want leads mirrored into HubSpot. The pipeline works without it.', [
    'Newer HubSpot accounts no longer offer private (“legacy”) apps. Go to <strong>Development → Keys → Service keys</strong> (or the <strong>Create a service key</strong> button on the Legacy Apps page) and create a key.',
    'Give it the scopes <span class="code">crm.objects.companies.read</span>, <span class="code">crm.objects.companies.write</span>, <span class="code">crm.objects.contacts.read</span>, <span class="code">crm.schemas.companies.read</span> and <span class="code">crm.schemas.companies.write</span>.',
    'Copy the key, paste it in <a href="#/settings?tab=integrations">Settings → Integrations → HubSpot</a>, save and click <strong>Test HubSpot</strong>. (Older accounts: a private app token starting with <span class="code">pat-</span> works the same way.)',
    'A <strong>HubSpot sync</strong> page then appears in the sidebar: <strong>Check ll_* properties → Create missing</strong>.',
  ])}
    ${section('apollo', 'Apollo (optional)', I.apollo.configured, 'Adds Apollo companies to the Lead engine automatically. The pipeline works without it.', [
    'In Apollo open <strong>Settings → Integrations → API</strong> (<a href="https://app.apollo.io/#/settings/integrations/api" target="_blank" rel="noopener">direct link</a>) and create an API key. Apollo only allows API access on some plans — the Test button tells you if yours does.',
    'Paste the key in <a href="#/settings?tab=integrations">Settings → Integrations → Apollo</a> (or <span class="code">APOLLO_API_KEY=</span> in <span class="code">.env</span>), save and click <strong>Test Apollo</strong>.',
    'Tick <strong>Allow API people search</strong>. The app only uses Apollo’s people search, which returns companies and titles but no emails, so it does not spend credits. Never paste the key into a chat.',
    'In the <a href="#/engine">Lead engine</a> tick <strong>Also search Apollo</strong> and add keywords (e.g. <span class="code">shopify agency</span>, <span class="code">logistics company</span>). Each keyword × city is searched page by page.',
    'Exported Apollo CSVs (these use credits) can simply be dropped into the <span class="code">leads csv</span> folder.',
  ])}
    ${section('clay', 'Clay (optional)', I.clay.configured, 'Clay has no API that other apps can read from — Clay sends rows to this app instead (webhook), or you export CSVs.', [
    '<strong>Simplest:</strong> in your Clay table click <strong>Export → CSV</strong> and drop the file into the <span class="code">leads csv</span> folder. It is imported within 10 minutes, columns detected automatically.',
    '<strong>Automatic:</strong> run a free Cloudflare Tunnel so Clay can reach this Mac: <span class="code">brew install cloudflared</span>, then <span class="code">cloudflared tunnel --url http://127.0.0.1:4317</span> — it prints a public https address.',
    'Sign-in protects everything else automatically — only the webhook (with its secret) and the unsubscribe links are public.',
    'Find &amp; import → <strong>Clay webhook</strong> → <strong>Generate new secret</strong>. In Clay add an <strong>HTTP API</strong> column: method POST, URL <span class="code">https://&lt;tunnel&gt;/hooks/clay</span>, header <span class="code">x-clay-secret: &lt;secret&gt;</span>, body = the row as JSON. Turn on auto-run and every new Clay row lands here.',
  ])}`;
  $('#sender-auth').onclick = (e) => act(e.currentTarget, () => GET('/sender/auth')).then((r) => {
    if (!r) return;
    const item = (ok, t) => `<span class="signal ${ok ? 'y' : 'n'}">${ok ? '✓' : '✕'} ${t}</span>`;
    $('#sender-auth-res').innerHTML = `${esc(r.domain)}: ${item(r.mx, 'MX')}${item(r.spf, r.spfIncludesHostinger ? 'SPF (Hostinger)' : 'SPF')}${item(r.dkim, r.dkim ? `DKIM (${r.dkim})` : 'DKIM not found')}${item(r.dmarc, 'DMARC')}`;
  });
}

// ---------------------------------------------------------------- settings (Phase 1 + integrations)
const TIMEZONES = [['America/New_York', 'US Eastern (New York)'], ['America/Chicago', 'US Central (Chicago)'], ['America/Denver', 'US Mountain (Denver)'], ['America/Los_Angeles', 'US Pacific (Los Angeles)'],
  ['Europe/London', 'UK (London)'], ['Europe/Berlin', 'Central Europe (Berlin)'], ['Asia/Dubai', 'Gulf (Dubai)'], ['Asia/Karachi', 'Pakistan (Karachi)'], ['Australia/Sydney', 'Australia (Sydney)']];

async function renderSettings({ params = {} } = {}) {
  if (params.tab === 'integrations') return renderIntegrations({ params });
  const s = await GET('/settings');
  const f = (key, label, opts = {}) => input(s, key, label, opts);
  // Keep a custom port selectable so saving the form never silently changes it.
  const portOpts = (cur, opts) => (cur && !(String(cur) in opts) ? { ...opts, [cur]: String(cur) } : opts);
  const testBtn = (name, label, tid) => `<button type="button" class="itest" data-name="${name}" ${tid ? `data-testid="${tid}"` : ''}>${label}</button>`;
  const sections = {
    offers: `<div class="grid g3"><div class="card"><h2>Offer A</h2>${f('offer_a_name', 'Name')}${f('offer_a_pitch', 'One-line pitch (used in emails)', { type: 'textarea' })}<div class="grid g2">${f('offer_a_min_employees', 'Min employees', { type: 'number' })}${f('offer_a_max_employees', 'Max employees', { type: 'number' })}</div>${f('offer_a_industries', 'Target industries')}</div>
      <div class="card"><h2>Offer B</h2>${f('offer_b_name', 'Name')}${f('offer_b_pitch', 'One-line pitch (used in emails)', { type: 'textarea' })}<div class="grid g2">${f('offer_b_min_employees', 'Min employees', { type: 'number' })}${f('offer_b_max_employees', 'Max employees', { type: 'number' })}</div>${f('offer_b_industries', 'Target agency types')}</div>
      <div class="card"><h2>Offer C <span class="muted small-t">B2C / local</span></h2>${f('offer_c_name', 'Name')}${f('offer_c_pitch', 'One-line pitch (used in emails)', { type: 'textarea' })}${f('offer_c_industries', 'Target business types')}</div></div>`,
    sender: `<div class="card"><h2>Sender identity &amp; CAN-SPAM</h2><p class="sub" style="margin:-6px 0 14px">Required before any company can become READY.</p>
      <div class="grid g2">${f('sender_name', 'Sender name')}${f('sender_title', 'Sender title')}${f('sender_email', 'Sender email (your Hostinger mailbox)')}${f('sender_company', 'Company')}${f('sender_website', 'Website')}${f('sender_postal_address', 'Physical postal address')}</div>${f('unsubscribe_text', 'Opt-out line')}</div>`,
    schedule: `<div class="card" data-testid="autopilot-settings"><h2>${ic('bolt')}Autopilot</h2><p class="sub" style="margin:-6px 0 14px">When on, it researches new leads, writes one email per lead (with AI if a Groq key is set), approves emails that pass every check, and sends them within the limits below. The app must be running.</p>
      ${f('autopilot_enabled', 'Run the whole pipeline automatically every day', { type: 'checkbox' })}
      ${f('autopilot_review', 'Let me approve each email before it goes out (autopilot still finds, researches and writes)', { type: 'checkbox' })}
      <div class="grid g2">${f('pipeline_mode', 'Research rules', { type: 'select', options: { simple: 'Simple — automatic; decision-maker optional (recommended)', strict: 'Strict — every fact verified by hand, incl. decision-maker' } })}
      ${f('send_timezone', 'Send in this timezone (your recipients’)', { type: 'select', options: Object.fromEntries(TIMEZONES) })}</div>
      ${f('allow_provider_emails', 'Also email addresses that come from Clay, Apollo or your CSV files (the email must be on the company’s own domain; mailboxes are not validated, so bounces are watched)', { type: 'checkbox' })}
      ${f('bounce_guard_enabled', 'Pause automatic sending if more than 5% of the last 7 days’ emails bounce (protects your domain)', { type: 'checkbox' })}
      ${f('watch_leads_folder', 'Import new CSV files from the “leads csv” folder automatically', { type: 'checkbox' })}</div>
      <div class="card" data-testid="volume-settings"><h2>Volume, timing &amp; warm-up</h2><p class="sub" style="margin:-6px 0 14px">Each day's emails go out at random times across the window — a few minutes apart, then a longer break, like a person working through a list. A 6-hour window (e.g. 9–15) is recommended.</p>
      <div class="grid g3">${f('daily_send_limit', 'Daily limit (warm-up starting level)', { type: 'number' })}${f('send_days', 'Send days (0=Sun … 6=Sat)')}
      ${f('send_window_start', 'Send window start (hour)', { type: 'number' })}${f('send_window_end', 'Send window end (hour)', { type: 'number' })}${f('reserve_target_days', 'Reserve target (days)', { type: 'number' })}
      ${f('min_minutes_between_sends', 'Shortest gap between emails (minutes)', { type: 'number' })}${f('max_minutes_between_sends', 'Usual longest gap (minutes)', { type: 'number' })}</div>
      ${f('send_spread', 'Send at random, human-like times across the whole window (recommended — protects your domain)', { type: 'checkbox' })}
      <h3>Warm-up</h3>
      ${f('warmup_enabled', 'Raise the daily limit automatically over time (recommended for a new mailbox)', { type: 'checkbox' })}
      <div class="grid g4">${f('warmup_hold_days', 'Keep the starting limit for (days)', { type: 'number' })}${f('warmup_step', 'Then add (emails per day)', { type: 'number' })}${f('warmup_every_days', 'Every (days)', { type: 'number' })}${f('warmup_max', 'Up to (emails per day)', { type: 'number' })}</div>
      <p class="small-t muted" id="warmup-preview" data-testid="warmup-preview"></p>
      ${f('auto_send_enabled', 'Auto-send APPROVED messages during the send window (never sends unapproved drafts)', { type: 'checkbox' })}
      ${f('auto_draft_enabled', 'Auto-generate the day\'s drafts each morning (you still approve them)', { type: 'checkbox' })}
      <div class="grid g3">${f('followup_after_days', 'Follow-up after (days)', { type: 'number' })}${f('max_followups', 'Max follow-ups', { type: 'number' })}</div>${f('followup_enabled', 'Draft follow-ups for unanswered intros', { type: 'checkbox' })}</div>
      <div class="card"><h2>Research automation</h2>${f('research_auto_enabled', 'Run research batches automatically', { type: 'checkbox' })}<div class="grid g3">${f('research_interval_minutes', 'Interval (minutes)', { type: 'number' })}${f('research_batch_size', 'Batch size', { type: 'number' })}${f('research_rescreen_hours', 'Re-screen after (hours)', { type: 'number' })}${f('email_recheck_days', 'Re-verify email after (days)', { type: 'number' })}${f('dedup_recheck_days', 'Re-run dedup after (days)', { type: 'number' })}${f('qualified_target', 'Qualified-company target', { type: 'number' })}</div></div>`,
    templates: `<div class="card"><h2>Email templates</h2><p class="sub" style="margin:-6px 0 14px">Variables: {{first_name}} {{company}} {{personalization}} {{angle}} {{offer_pitch}} {{offer_name}} {{sender_name}} {{sender_company}} {{dm_title}}. “first_name” falls back to “there” unless the recipient is the decision-maker's own published email. {{angle}} is an industry-specific sentence.</p>
      <h3>Offer A</h3>${f('template_a_subject', 'Subject')}${f('template_a_body', 'Body', { type: 'textarea' })}<h3>Offer B</h3>${f('template_b_subject', 'Subject')}${f('template_b_body', 'Body', { type: 'textarea' })}<h3>Offer C (local / B2C)</h3>${f('template_c_subject', 'Subject')}${f('template_c_body', 'Body', { type: 'textarea' })}<h3>Follow-up</h3>${f('template_followup_body', 'Body', { type: 'textarea' })}</div>`,
    ai: `<div class="card"><h2>${ic('sparkle')}AI email writing (Groq — free)</h2><p class="sub" style="margin:-6px 0 14px">Groq's free tier writes each email from the facts research verified on the lead's own website. Nothing to install. Emails that fail the quality check (placeholders, links, invented numbers, wrong length) fall back to your template.</p>
      ${f('ai_writing', 'Write emails with AI when a key is set', { type: 'checkbox' })}
      ${f('writing_style_example', 'Optional: paste an email you wrote yourself — the AI copies its tone and length, never its content', { type: 'textarea', ph: 'Hi Sam,\n\nSaw the new booking page on your site...\n\nAhmed' })}
      <div class="grid g2">${f('groq_api_key', 'Groq API key (or GROQ_API_KEY in .env)', { type: 'password' })}${f('groq_model', 'Model', { type: 'select', options: { 'openai/gpt-oss-120b': 'openai/gpt-oss-120b (best writing)', 'openai/gpt-oss-20b': 'openai/gpt-oss-20b (faster, higher free limits)', 'qwen/qwen3.8-27b': 'qwen/qwen3.8-27b' } })}</div>
      <div class="row">${testBtn('ai', 'Test AI', 'test-ai')}<a href="https://console.groq.com/keys" target="_blank" rel="noopener" class="small-t">Get a free key →</a></div></div>`,
  };
  sections.security = `<div class="grid g2" id="sec-root" data-testid="security">
      ${params.welcome ? `<div class="alert sev-medium" style="grid-column:1/-1">${ic('shield')}<div class="grow"><strong>Your account is ready.</strong> Turn on two-factor authentication below to finish securing it.</div></div>` : ''}
      <div class="card"><div class="card-head"><h2>${ic('shield')}Two-factor authentication</h2><span id="tfa-badge"></span></div><div id="sec-2fa" data-testid="sec-2fa"><span class="muted">Loading…</span></div></div>
      <div class="card"><h2>Password</h2><div class="field"><label for="pw-cur">Current password</label><input type="password" id="pw-cur" autocomplete="current-password"></div>
        <div class="field"><label for="pw-new">New password (10+ characters, letters and a number)</label><input type="password" id="pw-new" autocomplete="new-password"></div>
        <button type="button" id="pw-save" data-testid="pw-save">${ic('check')}Change password</button></div>
      <div class="card" style="grid-column:1/-1" data-testid="account-card"><div class="card-head"><h2>${ic('users')}Your account</h2></div><div id="sec-account"></div></div></div>`;
  const names = { offers: 'Offers', sender: 'Sender & compliance', schedule: 'Autopilot & schedule', templates: 'Templates', ai: 'AI writing', security: 'Security' };
  const tab = sections[params.tab] ? params.tab : 'offers';
  app.innerHTML = `${head('Settings', 'Offers, compliance, sending schedule, templates and AI writing. Connections live in Integrations. Everything is stored only in your local database.')}
    <div class="tabs" id="set-tabs">${Object.keys(sections).map((k) => `<button type="button" data-t="${k}" class="${k === tab ? 'active' : ''}" data-testid="settings-tab-${k}">${names[k]}</button>`).join('')}<a href="#/integrations" data-testid="settings-tab-integrations">Integrations ↗</a></div>
    <form id="set-form">${Object.entries(sections).map(([k, html]) => `<div class="tab-pane" data-pane="${k}" ${k === tab ? '' : 'hidden'}>${html}</div>`).join('')}
    <div class="row mt" style="justify-content:flex-end"><button class="primary" data-testid="save-settings">${ic('check')}Save settings</button></div></form>`;
  $$('#set-tabs button').forEach((b) => { b.onclick = () => { $$('#set-tabs button').forEach((x) => x.classList.toggle('active', x === b)); $$('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.t; }); }; });
  $('#set-form').onsubmit = async (e) => {
    e.preventDefault();
    await act(e.submitter, () => PUT('/settings', formData(e.target)), 'Settings saved');
  };
  const warmPreview = () => {
    const el = $('#warmup-preview'); if (!el) return;
    const v = (k) => Number($(`[name="${k}"]`)?.value || 0);
    const base = Math.max(1, v('daily_send_limit')); const hold = Math.max(1, v('warmup_hold_days')); const stepN = v('warmup_step'); const every = Math.max(1, v('warmup_every_days')); const max = Math.max(base, v('warmup_max'));
    if (!$('[name="warmup_enabled"]')?.checked || !stepN) { el.textContent = `Always ${base} emails per day.`; return; }
    const parts = [`Days 1–${hold}: ${base}/day`]; let day = hold + 1; let lvl = base;
    while (lvl < max && parts.length < 8) { lvl = Math.min(max, lvl + stepN); const to = lvl >= max ? '' : `–${day + every - 1}`; parts.push(`day${to ? 's' : ''} ${day}${to}: ${lvl}${lvl >= max ? '/day from then on' : ''}`); day += every; }
    const spread = $('[name="send_spread"]')?.checked;
    const hours = Math.max(1, v('send_window_end') - v('send_window_start'));
    el.textContent = `${parts.join(' · ')}. ${spread ? `Emails go out at random times over ${hours} hours — mostly ${v('min_minutes_between_sends')}–${Math.round(v('min_minutes_between_sends') + (v('max_minutes_between_sends') - v('min_minutes_between_sends')) * 0.35)} minutes apart, sometimes up to ${v('max_minutes_between_sends')}, with a few longer breaks.` : `Emails go out from the window start, ${v('min_minutes_between_sends')}–${v('max_minutes_between_sends')} minutes apart.`} If more than 3% bounce, it drops back to ${base}/day until that improves.`;
  };
  ['daily_send_limit', 'warmup_enabled', 'warmup_hold_days', 'warmup_step', 'warmup_every_days', 'warmup_max', 'send_spread', 'send_window_start', 'send_window_end', 'min_minutes_between_sends', 'max_minutes_between_sends']
    .forEach((k) => $(`[name="${k}"]`)?.addEventListener('input', warmPreview));
  warmPreview();
  wireIntegrations();
  wireSecurity(params);
}

/** Test buttons save the form first; mailbox status/test email. Shared by Settings and Integrations. */
function wireIntegrations() {
  // Test buttons save the form first, so a freshly typed password is what gets tested.
  const saveForm = () => PUT('/settings', formData($('#set-form')));
  const mailRes = (r, err) => { const el = $('#mailbox-res'); if (el) { el.textContent = r; el.className = `small-t mt ${err ? 'field-err' : ''}`; } };
  $$('.itest').forEach((b) => {
    b.onclick = (e) => act(e.currentTarget, async () => {
      await saveForm();
      try { return await POST(`/integrations/${b.dataset.name}/test`); } catch (err) { if (b.dataset.name === 'mailbox') mailRes(err.message, true); throw err; }
    }, (r) => {
      const detail = typeof r.detail === 'string' ? r.detail : 'OK';
      if (b.dataset.name === 'mailbox') { mailRes(detail); mailboxStatus(); return detail; }
      return `${b.dataset.name}: ${detail}`;
    });
  });
  const te = $('#mail-test-email');
  if (te) te.onclick = (e) => act(e.currentTarget, async () => {
    await saveForm();
    try { return await POST('/mailbox/test-email'); } catch (err) { mailRes(err.message, true); throw err; }
  }, (r) => { mailRes(r.detail); return r.detail; });
  async function mailboxStatus() {
    const el = $('#mailbox-status');
    if (!el) return;
    const d = await GET('/dashboard').catch(() => null);
    const sm = d?.integrations?.smtp; const im = d?.integrations?.imap;
    if (!sm) return;
    el.innerHTML = sm.mode === 'capture' ? badge('warn', 'Test mode — not sending')
      : sm.error ? badge('bad', 'Last send failed')
        : !sm.configured ? badge('warn', 'Password needed')
          : im?.lastSync ? badge('ok', `Connected · last read ${new Date(im.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) : badge('info', 'Password saved — click Test');
    if (sm.error && !$('#mailbox-res').textContent) mailRes(sm.error, true);
  }
  mailboxStatus();

}

// ---------------------------------------------------------------- integrations hub
const SRC_BADGE = (st, configured, enabled) => {
  if (!configured) return badge('', 'Not connected');
  if (!enabled) return badge('ok', 'Connected');
  const [cls, label] = STATE_BADGE[st?.status] || STATE_BADGE.idle;
  return `<span class="badge b-${cls} ${st?.status === 'running' ? 'live' : ''}">${esc(label)}</span>`;
};

function intCard({ id, mono, bg, title, tag = '', desc, status, body = '', actions = '', meta = '' }) {
  return `<div class="card int-card reveal" data-testid="int-${id}">
    <div class="int-head"><span class="mono-ic" style="background:${bg}">${mono}</span>
      <div class="grow"><h2>${title} ${tag ? `<span class="muted small-t" style="font-weight:500">${tag}</span>` : ''}</h2><div class="int-status">${status}</div></div></div>
    <p class="int-desc">${desc}</p>
    ${body}${actions ? `<div class="int-actions">${actions}</div>` : ''}${meta}</div>`;
}

function sourceMeta(st, { unit = 'leads added' } = {}) {
  if (!st) return '';
  const cr = st.credits;
  const bits = [];
  if (cr && cr.available) {
    const used = Math.min(cr.available, cr.used || 0);
    bits.push(`<div><div class="metric-row"><span>Credits this period</span><strong>${n(cr.left ?? cr.available - used)} of ${n(cr.available)} left</strong></div>
      <div class="bar ${cr.left <= 0 ? 'warn' : 'ok'}"><span style="width:${Math.max(2, ((cr.left ?? 0) / cr.available) * 100)}%"></span></div>${cr.resetAt ? `<span>Renews ${esc(String(cr.resetAt).slice(0, 10))}</span>` : ''}</div>`);
  }
  if (st.runs) bits.push(`<span><strong>${n(st.found)}</strong> found · <strong>${n(st.imported)}</strong> ${unit} · ${n(st.runs)} run${st.runs === 1 ? '' : 's'}${st.last_run_at ? ` · last ${fmtDate(st.last_run_at)}` : ''}</span>`);
  if (st.resume_at && ['waiting_credits', 'rate_limited', 'plan', 'error'].includes(st.status)) bits.push(`<span>Next automatic check: <strong>${fmtDate(st.resume_at)}</strong> UTC</span>`);
  const msg = st.message ? `<div class="int-msg ${['waiting_credits', 'rate_limited', 'error'].includes(st.status) ? 'warn' : ['auth', 'plan'].includes(st.status) ? 'bad' : ''}" data-testid="src-msg">${esc(st.message)}</div>` : '';
  return `${msg}${bits.length ? `<div class="int-meta">${bits.join('')}</div>` : ''}`;
}

async function renderIntegrations() {
  const [s, srcs, d, eng] = await Promise.all([GET('/settings'), GET('/sources'), GET('/dashboard'), GET('/engine').catch(() => null)]);
  const f = (key, label, opts = {}) => input(s, key, label, opts);
  const portOpts = (cur, opts) => (cur && !(String(cur) in opts) ? { ...opts, [cur]: String(cur) } : opts);
  const testBtn = (name, label, tid) => `<button type="button" class="itest" data-name="${name}" ${tid ? `data-testid="${tid}"` : ''}>${label}</button>`;
  const runBtn = (src, label, tid) => `<button type="button" class="src-run" data-src="${src}" data-testid="${tid}">${ic('play')}${label}</button>`;
  const checkBtn = (src, label, tid) => `<button type="button" class="src-check ghost" data-src="${src}" data-testid="${tid}">${ic('sync')}${label}</button>`;
  const st = (name) => srcs.find((x) => x.name === name) || {};
  const ints = d.integrations;
  const webhook = `${location.origin}/hooks/clay`;

  const mailbox = `<div class="card int-card reveal" data-testid="mailbox-card"><div class="int-head"><span class="mono-ic" style="background:linear-gradient(135deg,#8c6cff,#5a3fd6)">${ic('mail')}</span>
      <div class="grow"><h2>Hostinger mailbox</h2><div class="int-status"><span id="mailbox-status" data-testid="mailbox-status"></span></div></div></div>
      <p class="int-desc">Sends your emails and reads replies, bounces and your Sent folder. Same email and password as Hostinger webmail.</p>
      ${f('smtp_user', 'Mailbox email', { ph: s.sender_email || 'you@yourdomain.com' })}
      ${f('smtp_pass', 'Mailbox password', { type: 'password', ph: 'password of this mailbox (not your hPanel login)' })}
      <details><summary class="small-t">Server settings — already filled in for Hostinger</summary>
        <div class="grid g2 mt">${f('smtp_host', 'Sending server (SMTP)')}${f('smtp_port', 'SMTP port', { type: 'select', options: portOpts(s.smtp_port, { 465: '465 — SSL/TLS (recommended)', 587: '587 — STARTTLS' }) })}
        ${f('imap_host', 'Reading server (IMAP)')}${f('imap_port', 'IMAP port', { type: 'select', options: portOpts(s.imap_port, { 993: '993 — SSL/TLS' }) })}
        ${f('imap_user', 'Separate IMAP login (normally empty)')}${f('imap_pass', 'Separate IMAP password (normally empty)', { type: 'password' })}</div></details>
      <div class="int-actions mt">${testBtn('mailbox', `${ic('check')}Save &amp; test connection`, 'test-mailbox')}<button type="button" id="mail-test-email" data-testid="test-email">${ic('send')}Send a test email to myself</button></div>
      <p class="small-t mt" id="mailbox-res" data-testid="mailbox-res"></p></div>`;

  const groq = intCard({
    id: 'groq', mono: 'AI', bg: 'linear-gradient(135deg,#ff8a4c,#e2470f)', title: 'Groq AI', tag: 'free',
    desc: 'Writes one plain, human-sounding email per lead from facts on their website. Free tier, nothing to install.',
    status: ints.ai.configured ? badge('ok', 'Connected') : badge('warn', 'Not set up'),
    body: `${f('groq_api_key', 'API key (console.groq.com/keys)', { type: 'password' })}${f('groq_model', 'Model', { type: 'select', options: { 'openai/gpt-oss-120b': 'gpt-oss-120b — best writing', 'openai/gpt-oss-20b': 'gpt-oss-20b — faster, higher free limits', 'qwen/qwen3.8-27b': 'qwen3.8-27b' } })}`,
    actions: `${testBtn('ai', `${ic('check')}Save &amp; test`, 'test-groq')}<a class="btn ghost" href="https://console.groq.com/keys" target="_blank" rel="noopener">Get a free key ↗</a><a class="btn ghost" href="#/settings?tab=ai">Writing style →</a>`,
  });

  const osm = intCard({
    id: 'osm', mono: 'OS', bg: SOURCE_LOOK.osm.bg, title: 'OpenStreetMap', tag: 'built in · free',
    desc: 'Searches every business type × city you choose, around the clock, and adds businesses that have their own website.',
    status: eng?.enabled ? '<span class="badge b-ok live">Running 24/7</span>' : badge('warn', 'Paused'),
    meta: eng ? `<div class="int-meta"><div><div class="metric-row"><span>Searches done</span><strong>${n(eng.searched)} / ${n(eng.targets)}</strong></div><div class="bar"><span style="width:${eng.targets ? (eng.searched / eng.targets) * 100 : 0}%"></span></div></div><span><strong>${n(eng.imported)}</strong> businesses added</span></div>` : '',
    actions: `<a class="btn" href="#/engine">${ic('bolt')}Open lead engine</a>`,
  });

  const a = st('apollo');
  const apollo = intCard({
    id: 'apollo', mono: 'A', bg: SOURCE_LOOK.apollo.bg, title: 'Apollo', tag: 'lead source',
    desc: 'Finds companies and decision-makers by keyword × city. Uses only the people search (no credits, no emails). When Apollo says you are out of credits or over the limit, it waits and continues from the same page automatically.',
    status: SRC_BADGE(a, a.configured, a.enabled),
    body: `${f('apollo_api_key', 'API key (Apollo → Settings → Integrations → API)', { type: 'password' })}
      ${f('apollo_api_search_enabled', 'Allow API people search (never reveals emails, never spends export credits)', { type: 'checkbox' })}
      ${f('engine_apollo_enabled', 'Pull leads automatically (keywords are set in the Lead engine)', { type: 'checkbox' })}`,
    actions: `${testBtn('apollo', `${ic('check')}Save &amp; test`, 'test-apollo')}${checkBtn('apollo', 'Check now', 'apollo-check')}<a class="btn ghost" href="#/engine">Keywords →</a>`,
    meta: sourceMeta(a),
  });

  const h = st('hunter');
  const hunter = intCard({
    id: 'hunter', mono: 'Hu', bg: SOURCE_LOOK.hunter.bg, title: 'Hunter.io', tag: 'email finder',
    desc: 'For companies whose own website shows no email, finds the address they published elsewhere on the web — with the page it came from — and confirms it on their site when it can. Never guesses. Free plan: 25 searches a month; it pauses when they run out and resumes when they renew.',
    status: SRC_BADGE(h, h.configured, h.enabled),
    body: `${f('hunter_api_key', 'API key (hunter.io → API)', { type: 'password' })}
      <div class="grid g2">${f('source_hunter_enabled', 'Find emails automatically', { type: 'checkbox' })}${f('hunter_batch_per_run', 'Companies per run (every 30 min)', { type: 'number' })}</div>`,
    actions: `${testBtn('hunter', `${ic('check')}Save &amp; test`, 'test-hunter')}${runBtn('hunter', 'Find emails now', 'hunter-run')}${checkBtn('hunter', 'Check credits', 'hunter-check')}`,
    meta: sourceMeta(h, { unit: 'now ready to email' }),
  });

  const hs = st('hubspot');
  const hubspot = intCard({
    id: 'hubspot', mono: 'H', bg: SOURCE_LOOK.hubspot.bg, title: 'HubSpot', tag: 'CRM',
    desc: 'Imports the companies in your CRM as leads (read-only), skips anyone already contacted, and can sync statuses back after your approval.',
    status: SRC_BADGE(hs, hs.configured, hs.enabled),
    body: `${f('hubspot_token', 'Service key or private app token', { type: 'password' })}
      ${f('source_hubspot_import', 'Import my HubSpot companies as leads automatically', { type: 'checkbox' })}
      <details><summary class="small-t">Advanced</summary><div class="mt">${f('hubspot_base_url', 'API base URL')}${f('hubspot_contacted_stages', 'll_outreach_stage values that mean “already contacted”')}${f('hubspot_stage_map', 'Local status → ll_outreach_stage map (JSON)', { type: 'textarea' })}</div></details>`,
    actions: `${testBtn('hubspot', `${ic('check')}Save &amp; test`, 'test-hubspot')}${runBtn('hubspot', 'Import now', 'hubspot-run')}<a class="btn ghost" href="#/hubspot">CRM sync →</a>`,
    meta: sourceMeta(hs),
  });

  const clay = intCard({
    id: 'clay', mono: 'C', bg: SOURCE_LOOK.clay.bg, title: 'Clay', tag: 'and Zapier · Make · n8n',
    desc: 'Clay has no API to read from — it sends rows here instead. Easiest: export a CSV and drop it into the “leads csv” folder (imported within 10 minutes). Automatic: add an HTTP API column in Clay that POSTs each row to the webhook below. Clay pauses itself when its credits run out and continues when they renew.',
    status: ints.clay.configured ? badge('ok', 'Webhook ready') : badge('', 'CSV folder only'),
    body: `<div class="field"><label>Webhook URL (needs a public address — see Setup guide → Clay)</label><input readonly value="${esc(webhook)}" class="mono"></div>
      <div class="field"><label>Header</label><input readonly class="mono" value="x-clay-secret: ${ints.clay.configured ? '••••••••' : '(generate a secret)'}" id="clay-secret-view"></div>`,
    actions: `<button type="button" id="clay-gen" data-testid="clay-secret-gen">${ic('sparkle')}Generate new secret</button><a class="btn ghost" href="#/import?tab=folder">Leads folder →</a>`,
  });

  app.innerHTML = `${head('Integrations', 'Connect the tools you use: fill in the fields, click Save &amp; test, done. Paid sources pull leads while credits last, pause when they run out, and continue automatically when they renew.')}
    <form id="set-form">
      <div class="section-title">Sending &amp; writing</div>
      <div class="int-grid">${mailbox}${groq}</div>
      <div class="section-title">Lead sources</div>
      <div class="int-grid">${osm}${apollo}${hunter}${hubspot}${clay}</div>
      <div class="save-bar"><button class="primary" data-testid="save-settings">${ic('check')}Save settings</button></div>
    </form>`;
  $('#set-form').onsubmit = async (e) => {
    e.preventDefault();
    await act(e.submitter, () => PUT('/settings', formData(e.target)), 'Settings saved');
  };
  const saveForm = () => PUT('/settings', formData($('#set-form')));
  $$('.src-run').forEach((b) => { b.onclick = (e) => act(e.currentTarget, async () => { await saveForm(); return POST(`/sources/${b.dataset.src}/run`); }, (r) => r.summary || 'Done').then((r) => { if (r) route(); }); });
  $$('.src-check').forEach((b) => { b.onclick = (e) => act(e.currentTarget, async () => { await saveForm(); return POST(`/sources/${b.dataset.src}/check`); }, (r) => r.message || (STATE_BADGE[r.status] || [])[1] || 'Checked').then((r) => { if (r) route(); }); });
  $('#clay-gen').onclick = (e) => act(e.currentTarget, () => POST('/integrations/clay/secret'), 'New secret generated — copy it into Clay now').then((r) => { if (r) $('#clay-secret-view').value = `x-clay-secret: ${r.secret}`; });
  wireIntegrations();
}

// ---------------------------------------------------------------- security (2FA, password, people)
async function wireSecurity(params = {}) {
  const box = $('#sec-2fa'); if (!box) return;
  const st = await GET('/auth/status').catch(() => ({ enabled: false }));
  if (!st.enabled) { $('#sec-root').innerHTML = `<div class="card" style="grid-column:1/-1">${empty('Sign-in is turned off on this server', ' — set AUTH_ENABLED=1 (the default) to require accounts and 2FA.')}</div>`; return; }
  const { user, workspace } = await GET('/auth/me');
  const draw2fa = () => {
    $('#tfa-badge').innerHTML = user.twoFactor ? badge('ok', 'On') : badge('warn', 'Off');
    box.innerHTML = user.twoFactor
      ? `<p class="sub" style="margin:0 0 14px">Signing in needs your password <strong>and</strong> a code from your authenticator app.</p>
         <details><summary class="small-t">Turn off two-factor authentication</summary><div class="mt"><div class="grid g2"><div class="field"><label>Password</label><input type="password" id="tfa-off-pass" autocomplete="current-password"></div><div class="field"><label>Current code</label><input id="tfa-off-code" inputmode="numeric" maxlength="6"></div></div>
         <button type="button" class="danger" id="tfa-off" data-testid="2fa-disable">Turn off 2FA</button></div></details>`
      : `<p class="sub" style="margin:0 0 14px">Add a second step to signing in: a 6-digit code from Google Authenticator, 1Password, Authy or a similar app.</p>
         <button type="button" class="primary" id="tfa-start" data-testid="2fa-start">${ic('shield')}Turn on two-factor authentication</button>`;
    if ($('#tfa-start')) $('#tfa-start').onclick = (e) => act(e.currentTarget, () => POST('/auth/2fa/start')).then((r) => {
      if (!r) return;
      box.innerHTML = `<div class="qr-box"><div class="qr" data-testid="2fa-qr">${r.qrSvg}</div><div><ol class="steps"><li>Scan the QR code with your authenticator app.</li><li>Can't scan? Enter this key: <div class="secret mt" data-testid="2fa-secret">${esc(r.secret)}</div></li><li>Type the 6-digit code it shows:</li></ol>
        <div class="row"><input id="tfa-code" inputmode="numeric" maxlength="6" placeholder="123456" style="max-width:160px" data-testid="2fa-code"><button type="button" class="primary" id="tfa-verify" data-testid="2fa-verify">Verify &amp; turn on</button></div></div></div>`;
      $('#tfa-verify').onclick = (ev) => act(ev.currentTarget, () => POST('/auth/2fa/enable', { code: $('#tfa-code').value }), 'Two-factor authentication is on').then((res) => {
        if (!res) return;
        user.twoFactor = true;
        $('#tfa-badge').innerHTML = badge('ok', 'On');
        box.innerHTML = `<div class="alert sev-high">${ic('alert')}<div class="grow"><strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. They will not be shown again.</div></div>
          <div class="codes" data-testid="recovery-codes">${res.recoveryCodes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
          <div class="row"><button type="button" id="codes-copy">Copy codes</button><button type="button" class="primary" id="codes-done">I saved them</button></div>`;
        $('#codes-copy').onclick = () => navigator.clipboard?.writeText(res.recoveryCodes.join('\n')).then(() => toast('Copied'));
        $('#codes-done').onclick = draw2fa;
      });
    });
    if ($('#tfa-off')) $('#tfa-off').onclick = (e) => act(e.currentTarget, () => POST('/auth/2fa/disable', { password: $('#tfa-off-pass').value, code: $('#tfa-off-code').value }), 'Two-factor authentication is off').then((r) => { if (r) { user.twoFactor = false; draw2fa(); } });
  };
  draw2fa();
  $('#pw-save').onclick = (e) => act(e.currentTarget, () => POST('/auth/password', { current: $('#pw-cur').value, next: $('#pw-new').value }), 'Password changed').then((r) => { if (r) { $('#pw-cur').value = ''; $('#pw-new').value = ''; } });
  $('#sec-account').innerHTML = `<table class="plain"><tbody>
      <tr><td class="muted">Email</td><td class="num"><strong data-testid="account-email">${esc(user.email)}</strong></td></tr>
      <tr><td class="muted">Workspace</td><td class="num">${esc(workspace?.name || '—')} ${workspace?.primary ? badge('ok', 'existing data') : ''}</td></tr>
      <tr><td class="muted">Account created</td><td class="num">${fmtDate(user.createdAt)}</td></tr></tbody></table>
    <p class="small-t muted" style="margin:12px 0 0">Your leads, emails and settings are private to this account. Anyone who signs up with another email gets their own empty workspace.</p>`;
}

// ---------------------------------------------------------------- brand & greeting
/** Greeting in the top bar, and the signed-in user's menu. */
function loadBrand() {
  GET('/settings').then((st) => {
    const h = new Date().getHours();
    const first = String(st.sender_name || '').split(' ')[0];
    $('#greet').innerHTML = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}${first ? `, <strong>${esc(first)}</strong>` : ''} · ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`;
  }).catch(() => {});
  GET('/auth/status').then((st) => {
    if (!st.enabled || !st.user) return;
    const u = st.user;
    $('#user-menu').hidden = false;
    $('#user-btn').textContent = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
    $('#um-name').textContent = u.name || u.email; $('#um-email').textContent = u.email;
    $('#user-btn').onclick = (e) => { e.stopPropagation(); $('#user-pop').hidden = !$('#user-pop').hidden; };
    document.addEventListener('click', (e) => { if (!$('#user-menu').contains(e.target)) $('#user-pop').hidden = true; });
    $('#um-logout').onclick = () => POST('/auth/logout').finally(() => { location.href = '/login'; });
  }).catch(() => {});
}

/** Reload by itself when the app's files change (an open tab never keeps running an old version). */
async function watchVersion() {
  let v0 = null;
  try { v0 = (await GET('/version')).v; } catch { return; }
  setInterval(async () => {
    try {
      const { v } = await GET('/version');
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (v !== v0 && !typing && $('#modal').hidden) { toast('ProspectLoom was updated — reloading…'); setTimeout(() => location.reload(), 1200); v0 = v; }
    } catch { /* offline */ }
  }, 60_000);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  META = await GET('/meta');
  loadBrand();
  $('#theme-toggle').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.classList.add('theme-fade');
    document.documentElement.dataset.theme = next;
    setTimeout(() => document.documentElement.classList.remove('theme-fade'), 400);
    try { localStorage.setItem('pl-theme', next); } catch { /* private mode */ }
    hydrateCharts(app);
  };
  if (META.testMode) $('#mode-badge').innerHTML = '<span class="badge b-warn">TEST MODE — emails captured, not sent</span>';
  route();
  pollJobs();
  watchVersion();
})();
