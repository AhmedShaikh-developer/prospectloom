// Phase 6 statuses.
export const STATUS = {
  RESEARCHING: 'RESEARCHING',
  HOLD_VERIFY: 'HOLD_VERIFY',
  READY: 'READY',
  SENT: 'SENT',
  FOLLOW_UP: 'FOLLOW_UP',
  REPLIED: 'REPLIED',
  BOUNCED: 'BOUNCED',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
  MANUAL_APPLICATION: 'MANUAL_APPLICATION',
  EXCLUDED: 'EXCLUDED',
};

export const STATUS_LABELS = {
  RESEARCHING: 'Researching',
  HOLD_VERIFY: 'Hold — Verify',
  READY: 'Ready',
  SENT: 'Sent',
  FOLLOW_UP: 'Follow-up',
  REPLIED: 'Replied',
  BOUNCED: 'Bounced',
  DO_NOT_CONTACT: 'Do not contact',
  MANUAL_APPLICATION: 'Manual application',
  EXCLUDED: 'Excluded',
};

// Statuses that mean the company has already been contacted. The decision engine
// never moves a company out of these back to READY.
export const CONTACTED_STATUSES = new Set(['SENT', 'FOLLOW_UP', 'REPLIED', 'BOUNCED']);
export const TERMINAL_STATUSES = new Set(['DO_NOT_CONTACT']);

// Phase 4: evidence classifications.
export const EVIDENCE_TYPES = {
  official_website: 'Published on official company website',
  partner_directory: 'Reputable public partner directory',
  partnership_channel: 'Identified partnership / vendor channel',
  public_work_email: 'Publicly identified work email of decision-maker',
  apollo_database: 'Apollo database (not public-source confirmed)',
  clay_enrichment: 'Clay enrichment (not public-source confirmed)',
  imported_list: 'Imported list / CSV (not public-source confirmed)',
  hubspot_existing: 'Existing HubSpot value (re-verify)',
  pattern_guess: 'Guessed pattern (NOT allowed)',
};
export const ACCEPTED_EVIDENCE = new Set(['official_website', 'partner_directory', 'partnership_channel', 'public_work_email']);
// Emails from data providers / your own lists. Usable only when Settings → allow_provider_emails is on.
export const PROVIDER_EVIDENCE = new Set(['apollo_database', 'clay_enrichment', 'imported_list']);

export const CONTACT_TYPES = {
  general: 'General business inbox',
  partnership: 'Partnership / vendor inbox',
  decision_maker: 'Decision-maker work email',
};

// Local-part rules for unsolicited vendor pitches.
export const BLOCKED_LOCAL_PARTS = [
  'support', 'help', 'helpdesk', 'privacy', 'abuse', 'billing', 'invoice', 'invoices', 'accounts',
  'accounting', 'payables', 'ap', 'ar', 'legal', 'dmca', 'compliance', 'noreply', 'no-reply',
  'donotreply', 'careers', 'jobs', 'hr', 'recruiting', 'security', 'webmaster', 'postmaster',
  'hostmaster', 'unsubscribe', 'orders', 'returns', 'customerservice', 'customercare', 'service',
  'tickets', 'admin', 'root', 'mailer-daemon', 'press', 'media', 'investor', 'investors', 'ir',
  'gdpr', 'dpo',
];
// Allowed but flagged: usually for the company's own customers.
export const WARN_LOCAL_PARTS = ['sales', 'orders', 'quotes', 'estimates', 'shop', 'store'];
// Preferred inboxes when auto-selecting from a website scan.
export const PREFERRED_LOCAL_PARTS = ['partnerships', 'partners', 'partner', 'vendors', 'hello', 'info', 'contact', 'inquiries', 'enquiries', 'team', 'office', 'studio', 'newbusiness', 'business'];

export const SUPPRESSION_REASONS = {
  opt_out: 'Opt-out / unsubscribe',
  bounce: 'Bounce',
  complaint: 'Complaint',
  do_not_contact: 'Do not contact',
  competitor: 'Competitor',
  previously_contacted: 'Previously contacted',
  other: 'Other exclusion',
};
// These can never be removed through the UI.
export const PERMANENT_SUPPRESSIONS = new Set(['opt_out', 'complaint']);

export const PIPELINE_STAGES = [
  ['qualified_conversation', 'Qualified conversation'],
  ['qualification_call', 'Free qualification call'],
  ['paid_discovery', 'Paid discovery / planning'],
  ['proposal', 'Project proposal'],
  ['development', 'Development engagement'],
  ['retainer', 'Maintenance / retainer'],
  ['won', 'Won'],
  ['lost', 'Lost'],
];

export const HUBSPOT_PROPERTIES = [
  'll_outreach_stage', 'll_public_contact_email', 'll_email_source_url', 'll_email_evidence_type',
  'll_last_verified_date', 'll_suppression_reason', 'll_last_sent_date',
];
