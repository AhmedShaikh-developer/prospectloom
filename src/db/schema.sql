PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Phase 3/4/6: one row per unique company (normalized domain).
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  website TEXT,
  offer TEXT,                    -- 'A' custom software/automation, 'B' white-label partnership
  lead_origin TEXT,              -- manual, csv, clay, apollo, hubspot, website
  status TEXT NOT NULL DEFAULT 'RESEARCHING',
  status_reason TEXT,
  status_locked INTEGER NOT NULL DEFAULT 0,  -- 1 = human-set terminal status (e.g. DO_NOT_CONTACT)

  -- Phase 3 research facts (each material claim carries a source URL)
  us_presence TEXT, us_presence_url TEXT,
  industry TEXT, services TEXT, description TEXT, profile_url TEXT,
  employee_count INTEGER, employee_count_url TEXT, employee_count_date TEXT,
  dm_name TEXT, dm_title TEXT, dm_url TEXT, dm_verified INTEGER NOT NULL DEFAULT 0,
  portfolio_url TEXT, portfolio_note TEXT,
  personalization TEXT, personalization_url TEXT,
  fit_score INTEGER, fit_rationale TEXT,

  -- Phase 4 contact channel
  contact_email TEXT, email_source_url TEXT, email_evidence_type TEXT,
  email_contact_type TEXT, email_purpose TEXT, email_checked_at TEXT,
  email_source_confirmed INTEGER,      -- 1 found on source page, 0 not found, NULL unchecked
  email_manual_confirmed INTEGER NOT NULL DEFAULT 0,
  email_auto_selected INTEGER NOT NULL DEFAULT 0,
  mx_valid INTEGER, mx_checked_at TEXT,
  manual_application_url TEXT,
  scan_emails TEXT,                    -- JSON list of emails found on official site
  scan_facts TEXT,                     -- JSON: headings, case studies, tech, hiring, phones (each with URL)
  mail_auth TEXT,                      -- JSON: MX/SPF/DMARC/DKIM of the lead's domain
  scan_at TEXT,

  -- Phase 5 dedup / suppression
  dedup_checked_at TEXT, dedup_conflicts TEXT,   -- JSON list

  -- Phase 7 HubSpot
  hubspot_id TEXT, hubspot_stage TEXT, hubspot_checked_at TEXT,

  -- Lifecycle / progress markers
  research_started_at TEXT, research_completed_at TEXT, ready_at TEXT,
  last_screened_at TEXT, screen_count INTEGER NOT NULL DEFAULT 0, last_progress_at TEXT,
  last_sent_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_email ON companies(contact_email);

-- Phase 5: suppression list (opt-outs, bounces, complaints, exclusions).
CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,          -- 'email' | 'domain'
  value TEXT NOT NULL,
  reason TEXT NOT NULL,        -- opt_out, bounce, complaint, do_not_contact, competitor, previously_contacted, other
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, value, reason)
);

-- Phase 5/10: mail seen in the Hostinger mailbox (Sent + Inbox), for dedup and history.
CREATE TABLE IF NOT EXISTS mail_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,     -- 'out' | 'in'
  folder TEXT,
  uid INTEGER,
  message_id TEXT,
  email TEXT,
  domain TEXT,
  subject TEXT,
  date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(folder, uid, email)
);
CREATE INDEX IF NOT EXISTS idx_mail_history_domain ON mail_history(domain);

-- Phase 9: outreach messages (drafts -> approved -> sent).
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'intro',  -- intro | follow_up
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, approved, sent, blocked, failed, cancelled, bounced
  status_reason TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  unsubscribe_token TEXT,
  approved_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Phase 10: inbound replies.
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  message_ref INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  from_email TEXT,
  subject TEXT,
  snippet TEXT,
  classification TEXT,          -- positive, negative, neutral, opt_out, bounce, auto_reply
  handled INTEGER NOT NULL DEFAULT 0,
  message_id TEXT UNIQUE,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 10: local sales pipeline (never auto-pushed as HubSpot deals).
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'qualified_conversation',
  value REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 7: auditable HubSpot write queue.
CREATE TABLE IF NOT EXISTS hubspot_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,      -- create | update
  hubspot_id TEXT,
  payload TEXT NOT NULL,        -- JSON of properties to write
  before TEXT,                  -- JSON of current HubSpot values
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed, approved, confirmed, failed, blocked, discarded
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT
);

-- Phase 11: execution reports.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- research, import, imap, send, hubspot, daily_summary
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,                  -- ok, partial, error
  stats TEXT,                   -- JSON
  report TEXT
);

-- Audit trail of every change.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  actor TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity(company_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Background jobs (searches, imports, research, autopilot) with progress the UI can poll.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT,
  params TEXT,
  status TEXT NOT NULL DEFAULT 'running',   -- running | done | failed | interrupted
  done INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  message TEXT,
  result TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs(kind, id);

-- Lead engine: one row per (source, business type/keyword, location) search target.
CREATE TABLE IF NOT EXISTS engine_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'osm',        -- osm | apollo
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | done | error
  cursor INTEGER DEFAULT 1,
  runs INTEGER DEFAULT 0,
  found INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  error TEXT,
  UNIQUE(source, category, location)
);
CREATE TABLE IF NOT EXISTS geo_cache (location TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT);
-- CSV files imported from the watched "leads csv" folder.
CREATE TABLE IF NOT EXISTS import_files (path TEXT PRIMARY KEY, size INTEGER, mtime TEXT, imported_at TEXT, stats TEXT);

-- Automatic lead sources (Apollo, Hunter, HubSpot import): credit-aware state per source.
CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',   -- idle | ready | running | waiting_credits | rate_limited | plan | auth | error | done
  message TEXT,
  resume_at TEXT,                        -- do not call the provider before this time
  credits TEXT,                          -- JSON: { used, available, left, resetAt, plan }
  cursor TEXT,
  runs INTEGER DEFAULT 0,
  found INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  last_run_at TEXT,
  last_ok_at TEXT,
  updated_at TEXT
);
