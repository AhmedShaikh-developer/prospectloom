import { q } from '../db/index.js';
import { config } from '../config.js';

// Phase 1 + operational settings. Everything editable from the Settings page.
export const DEFAULT_SETTINGS = {
  // Phase 1: offers
  offer_a_name: 'Custom Software & Automation',
  offer_a_pitch: 'We build custom internal tools, dashboards, portals and API/CRM/ERP integrations that remove manual work.',
  offer_a_min_employees: '10',
  offer_a_max_employees: '200',
  offer_a_industries: 'logistics, professional services, recruiting, manufacturing, wholesale, e-commerce, distribution',
  offer_b_name: 'White-Label Development Partnership',
  offer_b_pitch: 'We act as a white-label engineering team for agencies: custom development, API integrations, backend and automation delivered under your brand.',
  offer_b_min_employees: '5',
  offer_b_max_employees: '50',
  offer_b_industries: 'marketing agencies, UX/UI agencies, Shopify/e-commerce agencies, Webflow/website agencies, branding studios, digital transformation firms',
  // Offer C: consumer-facing (B2C) local businesses — edit the pitch to match what you sell them.
  offer_c_name: 'Websites & Automation for Local Businesses',
  offer_c_pitch: 'We build fast websites, online booking/ordering and simple automations that save local businesses hours every week.',
  offer_c_industries: 'restaurants, cafés, clinics, dentists, salons, gyms, real estate, home services, retail shops, hotels',

  // Pipeline: 'simple' = automatic research, decision-maker optional; 'strict' = original manual-evidence rules.
  pipeline_mode: config.pipelineMode,
  // Autopilot: research → AI-written email → send, every day within the limits below. Off until you switch it on.
  autopilot_enabled: '0',
  send_timezone: 'America/New_York',
  // Also email addresses supplied by Clay/Apollo/your CSV files (domain must match; bounces are watched).
  allow_provider_emails: '0',
  // Pause automatic sending when more than 5% of the last 7 days' emails bounced (min. 20 sent).
  bounce_guard_enabled: '1',

  // Lead engine (24/7 lead finding)
  engine_enabled: '0',
  engine_categories: '',
  engine_locations: '',
  engine_searches_per_hour: '20',
  engine_rescan_days: '30',
  engine_daily_cap: '1500',
  engine_apollo_enabled: '0',
  engine_apollo_keywords: '',
  engine_apollo_titles: 'Founder, CEO, Owner, COO, Managing Director',
  // Drop CSV files into this folder (inside the app folder) and they are imported automatically.
  watch_leads_folder: '1',
  leads_folder: 'leads csv',

  // Sender identity + commercial-email compliance (CAN-SPAM)
  sender_name: '',
  sender_title: '',
  sender_company: '',
  sender_email: '',
  sender_postal_address: '',
  sender_website: '',
  unsubscribe_text: "If this isn't relevant, just reply \"unsubscribe\" and I won't contact you again.",

  // Phase 8/9: volume and schedule
  daily_send_limit: '10',
  send_window_start: '9',     // hour, local time of the server
  send_window_end: '16',
  send_days: '1,2,3,4,5',     // Mon-Fri
  min_minutes_between_sends: '6',   // random gap between emails: from…
  max_minutes_between_sends: '14',  // …to (minutes)
  send_rounds: '2',                 // split each day's emails into rounds (10 → 5 + 5)
  // Warm-up: start at daily_send_limit, hold for N days, then grow step-by-step up to the maximum.
  warmup_enabled: '1',
  warmup_hold_days: '14',
  warmup_step: '5',
  warmup_every_days: '7',
  warmup_max: '40',
  warmup_start_date: '',
  auto_send_enabled: '0',     // only ever sends APPROVED messages
  auto_draft_enabled: '0',    // generate the day's drafts automatically each morning
  followup_enabled: '1',
  followup_after_days: '4',
  max_followups: '1',
  reserve_target_days: '30',

  // Phase 2/11: research automation
  research_auto_enabled: '0',
  research_interval_minutes: '60',
  research_batch_size: '50',
  research_rescreen_hours: '24',
  imap_sync_minutes: '10',
  email_recheck_days: '90',
  dedup_recheck_days: '30',
  qualified_target: '5000',

  // Phase 7: map local statuses to the values of HubSpot's ll_outreach_stage.
  hubspot_stage_map: JSON.stringify({
    RESEARCHING: 'HOLD', HOLD_VERIFY: 'HOLD', MANUAL_APPLICATION: 'HOLD', READY: 'READY', SENT: 'SENT',
    FOLLOW_UP: 'FOLLOW_UP', REPLIED: 'REPLIED', BOUNCED: 'BOUNCED', DO_NOT_CONTACT: 'DO_NOT_CONTACT', EXCLUDED: 'DO_NOT_CONTACT',
  }),
  hubspot_contacted_stages: 'SENT,FOLLOW_UP,REPLIED,BOUNCED,DO_NOT_CONTACT',
  apollo_api_search_enabled: '0',

  // AI email writing via Groq (free tier). Used whenever a Groq API key is set.
  ai_writing: '1',
  groq_model: 'openai/gpt-oss-120b',
  writing_style_example: '',   // optional: an email you wrote yourself; the AI copies its tone, never its content
  autopilot_review: '0',       // 1 = autopilot writes, you approve each email before it can be sent

  // Templates (Phase 9). Variables: {{first_name}} {{company}} {{personalization}} {{offer_pitch}} {{sender_name}} ...
  template_a_subject: 'idea for {{company}}',
  template_a_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}}. {{offer_pitch}} {{angle}}

Is this something you ever need a hand with?

{{sender_name}}`,
  template_b_subject: 'extra dev help for {{company}}',
  template_b_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}}. {{offer_pitch}} {{angle}}

Do you ever need extra hands on the technical side of client projects?

{{sender_name}}`,
  template_c_subject: '{{company}} website',
  template_c_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}}. {{offer_pitch}} {{angle}}

Would it help if I sent over a couple of ideas?

{{sender_name}}`,
  template_followup_body: `Hi {{first_name}},

Just bumping this up in case it got buried. If the timing's off, no problem at all.

{{sender_name}}`,
};

// Integration credentials (stored locally; masked when read by the UI).
export const SECRET_KEYS = ['hubspot_token', 'apollo_api_key', 'clay_webhook_secret', 'smtp_pass', 'imap_pass', 'groq_api_key'];
export const INTEGRATION_KEYS = [
  'hubspot_token', 'hubspot_base_url', 'apollo_api_key', 'apollo_base_url', 'clay_webhook_secret',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'imap_host', 'imap_port', 'imap_user', 'imap_pass',
  'mail_transport', 'dns_mode', 'groq_api_key', 'groq_base_url', 'osm_nominatim_url', 'osm_overpass_url',
];

export function getSetting(key) {
  const row = q.get('SELECT value FROM settings WHERE key = :key', { key });
  if (row && row.value !== null && row.value !== '') return row.value;
  if (key in DEFAULT_SETTINGS) return DEFAULT_SETTINGS[key];
  if (key in config.defaults) return config.defaults[key];
  return '';
}

export function getNum(key) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : 0;
}

export function getBool(key) {
  return ['1', 'true', 'yes', 'on'].includes(String(getSetting(key)).toLowerCase());
}

export function setSetting(key, value) {
  q.run(
    'INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    { key, value: value == null ? '' : String(value) },
  );
}

export function getAllSettings({ maskSecrets = true } = {}) {
  const out = {};
  for (const key of [...Object.keys(DEFAULT_SETTINGS), ...INTEGRATION_KEYS]) {
    const v = getSetting(key);
    out[key] = maskSecrets && SECRET_KEYS.includes(key) ? (v ? '••••••••' + String(v).slice(-4) : '') : v;
  }
  return out;
}

export function saveSettings(obj) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (!(key in DEFAULT_SETTINGS) && !INTEGRATION_KEYS.includes(key)) continue;
    // Ignore masked placeholders echoed back from the UI.
    if (SECRET_KEYS.includes(key) && typeof value === 'string' && value.startsWith('••••')) continue;
    setSetting(key, value);
  }
}

export function getStageMap() {
  try { return JSON.parse(getSetting('hubspot_stage_map')); } catch { return {}; }
}

// Templates saved unchanged from an older default are upgraded to the current default on start.
const OLD_TEMPLATE_DEFAULTS = {
  template_a_subject: 'Quick idea for {{company}}',
  template_a_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}} — {{offer_pitch}} {{angle}}

Would a 20-minute call to see if there's a fit be useful?

Best,
{{sender_name}}`,
  template_b_subject: 'White-label dev capacity for {{company}}',
  template_b_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}}. {{offer_pitch}} {{angle}}

Open to a short call to see whether we'd be a useful overflow partner?

Best,
{{sender_name}}`,
  template_c_subject: 'Quick idea for {{company}}',
  template_c_body: `Hi {{first_name}},

{{personalization}}

I run {{sender_company}} — {{offer_pitch}} {{angle}}

Would it be worth a quick 15-minute call?

Best,
{{sender_name}}`,
  template_followup_body: `Hi {{first_name}},

Just floating this back up in case it got buried. Happy to share a couple of relevant examples if useful — or if the timing's wrong, no worries at all.

Best,
{{sender_name}}`,
};
export function upgradeDefaultTemplates() {
  for (const [key, old] of Object.entries(OLD_TEMPLATE_DEFAULTS)) {
    const row = q.get('SELECT value FROM settings WHERE key = :key', { key });
    if (row && row.value === old) setSetting(key, DEFAULT_SETTINGS[key]);
  }
}
