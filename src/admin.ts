// Admin surface for filter.fyi, served on its own origin (admin.filter.fyi)
// from the same Worker via host-based routing. Authentication is delegated
// entirely to Cloudflare Access — there is no overlap with the magic-link
// session flow used by end users, and no admin DB rows. Identity comes from
// the signed JWT that Access attaches to every request after the user passes
// the Access policy on the admin.filter.fyi application.
//
// Defense-in-depth: the Worker re-verifies the JWT (signature, issuer,
// audience) against the team's published JWKS, so a misconfigured Access
// policy fails closed rather than silently exposing the dashboard.
//
// This module ships the host-routing + auth scaffold only. Dashboard tiles
// (growth, scans, cost, reliability) land in follow-up PRs reading from D1
// and the backend's /api/admin/* endpoints.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface AdminEnv {
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g. "filter-fyi.cloudflareaccess.com"
  CF_ACCESS_AUD?: string; // Application Audience tag from the Access app
  ADMIN_DEV_EMAIL?: string; // local-dev escape hatch; production must leave unset

  // Backend (Fly) — admin endpoints are pulled from the same backend that
  // serves /api/try, gated by a separate admin secret.
  BOT_API_URL?: string;
  BOT_ADMIN_KEY?: string;
}

// Cache the remote JWKS per team domain. createRemoteJWKSet handles HTTP-level
// caching of the certs internally; we keep one resolver per team domain across
// requests so we don't re-instantiate it on every invocation.
const _jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(team: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = _jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    _jwksCache.set(team, jwks);
  }
  return jwks;
}

/**
 * Verify a Cloudflare Access JWT and return the verified payload.
 *
 * Throws if the JWT is missing/invalid/expired/wrong-audience. The caller is
 * expected to catch and convert to a 401/403 response — leaking JWT failure
 * detail back to the client would only help an attacker.
 */
async function verifyAccessJwt(jwt: string, team: string, aud: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(jwt, getJwks(team), {
    issuer: `https://${team}`,
    audience: aud,
  });
  return payload;
}

/**
 * Resolve the admin identity for this request.
 *
 * Returns the verified email on success, or a 4xx Response that the caller
 * must propagate. We intentionally never fall through to the dashboard with
 * a partial check — every failure mode is an explicit return.
 */
async function resolveAdminIdentity(
  req: Request,
  env: AdminEnv,
  isLocalHost: boolean,
): Promise<string | Response> {
  // Local-dev escape hatch. Cloudflare Access does not run on localhost, so
  // without this `wrangler dev` is unusable for admin work. The bypass is
  // gated on (a) host=localhost AND (b) ADMIN_DEV_EMAIL being set — so this
  // can never fire in production unless the var is explicitly populated,
  // which the deploy checklist forbids.
  if (isLocalHost && env.ADMIN_DEV_EMAIL) {
    return env.ADMIN_DEV_EMAIL.toLowerCase();
  }

  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) {
    // Fail closed: an admin surface without configured auth must never serve.
    console.error("admin: CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD missing");
    return new Response("admin not configured", { status: 503 });
  }

  // Access attaches the JWT both as a cookie (CF_Authorization) and as a
  // request header. The header is what we verify — Cloudflare strips any
  // client-supplied version of this header at the edge, so its presence
  // means it came from Access itself.
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: JWTPayload;
  try {
    payload = await verifyAccessJwt(jwt, team, aud);
  } catch (err) {
    console.error("admin: JWT verify failed", err);
    return new Response("Unauthorized", { status: 401 });
  }

  const email = String(payload.email ?? "").toLowerCase().trim();
  if (!email) {
    console.error("admin: JWT had no email claim", { sub: payload.sub });
    return new Response("Unauthorized", { status: 401 });
  }
  return email;
}

/**
 * Top-level admin handler. Called by worker.ts after the hostname check.
 *
 * `pathname` is the admin-relative path: in production it's just the URL
 * pathname (admin.filter.fyi/foo → "/foo"); in local dev where admin lives
 * under /admin on the same host, the prefix is stripped before we get here.
 */
export async function handleAdminRequest(
  req: Request,
  env: AdminEnv,
  pathname: string,
  isLocalHost: boolean,
): Promise<Response> {
  const identity = await resolveAdminIdentity(req, env, isLocalHost);
  if (identity instanceof Response) return adminHeaders(identity);

  if (pathname === "" || pathname === "/") {
    return adminHeaders(renderAdminHome(identity));
  }

  if (pathname === "/cost" || pathname === "/cost/") {
    return adminHeaders(await renderCostOverview(req, env, identity));
  }

  if (pathname === "/usage" || pathname === "/usage/") {
    return adminHeaders(await renderUsageOverview(req, env, identity));
  }

  return adminHeaders(new Response("Not Found", { status: 404 }));
}

/**
 * Apply admin-specific response headers: no caching anywhere (admin pages
 * leak per-user data we never want stored), no indexing, no framing.
 */
function adminHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function renderAdminHome(email: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>filter.fyi admin</title>
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <header>
    <h1>filter.fyi admin</h1>
    <p class="who">Signed in as <code>${escapeHtml(email)}</code></p>
  </header>
  <main>
    <ul class="pillars">
      <li><a href="/cost"><strong>Cost</strong></a> — $/day, tokens/day, $/user, $/source_type (from <code>llm_calls</code>)</li>
      <li><a href="/usage"><strong>Usage</strong></a> — processed URLs, transcript source split, error breakdown</li>
      <li class="soon"><strong>Growth</strong> — waitlist signups, users, sessions over time</li>
      <li class="soon"><strong>Reliability</strong> — job error rate, error_log top fingerprints, P95 latency</li>
      <li class="soon"><strong>Platform</strong> — link-outs to Cloudflare Workers Observability and Fly metrics</li>
    </ul>
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// Cost overview
// ---------------------------------------------------------------------------

interface CostKpis {
  total_calls: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  errors: number;
  error_rate: number;
}

interface CostDailyRow {
  day: string;
  calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
}

interface CostBySource {
  source_type: string;
  calls: number;
  cost_usd: number;
  tokens: number;
}

interface CostByPurpose {
  purpose: string;
  calls: number;
  cost_usd: number;
  avg_latency_ms: number;
  errors: number;
}

interface CostByIdentity {
  kind: "signed_in" | "anon";
  calls: number;
  cost_usd: number;
  unique_actors: number;
}

interface TopUser {
  user_id: number;
  calls: number;
  cost_usd: number;
}

interface CacheByPurpose {
  purpose: string;
  hits: number;
  cost_saved_usd: number;
}

interface CacheStats {
  hits: number;
  cost_saved_usd: number;
  hit_rate: number;
  by_purpose: CacheByPurpose[];
}

interface CostOverview {
  range_days: number;
  as_of: string;
  kpis: CostKpis;
  daily: CostDailyRow[];
  by_source_type: CostBySource[];
  by_purpose: CostByPurpose[];
  by_identity: CostByIdentity[];
  top_users: TopUser[];
  // `cache` may be absent on older backends; renderer defaults to a zero
  // state so a backend pre-PR doesn't crash the page.
  cache?: CacheStats;
}

/**
 * Strip the trailing `/api/try` from BOT_API_URL to get the backend root —
 * mirrors the helper in worker.ts. Duplicated rather than imported to keep
 * admin.ts free of cross-file dependencies on the public-site code.
 */
function backendBase(botApiUrl: string): string {
  return botApiUrl.replace(/\/api\/try\/?$/, "");
}

async function fetchCostOverview(env: AdminEnv, days: number): Promise<CostOverview | Response> {
  if (!env.BOT_API_URL || !env.BOT_ADMIN_KEY) {
    console.error("admin: BOT_API_URL or BOT_ADMIN_KEY not configured");
    return new Response("admin backend not configured", { status: 503 });
  }
  const url = `${backendBase(env.BOT_API_URL)}/api/admin/cost-overview?days=${days}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "x-filter-fyi-admin-secret": env.BOT_ADMIN_KEY },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("admin: cost-overview fetch threw", err);
    return new Response("upstream unreachable", { status: 502 });
  }
  if (!upstream.ok) {
    console.error("admin: cost-overview upstream non-ok", upstream.status);
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }
  try {
    return (await upstream.json()) as CostOverview;
  } catch (err) {
    console.error("admin: cost-overview response not JSON", err);
    return new Response("upstream malformed", { status: 502 });
  }
}

async function renderCostOverview(req: Request, env: AdminEnv, email: string): Promise<Response> {
  const url = new URL(req.url);
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 365 ? Math.floor(daysParam) : 30;

  const data = await fetchCostOverview(env, days);
  if (data instanceof Response) {
    // Pass through 502/503 so the operator sees what's wrong rather than a
    // half-rendered tile blaming "no data".
    return data;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Cost · filter.fyi admin</title>
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <header>
    <h1><a href="/" class="back">←</a> Cost overview</h1>
    <p class="who">Last ${data.range_days} days · as of ${escapeHtml(data.as_of)} · <code>${escapeHtml(email)}</code></p>
    <nav class="range">
      ${[7, 30, 90].map(n => `<a href="/cost?days=${n}"${n === data.range_days ? ' class="current"' : ''}>${n}d</a>`).join(" · ")}
    </nav>
  </header>
  <main>
    ${renderKpis(data.kpis)}
    ${renderDailyChart(data.daily)}
    ${renderBySourceType(data.by_source_type, data.kpis.total_cost_usd)}
    ${renderByPurpose(data.by_purpose)}
    ${renderByIdentity(data.by_identity)}
    ${renderCache(data.cache)}
    ${renderTopUsers(data.top_users)}
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderKpis(k: CostKpis): string {
  return `<section class="kpis">
    <div class="kpi"><span class="label">Cost</span><span class="value">${formatUsd(k.total_cost_usd)}</span></div>
    <div class="kpi"><span class="label">Calls</span><span class="value">${formatInt(k.total_calls)}</span></div>
    <div class="kpi"><span class="label">Tokens</span><span class="value">${formatTokens(k.total_input_tokens + k.total_output_tokens)}</span><span class="sub">${formatTokens(k.total_input_tokens)} in · ${formatTokens(k.total_output_tokens)} out</span></div>
    <div class="kpi"><span class="label">Error rate</span><span class="value">${formatPct(k.error_rate)}</span><span class="sub">${formatInt(k.errors)} failed</span></div>
  </section>`;
}

function renderDailyChart(daily: CostDailyRow[]): string {
  if (daily.length === 0) {
    return `<section class="tile"><h2>Daily cost</h2><p class="empty">No data yet.</p></section>`;
  }
  const w = 720;
  const h = 140;
  const padding = { left: 36, right: 8, top: 8, bottom: 22 };
  const innerW = w - padding.left - padding.right;
  const innerH = h - padding.top - padding.bottom;
  const maxCost = Math.max(...daily.map(d => d.cost_usd), 0.0001); // avoid /0
  const barW = innerW / daily.length;
  const gap = Math.max(1, barW * 0.15);

  const bars = daily.map((d, i) => {
    const x = padding.left + i * barW + gap / 2;
    const bh = (d.cost_usd / maxCost) * innerH;
    const y = padding.top + innerH - bh;
    const cls = d.errors > 0 ? "bar bar-err" : "bar";
    const tip = `${d.day} · ${formatUsd(d.cost_usd)} · ${d.calls} calls${d.errors > 0 ? ` · ${d.errors} errors` : ""}`;
    return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - gap).toFixed(1)}" height="${Math.max(bh, 0.5).toFixed(1)}"><title>${escapeHtml(tip)}</title></rect>`;
  }).join("");

  // Y-axis ticks: 0 and the max
  const yMax = padding.top;
  const yZero = padding.top + innerH;
  // X-axis ticks: first and last day
  const firstDay = daily[0]?.day ?? "";
  const lastDay = daily[daily.length - 1]?.day ?? "";

  return `<section class="tile">
    <h2>Daily cost</h2>
    <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily cost bar chart for the selected range">
      <line class="axis" x1="${padding.left}" x2="${padding.left}" y1="${yMax}" y2="${yZero}" />
      <line class="axis" x1="${padding.left}" x2="${w - padding.right}" y1="${yZero}" y2="${yZero}" />
      <text class="tick" x="${padding.left - 4}" y="${yMax + 4}" text-anchor="end">${formatUsd(maxCost)}</text>
      <text class="tick" x="${padding.left - 4}" y="${yZero}" text-anchor="end">$0</text>
      <text class="tick" x="${padding.left}" y="${h - 6}" text-anchor="start">${escapeHtml(firstDay)}</text>
      <text class="tick" x="${w - padding.right}" y="${h - 6}" text-anchor="end">${escapeHtml(lastDay)}</text>
      ${bars}
    </svg>
    <p class="sub">Bars in red indicate days with at least one failed LLM call.</p>
  </section>`;
}

function renderBySourceType(rows: CostBySource[], totalCost: number): string {
  if (rows.length === 0) {
    return `<section class="tile"><h2>By source type</h2><p class="empty">No successful calls in range.</p></section>`;
  }
  const denom = totalCost > 0 ? totalCost : 1;
  const body = rows.map(r => {
    const pct = (r.cost_usd / denom) * 100;
    return `<tr>
      <td>${escapeHtml(r.source_type)}</td>
      <td class="num">${formatInt(r.calls)}</td>
      <td class="num">${formatUsd(r.cost_usd)}</td>
      <td class="num">${formatTokens(r.tokens)}</td>
      <td class="bar-cell"><span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span><span class="pct">${pct.toFixed(1)}%</span></td>
    </tr>`;
  }).join("");
  return `<section class="tile">
    <h2>By source type</h2>
    <table>
      <thead><tr><th>Type</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">Tokens</th><th>Share</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderByPurpose(rows: CostByPurpose[]): string {
  if (rows.length === 0) {
    return `<section class="tile"><h2>By purpose</h2><p class="empty">No data yet.</p></section>`;
  }
  const body = rows.map(r => `<tr>
    <td>${escapeHtml(r.purpose)}</td>
    <td class="num">${formatInt(r.calls)}</td>
    <td class="num">${formatUsd(r.cost_usd)}</td>
    <td class="num">${formatInt(r.avg_latency_ms)} ms</td>
    <td class="num">${r.errors > 0 ? `<span class="err">${formatInt(r.errors)}</span>` : "0"}</td>
  </tr>`).join("");
  return `<section class="tile">
    <h2>By purpose</h2>
    <table>
      <thead><tr><th>Purpose</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">Avg latency</th><th class="num">Errors</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderByIdentity(rows: CostByIdentity[]): string {
  const byKind: Record<string, CostByIdentity | undefined> = {};
  for (const r of rows) byKind[r.kind] = r;
  const card = (label: string, key: "signed_in" | "anon", actorLabel: string) => {
    const r = byKind[key] ?? { kind: key, calls: 0, cost_usd: 0, unique_actors: 0 };
    return `<div class="identity-card">
      <h3>${label}</h3>
      <dl>
        <dt>Cost</dt><dd>${formatUsd(r.cost_usd)}</dd>
        <dt>Calls</dt><dd>${formatInt(r.calls)}</dd>
        <dt>${actorLabel}</dt><dd>${formatInt(r.unique_actors)}</dd>
      </dl>
    </div>`;
  };
  return `<section class="tile">
    <h2>Anon vs signed-in</h2>
    <div class="identity-cards">
      ${card("Signed-in", "signed_in", "Unique users")}
      ${card("Anon", "anon", "Unique anon visitors")}
    </div>
  </section>`;
}

function renderCache(cache: CacheStats | undefined): string {
  // Backend pre-PR didn't send a `cache` block — render zero state.
  const c = cache ?? { hits: 0, cost_saved_usd: 0, hit_rate: 0, by_purpose: [] };
  if (c.hits === 0) {
    return `<section class="tile">
      <h2>Cache</h2>
      <p class="empty">No cache hits in range yet — first repeats will start showing here.</p>
    </section>`;
  }
  const purposeRows = c.by_purpose.map(r => `<tr>
    <td>${escapeHtml(r.purpose)}</td>
    <td class="num">${formatInt(r.hits)}</td>
    <td class="num">${formatUsd(r.cost_saved_usd)}</td>
  </tr>`).join("");
  return `<section class="tile">
    <h2>Cache</h2>
    <div class="cache-kpis">
      <div class="kpi"><span class="label">Hits</span><span class="value">${formatInt(c.hits)}</span></div>
      <div class="kpi"><span class="label">Cost saved (est.)</span><span class="value">${formatUsd(c.cost_saved_usd)}</span></div>
      <div class="kpi"><span class="label">Hit rate</span><span class="value">${formatPct(c.hit_rate)}</span><span class="sub">of cacheable upstream calls</span></div>
    </div>
    ${purposeRows ? `<table>
      <thead><tr><th>Purpose</th><th class="num">Hits</th><th class="num">Saved</th></tr></thead>
      <tbody>${purposeRows}</tbody>
    </table>` : ""}
    <p class="sub">Savings are estimated from the trailing 7-day average cost-per-call of each purpose; honest within an order of magnitude.</p>
  </section>`;
}

function renderTopUsers(rows: TopUser[]): string {
  if (rows.length === 0) {
    return `<section class="tile"><h2>Top users by cost</h2><p class="empty">No signed-in usage in range.</p></section>`;
  }
  const body = rows.map(r => `<tr>
    <td><code>user ${r.user_id}</code></td>
    <td class="num">${formatInt(r.calls)}</td>
    <td class="num">${formatUsd(r.cost_usd)}</td>
  </tr>`).join("");
  return `<section class="tile">
    <h2>Top users by cost</h2>
    <table>
      <thead><tr><th>User</th><th class="num">Calls</th><th class="num">Cost</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="sub">Identifier only — emails stay on the backend.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Usage overview
// ---------------------------------------------------------------------------

interface UsageKpis {
  total: number;
  ok: number;
  errors: number;
  error_rate: number;
}

interface UsageBySourceType {
  source_type: string;
  total: number;
  ok: number;
  errors: number;
}

interface UsageByErrorCode {
  error_code: string;
  count: number;
}

interface UsageTranscriptSource {
  source: string;
  count: number;
}

interface UsageRow {
  id: number;
  ts: string;
  url: string;
  title: string;
  source_type: string;
  user_id: number | null;
  anon_id: string | null;
  status: string;
  error_code: string;
  transcript_source: string;
  latency_ms: number;
}

interface UsageOverview {
  range_days: number;
  as_of: string;
  kpis: UsageKpis;
  by_source_type: UsageBySourceType[];
  by_error_code: UsageByErrorCode[];
  transcript_sources: UsageTranscriptSource[];
  rows: UsageRow[];
  total_rows: number;
  limit: number;
  offset: number;
}

async function fetchUsageOverview(
  env: AdminEnv,
  days: number,
  limit: number,
  offset: number,
): Promise<UsageOverview | Response> {
  if (!env.BOT_API_URL || !env.BOT_ADMIN_KEY) {
    console.error("admin: BOT_API_URL or BOT_ADMIN_KEY not configured");
    return new Response("admin backend not configured", { status: 503 });
  }
  const url = `${backendBase(env.BOT_API_URL)}/api/admin/usage-overview` +
              `?days=${days}&limit=${limit}&offset=${offset}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "x-filter-fyi-admin-secret": env.BOT_ADMIN_KEY },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("admin: usage-overview fetch threw", err);
    return new Response("upstream unreachable", { status: 502 });
  }
  if (!upstream.ok) {
    console.error("admin: usage-overview upstream non-ok", upstream.status);
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }
  try {
    return (await upstream.json()) as UsageOverview;
  } catch (err) {
    console.error("admin: usage-overview response not JSON", err);
    return new Response("upstream malformed", { status: 502 });
  }
}

async function renderUsageOverview(req: Request, env: AdminEnv, email: string): Promise<Response> {
  const url = new URL(req.url);
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 365 ? Math.floor(daysParam) : 30;
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) && limitParam >= 1 && limitParam <= 200 ? Math.floor(limitParam) : 50;
  const offsetParam = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;

  const data = await fetchUsageOverview(env, days, limit, offset);
  if (data instanceof Response) return data;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Usage · filter.fyi admin</title>
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <header>
    <h1><a href="/" class="back">←</a> Usage</h1>
    <p class="who">Last ${data.range_days} days · as of ${escapeHtml(data.as_of)} · <code>${escapeHtml(email)}</code></p>
    <nav class="range">
      ${[7, 30, 90].map(n => `<a href="/usage?days=${n}"${n === data.range_days ? ' class="current"' : ''}>${n}d</a>`).join(" · ")}
    </nav>
  </header>
  <main>
    ${renderUsageKpis(data.kpis)}
    ${renderTranscriptSources(data.transcript_sources)}
    ${renderUsageBySourceType(data.by_source_type)}
    ${renderUsageByErrorCode(data.by_error_code)}
    ${renderProcessedUrlList(data, days, limit, offset)}
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderUsageKpis(k: UsageKpis): string {
  return `<section class="kpis">
    <div class="kpi"><span class="label">URLs processed</span><span class="value">${formatInt(k.total)}</span></div>
    <div class="kpi"><span class="label">Successful</span><span class="value">${formatInt(k.ok)}</span></div>
    <div class="kpi"><span class="label">Errors</span><span class="value">${formatInt(k.errors)}</span></div>
    <div class="kpi"><span class="label">Error rate</span><span class="value">${formatPct(k.error_rate)}</span></div>
  </section>`;
}

function renderTranscriptSources(rows: UsageTranscriptSource[]): string {
  if (rows.length === 0) {
    return `<section class="tile">
      <h2>Video transcript source</h2>
      <p class="empty">No video URLs in range — this tile populates once someone scans a YouTube or video URL.</p>
    </section>`;
  }
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  const SOURCE_LABELS: Record<string, string> = {
    youtube: "YouTube captions",
    whisper: "Whisper transcription",
    description: "Description fallback",
    none: "No transcript available",
    "(none)": "No transcript source recorded",
  };
  const body = rows.map(r => {
    const pct = total > 0 ? (r.count / total) * 100 : 0;
    return `<tr>
      <td>${escapeHtml(SOURCE_LABELS[r.source] ?? r.source)}</td>
      <td class="num">${formatInt(r.count)}</td>
      <td class="bar-cell"><span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span><span class="pct">${pct.toFixed(1)}%</span></td>
    </tr>`;
  }).join("");
  return `<section class="tile">
    <h2>Video transcript source</h2>
    <table>
      <thead><tr><th>Source</th><th class="num">Count</th><th>Share</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="sub">Whisper rows are the expensive ones — we only fall back to audio transcription when YouTube doesn't expose captions and the video is short enough.</p>
  </section>`;
}

function renderUsageBySourceType(rows: UsageBySourceType[]): string {
  if (rows.length === 0) {
    return `<section class="tile"><h2>By source type</h2><p class="empty">Nothing yet.</p></section>`;
  }
  const body = rows.map(r => `<tr>
    <td>${escapeHtml(r.source_type)}</td>
    <td class="num">${formatInt(r.total)}</td>
    <td class="num">${formatInt(r.ok)}</td>
    <td class="num">${r.errors > 0 ? `<span class="err">${formatInt(r.errors)}</span>` : "0"}</td>
  </tr>`).join("");
  return `<section class="tile">
    <h2>By source type</h2>
    <table>
      <thead><tr><th>Type</th><th class="num">Total</th><th class="num">OK</th><th class="num">Errors</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderUsageByErrorCode(rows: UsageByErrorCode[]): string {
  if (rows.length === 0) {
    return `<section class="tile"><h2>Top error reasons</h2><p class="empty">No failures in range. (Or no traffic.)</p></section>`;
  }
  const body = rows.map(r => `<tr>
    <td><code>${escapeHtml(r.error_code)}</code></td>
    <td class="num">${formatInt(r.count)}</td>
  </tr>`).join("");
  return `<section class="tile">
    <h2>Top error reasons</h2>
    <table>
      <thead><tr><th>Error code</th><th class="num">Count</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderProcessedUrlList(
  data: UsageOverview,
  days: number,
  limit: number,
  offset: number,
): string {
  if (data.rows.length === 0) {
    return `<section class="tile"><h2>Recent URLs</h2><p class="empty">No URLs in this window.</p></section>`;
  }
  const body = data.rows.map(r => {
    const who = r.user_id !== null
      ? `<code>user ${r.user_id}</code>`
      : r.anon_id
        ? `<code>anon ${escapeHtml(r.anon_id.slice(0, 8))}…</code>`
        : `<span class="muted">—</span>`;
    const statusCell = r.status === "ok"
      ? `<span class="status-ok">ok</span>`
      : `<span class="err" title="${escapeHtml(r.error_code)}">${escapeHtml(r.error_code || "error")}</span>`;
    const titleOrUrl = r.title || r.url;
    return `<tr>
      <td class="ts">${escapeHtml(r.ts.replace("T", " "))}</td>
      <td class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(titleOrUrl)}</a><br><span class="muted">${escapeHtml(r.source_type || "?")}${r.transcript_source ? ` · ${escapeHtml(r.transcript_source)}` : ""}</span></td>
      <td>${who}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join("");

  const start = offset + 1;
  const end = Math.min(offset + data.rows.length, data.total_rows);
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const prevDisabled = offset === 0;
  const nextDisabled = end >= data.total_rows;
  const linkBase = `/usage?days=${days}&limit=${limit}`;

  return `<section class="tile">
    <h2>Recent URLs</h2>
    <p class="sub">Showing ${formatInt(start)}–${formatInt(end)} of ${formatInt(data.total_rows)}</p>
    <table class="url-list">
      <thead><tr><th>When (UTC)</th><th>Title / source</th><th>Who</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <nav class="paginator">
      ${prevDisabled
        ? `<span class="paginator-disabled">← previous</span>`
        : `<a href="${linkBase}&offset=${prevOffset}">← previous</a>`}
      ${nextDisabled
        ? `<span class="paginator-disabled">next →</span>`
        : `<a href="${linkBase}&offset=${nextOffset}">next →</a>`}
    </nav>
  </section>`;
}

// ---------------------------------------------------------------------------
// Formatting + shared CSS
// ---------------------------------------------------------------------------

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared between the home page and every tile page so we keep one design
// surface. Variables drive light/dark; the rest is laid out for a single
// scroll column up to ~880px wide.
const ADMIN_CSS = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #777; --line: #8884; --tile-bg: #8881; --bar: #4a7cff; --bar-err: #d35454; --link: #2255cc; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #999; --link: #88aaff; } }
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 880px; margin: 2rem auto 4rem; padding: 0 1rem; color: var(--fg); }
  a { color: var(--link); }
  header { border-bottom: 1px solid var(--line); padding-bottom: .75rem; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.35rem; }
  h1 .back { text-decoration: none; margin-right: .35rem; color: var(--muted); }
  h2 { margin: 0 0 .75rem; font-size: 1.05rem; font-weight: 600; }
  h3 { margin: 0 0 .5rem; font-size: .95rem; font-weight: 600; }
  .who { color: var(--muted); font-size: .85rem; margin: 0; }
  code { background: var(--tile-bg); padding: 1px 6px; border-radius: 3px; font-size: .85em; }
  nav.range { margin-top: .5rem; font-size: .85rem; }
  nav.range a.current { font-weight: 600; }
  ul.pillars { padding-left: 1.2rem; }
  ul.pillars li { margin: .35rem 0; }
  ul.pillars li.soon { color: var(--muted); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin-bottom: 1.5rem; }
  .kpi { background: var(--tile-bg); border-radius: 6px; padding: .75rem 1rem; display: flex; flex-direction: column; }
  .kpi .label { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
  .kpi .value { font-size: 1.4rem; font-weight: 600; margin-top: .15rem; }
  .kpi .sub { color: var(--muted); font-size: .75rem; margin-top: .15rem; }
  .tile { background: var(--tile-bg); border-radius: 6px; padding: 1rem 1.1rem; margin-bottom: 1.25rem; }
  .tile .empty { color: var(--muted); font-style: italic; margin: 0; }
  .tile .sub { color: var(--muted); font-size: .75rem; margin: .5rem 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { padding: .35rem .5rem; text-align: left; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.bar-cell { width: 30%; }
  .bar-track { display: inline-block; width: 60%; height: 8px; background: var(--line); border-radius: 3px; overflow: hidden; vertical-align: middle; }
  .bar-fill { display: block; height: 100%; background: var(--bar); }
  .pct { display: inline-block; min-width: 3.5em; color: var(--muted); font-size: .8rem; margin-left: .5rem; vertical-align: middle; }
  .err { color: var(--bar-err); font-weight: 600; }
  svg.sparkline { width: 100%; height: auto; max-height: 160px; }
  svg.sparkline .bar { fill: var(--bar); }
  svg.sparkline .bar-err { fill: var(--bar-err); }
  svg.sparkline .axis { stroke: var(--line); stroke-width: 1; }
  svg.sparkline .tick { font: 10px system-ui; fill: var(--muted); }
  .identity-cards { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  .identity-card { background: rgba(128,128,128,.06); border-radius: 4px; padding: .75rem .9rem; }
  .identity-card dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem .75rem; margin: 0; }
  .identity-card dt { color: var(--muted); font-size: .8rem; }
  .identity-card dd { margin: 0; font-variant-numeric: tabular-nums; }
  .cache-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: .75rem; }
  .cache-kpis .kpi { background: rgba(128,128,128,.06); }
  .muted { color: var(--muted); }
  .status-ok { color: #2c8a3d; font-weight: 600; }
  table.url-list { font-size: .8rem; }
  table.url-list td.ts { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
  table.url-list td.title { max-width: 350px; word-break: break-word; }
  table.url-list td.title a { text-decoration: none; }
  table.url-list td.title a:hover { text-decoration: underline; }
  table.url-list .muted { font-size: .75rem; }
  nav.paginator { margin-top: .75rem; display: flex; gap: 1rem; font-size: .85rem; }
  nav.paginator .paginator-disabled { color: var(--muted); }
  @media (max-width: 520px) { .identity-cards { grid-template-columns: 1fr; } }
`;
