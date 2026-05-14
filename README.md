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

Inspect signups:

```bash
npm run db:list:local
npm run db:list:remote
```

## Email

Confirmation and notification emails are sent via Resend. Config:

- `FROM_EMAIL` — set in `wrangler.jsonc` (`vars`); must be an address on a Resend-verified domain
- `RESEND_API_KEY` — secret: `npx wrangler secret put RESEND_API_KEY`
- `NOTIFY_EMAIL` — secret: `npx wrangler secret put NOTIFY_EMAIL` (where new-signup pings go)

For local dev, put `RESEND_API_KEY` and `NOTIFY_EMAIL` in `.dev.vars`.

If `RESEND_API_KEY` is unset, signups still succeed — email sending is skipped gracefully. Only brand-new signups trigger emails; re-submissions just update the row.

## Deployment

Pushes to `main` auto-deploy via Cloudflare's GitHub integration. Feature branches and PRs get preview URLs — keep `main` shippable and do non-trivial work on a branch.

## Not yet wired up

- The weekly digest itself — the actual product
- React Email templates — confirmation/notification emails are currently hand-written inline HTML; fine at this volume, worth revisiting if email needs grow
