CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  challenges TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist (created_at);

-- Per-URL summary rows produced by /api/try. Phase 1 stores anonymous rows
-- only (anon_id set, user_id null); Phase 2 will introduce users + claim flow.
-- user_id is left without a FK constraint in Phase 1 — the users table arrives
-- in Phase 2. We control all writes, so loss of the FK check is acceptable;
-- adding it back later would require rebuilding the table in D1.
CREATE TABLE IF NOT EXISTS summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  anon_id      TEXT,
  url          TEXT NOT NULL,
  source_type  TEXT,
  title        TEXT,
  verdict      TEXT,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_user ON summaries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_anon ON summaries (anon_id, created_at DESC);

-- Daily counter per rate-limit key. Key shape:
--   "anon:<uuid>" | "ip:<addr>" | "user:<id>" | "login:<email>" | "login-ip:<addr>"
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

-- Magic-link auth. No passwords.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Single-use email login tokens. used_at flips on first redemption; rows linger
-- until the opportunistic sweep in /api/try clears expired ones.
CREATE TABLE IF NOT EXISTS login_tokens (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens (expires_at);

-- Browser sessions. id is what's stored in the HttpOnly fyi_session cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
