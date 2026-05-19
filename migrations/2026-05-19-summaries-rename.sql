-- One-time migration for step 5 of the unified-identity refactor:
-- rename `summaries` → `anon_summaries`, drop the now-unused `user_id`
-- column, and replace its indexes. Idempotent enough that re-running
-- after success is a no-op (DROP IF EXISTS + CREATE IF NOT EXISTS).
--
-- Run once:  npm run db:migrate:step5

ALTER TABLE summaries RENAME TO anon_summaries;
ALTER TABLE anon_summaries DROP COLUMN user_id;
DROP INDEX IF EXISTS idx_summaries_anon;
DROP INDEX IF EXISTS idx_summaries_user;
CREATE INDEX IF NOT EXISTS idx_anon_summaries_anon
  ON anon_summaries (anon_id, created_at DESC);
