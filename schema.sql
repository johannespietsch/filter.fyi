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

-- Daily counter per rate-limit key. Key shape: "anon:<uuid>" | "ip:<addr>" | "user:<id>".
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
