CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  challenges TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist (created_at);

-- Per-URL summary rows produced by anonymous /api/try. Signed-in tries go
-- straight to the backend's items table (Fly SQLite) and never land here.
-- Rows are claimed on magic-link verify via cross-DB POST to /api/claim and
-- deleted afterward; anything left is unclaimed anonymous history.
CREATE TABLE IF NOT EXISTS anon_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_id      TEXT,
  url          TEXT NOT NULL,
  source_type  TEXT,
  title        TEXT,
  verdict      TEXT,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anon_summaries_anon ON anon_summaries (anon_id, created_at DESC);

-- One-time migration of an existing `summaries` table (run manually after
-- merging this PR; CREATE-IF-NOT-EXISTS above won't touch a table that
-- still exists under the old name):
--   ALTER TABLE summaries RENAME TO anon_summaries;
--   ALTER TABLE anon_summaries DROP COLUMN user_id;
--   DROP INDEX IF EXISTS idx_summaries_anon;
--   DROP INDEX IF EXISTS idx_summaries_user;
--   CREATE INDEX IF NOT EXISTS idx_anon_summaries_anon
--     ON anon_summaries (anon_id, created_at DESC);

-- Daily counter per rate-limit key. Key shape:
--   "anon:<uuid>" | "ip:<addr>" | "user:<id>" | "login:<email>" | "login-ip:<addr>"
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

-- DEPRECATED post unified-identity refactor: the canonical users table now
-- lives on the backend (filter.fyi-backend `users` on Fly SQLite). Magic-link
-- verify no longer writes here; `sessions.user_id` refers to backend users.id.
-- Old rows from before the refactor are orphaned. Safe to drop once we're
-- confident no rollback is needed.
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
-- Post unified-identity refactor: user_id refers to the BACKEND users.id (Fly
-- SQLite), NOT this file's `users` table. The Worker calls the backend's
-- /api/users/upsert during verify and stores the returned id here.
-- `email` is denormalised so loadSession doesn't have to JOIN against the
-- (deprecated) D1 users table — it's known at verify time.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- Existing prod sessions table predates the `email` column. After this PR
-- ships, run once against the live DB:
--   ALTER TABLE sessions ADD COLUMN email TEXT NOT NULL DEFAULT '';
-- (npm run db:init:remote will only CREATE-IF-NOT-EXISTS; it won't add the
-- column to an existing table.)

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
