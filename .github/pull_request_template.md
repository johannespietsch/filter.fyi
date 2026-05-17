## Summary

<!-- 1–3 bullets on what changed and why. -->

## Test plan

<!-- Markdown checklist of what was exercised. -->

## Pre-merge checklist

- [ ] If `schema.sql` changed: ran `npm run db:init:remote` after this PR is ready to ship (idempotent — every statement is `IF NOT EXISTS`). The Worker auto-deploys on merge but D1 schema does not.
- [ ] If new Worker secrets are referenced (e.g. `env.NEW_VAR`): set them with `npx wrangler secret put NEW_VAR` after the first deploy that introduces the reference.
