-- Public share pages (/s/:slug). A share is an explicit, user-initiated
-- snapshot of one analysed read — created only from server-verified data
-- (anon_summaries for anonymous visitors, the backend library for signed-in
-- users), never from client-supplied content, so filter.fyi can't be used to
-- host arbitrary text under our domain.
--
-- Run with:
--   npm run db:migrate:shares:local    (or :remote)
CREATE TABLE IF NOT EXISTS shares (
  slug        TEXT PRIMARY KEY,          -- 12 hex chars, crypto-random
  user_id     INTEGER,                   -- backend users.id when shared signed-in
  anon_id     TEXT,                      -- fyi_anon UUID when shared anonymously
  url         TEXT NOT NULL DEFAULT '',  -- the analysed source URL ('' for pasted text)
  source_type TEXT,
  title       TEXT,
  verdict     TEXT,
  payload     TEXT NOT NULL,             -- slim summary JSON (no full `content` brief)
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_created ON shares (created_at DESC);
