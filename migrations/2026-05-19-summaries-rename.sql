-- One-time migration for step 5 of the unified-identity refactor:
-- rename `summaries` → `anon_summaries`, drop the now-unused `user_id`
-- column, and replace its indexes.
--
-- Run once on a fresh database:  npm run db:migrate:step5:remote
-- (If a previous attempt of this migration partially ran, use the fixup
--  script in 2026-05-19-summaries-rename-fixup.sql instead.)
--
-- Order matters: SQLite refuses DROP COLUMN if an existing index still
-- references that column. So: rename, drop the offending indexes first,
-- then drop the column, then create the new index.

ALTER TABLE summaries RENAME TO anon_summaries;

DROP INDEX IF EXISTS idx_summaries_user;
DROP INDEX IF EXISTS idx_summaries_anon;

ALTER TABLE anon_summaries DROP COLUMN user_id;

CREATE INDEX IF NOT EXISTS idx_anon_summaries_anon
  ON anon_summaries (anon_id, created_at DESC);
