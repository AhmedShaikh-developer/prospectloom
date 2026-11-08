PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Workspaces: each one is a separate SQLite file holding one account's leads, emails and settings.
-- db_path '@primary' is the original database (the first owner's data).
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  db_path TEXT NOT NULL UNIQUE,
  owner_user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id),
  role TEXT NOT NULL DEFAULT 'owner',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT,                     -- JSON array of SHA-256 hashes (one-time)
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,                -- SHA-256 of the cookie token (the token itself is never stored)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
