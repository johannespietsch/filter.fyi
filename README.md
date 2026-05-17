# filter.fyi

Landing page and waitlist backend for [filter.fyi](https://filter.fyi) — a weekly signal digest for developers keeping up with AI.

## Stack

- **Landing page** — static HTML/CSS/JS in `public/`, no build step
- **Cloudflare Worker** (`src/worker.ts`) — serves the `/api/waitlist` endpoint, falls through to static assets for everything else
- **Cloudflare D1** — stores waitlist signups
- **Resend** — sends the signup confirmation + a new-signup notification
- Auto-deploys via Cloudflare's GitHub integration

## Structure

```
public/index.html   landing page (served at /)
src/worker.ts       waitlist API + static asset fallthrough
schema.sql          D1 table definition
wrangler.jsonc      Cloudflare project, bindings, and vars
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the values
npm run db:init:local            # apply schema to the local D1
npm run dev
```

`wrangler dev` uses a local D1 database by default — dev queries never touch production data.

### Local mock backend (`research-companion`)

The URL→analysis logic lives in a sibling repo (`filter.fyi-backend`, deployed to Fly.io in prod). For frontend/Worker development you don't need the real backend running — `dev/mock-bot.mjs` is a zero-dep Node script that speaks the agreed `/api/try` contract.

```bash
npm run mock-bot          # in a second terminal, listens on :8788
npm run dev               # main worker on :8787
```

Defaults in `.dev.vars.example` point `BOT_API_URL` at the mock. Trigger edge cases by adding a query flag to the submitted URL:

| URL contains | Mock response |
|---|---|
| `?mock=no-transcript` *or* path `/no-transcript` | `422 {error:"no-transcript"}` — Worker maps to a friendly 415 |
| `?mock=500` | `500 {error:"bot-error"}` |
| `?mock=slow` | 3s delay then success |
| `?mock=invalid` | `400 {error:"invalid-url"}` |
| anything else | `200` with a sample analysis; `source_type` inferred from the URL (article / youtube / social / pdf) |

Smoke-test the mock directly:

```bash
curl -sX POST http://localhost:8788/api/try \
  -H 'content-type: application/json' \
  -H 'x-filter-fyi-secret: local-dev-secret' \
  -d '{"url":"https://example.com/post"}' | jq
```

## Database

The `waitlist` table:

| column      | notes                                   |
|-------------|-----------------------------------------|
| id          | autoincrement primary key               |
| email       | unique — re-signups upsert in place     |
| challenges  | JSON array of survey answers            |
| source      | `hero` or `final-cta`                   |
| created_at  | ISO timestamp (set on insert only)      |

Local and remote D1 are separate stores — apply the schema to both:

```bash
npm run db:init:local    # for `npm run dev`
npm run db:init:remote   # for deployed environments
```

> **Heads up:** the Worker auto-deploys on merge to `main`, but D1 schema does not. Any PR that edits `schema.sql` needs `npm run db:init:remote` after the merge or the new tables/columns won't exist in prod — the Worker will throw `storage-error` 500s on any code path that touches them. The script is idempotent (`IF NOT EXISTS` everywhere), so re-running it is always safe.

Inspect signups:

```bash
npm run db:list:local
npm run db:list:remote
```

## Email

Confirmation and notification emails are sent via Resend. Sending originates from the `mail.filter.fyi` subdomain, so transactional volume never touches the root domain's reputation.

Config:

- `FROM_EMAIL` — `wrangler.jsonc` (`vars`): `filter.fyi <hello@mail.filter.fyi>`
- `REPLY_TO_EMAIL` — `wrangler.jsonc` (`vars`): `hello@filter.fyi` — a human address replies route to
- `RESEND_API_KEY` — secret: `npx wrangler secret put RESEND_API_KEY`
- `NOTIFY_EMAIL` — secret: `npx wrangler secret put NOTIFY_EMAIL` (where new-signup pings go)

For local dev, put `RESEND_API_KEY` and `NOTIFY_EMAIL` in `.dev.vars`.

If `RESEND_API_KEY` is unset, signups still succeed — email sending is skipped gracefully. Only brand-new signups trigger emails; re-submissions just update the row.

### DNS & deliverability

All records live in the `filter.fyi` Cloudflare zone:

- **Resend** (outbound, `mail.filter.fyi`) — SPF + DKIM + a return-path MX on `send.mail`
- **Cloudflare Email Routing** (inbound) — `hello@filter.fyi` forwards to a real inbox; this is what makes `REPLY_TO_EMAIL` deliverable
- **DMARC** — `_dmarc` TXT, currently `p=none` (monitor-only); reports aggregate to Cloudflare's DMARC dashboard. **Follow-up: tighten to `p=quarantine`, then `p=reject`,** once the dashboard confirms legit mail is passing alignment.

## Deployment

Pushes to `main` auto-deploy via Cloudflare's GitHub integration. Feature branches and PRs get preview URLs — keep `main` shippable and do non-trivial work on a branch.

Secrets set on the production Worker via `wrangler secret put` (only works *after* the Worker has been deployed at least once):

| Secret           | What it's for                                                 |
|------------------|---------------------------------------------------------------|
| `RESEND_API_KEY` | Outbound email (waitlist confirmations + new-signup pings)    |
| `NOTIFY_EMAIL`   | Where new-signup pings go                                     |
| `BOT_API_URL`    | Full URL of the backend, e.g. `https://filter-fyi-backend.fly.dev/api/try` |
| `BOT_API_KEY`    | Shared secret — must match the backend's `FILTER_FYI_TRY_SECRET` |

Preview deployments don't carry the secrets, so they exercise the graceful-degradation path (signups stored, email skipped; `/api/try` returns `service-unavailable`).

## Not yet wired up

- The weekly digest itself — the actual product
- React Email templates — confirmation/notification emails are currently hand-written inline HTML; fine at this volume, worth revisiting if email needs grow
