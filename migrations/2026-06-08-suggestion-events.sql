-- Adds interaction-event columns to suggestion_feedback (shown/open/copy/
-- open_chatgpt/open_claude/dismiss). schema.sql carries the canonical shape for
-- fresh DBs; this migrates the live DB without re-running the whole schema:
--   npm run db:migrate:suggestion-events:remote   (or :local for dev)
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so these error harmlessly if already
-- applied — run once. (D1 runs each statement independently.)

ALTER TABLE suggestion_feedback ADD COLUMN event TEXT;
ALTER TABLE suggestion_feedback ADD COLUMN suggestion_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_event ON suggestion_feedback (event, created_at DESC);
