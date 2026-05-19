-- Recovery script for the partially-applied step 5 migration.
--
-- Symptom: running 2026-05-19-summaries-rename.sql failed with
--   "error in index idx_summaries_user after drop column: no such column: user_id"
-- because indexes were dropped after the column drop instead of before.
--
-- Expected state going in: table `anon_summaries` exists (rename committed),
-- still has `user_id` column, and the old `idx_summaries_user` and/or
-- `idx_summaries_anon` indexes still exist on it.
--
-- Run once:  npm run db:migrate:step5:fixup:remote

DROP INDEX IF EXISTS idx_summaries_user;
DROP INDEX IF EXISTS idx_summaries_anon;

ALTER TABLE anon_summaries DROP COLUMN user_id;

CREATE INDEX IF NOT EXISTS idx_anon_summaries_anon
  ON anon_summaries (anon_id, created_at DESC);
