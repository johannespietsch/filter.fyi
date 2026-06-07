-- Adds the suggestion_feedback table (dismissed "try this" suggestions + reason).
-- schema.sql carries the canonical CREATE IF NOT EXISTS; this file exists so the
-- table can be applied to the live DB without re-running the whole schema:
--   npm run db:migrate:suggestion-feedback:remote   (or :local for dev)

CREATE TABLE IF NOT EXISTS suggestion_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_id         TEXT,
  user_id         INTEGER,
  url             TEXT,
  suggestion_kind TEXT,
  suggestion_text TEXT,
  reason          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback (created_at DESC);
