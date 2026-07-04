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

-- One-time migration of an existing `summaries` table (run after merging
-- this PR; CREATE-IF-NOT-EXISTS above won't touch a table that still
-- exists under the old name). The DDL lives in
-- migrations/2026-05-19-summaries-rename.sql and is wrapped by:
--   npm run db:migrate:step5:remote   (or :local for dev)

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

-- Suggestion interaction events — the interest signal for tuning suggestion
-- quality (shown / open / copy / open_chatgpt / open_claude / dismiss[+reason]).
-- Not user-facing. Written from the anonymous landing page, so keyed by anon_id
-- (the same UUID used for anon_summaries); user_id is set when signed in.
-- `event` is the interaction; `suggestion_index` is its position (0-based) in
-- the result. (`suggestion_kind` predates the 0–5 migration; kept nullable.)
CREATE TABLE IF NOT EXISTS suggestion_feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_id          TEXT,
  user_id          INTEGER,
  url              TEXT,
  event            TEXT,
  suggestion_index INTEGER,
  suggestion_kind  TEXT,
  suggestion_text  TEXT,
  reason           TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_event ON suggestion_feedback (event, created_at DESC);

-- Public share pages (/s/:slug) — explicit, user-initiated snapshots of one
-- analysed read. Created only from server-verified data (anon_summaries or the
-- backend library), never from client-supplied content. `payload` is the slim
-- summary JSON (full `content` brief stripped, same as anon_summaries).
CREATE TABLE IF NOT EXISTS shares (
  slug        TEXT PRIMARY KEY,
  user_id     INTEGER,
  anon_id     TEXT,
  url         TEXT NOT NULL DEFAULT '',
  source_type TEXT,
  title       TEXT,
  verdict     TEXT,
  payload     TEXT NOT NULL,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_created ON shares (created_at DESC);
