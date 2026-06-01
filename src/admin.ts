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
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.5 system-ui, -apple-system, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    header { border-bottom: 1px solid #8884; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
    .who { color: #888; font-size: .9rem; }
    code { background: #8881; padding: 1px 6px; border-radius: 3px; }
    ul.coming { color: #666; }
    ul.coming li { margin: .25rem 0; }
  </style>
</head>
<body>
  <header>
    <h1>filter.fyi admin</h1>
    <p class="who">Signed in as <code>${escapeHtml(email)}</code> · scaffold only — dashboard tiles land next</p>
  </header>
  <main>
    <p>Pillars planned (will read from D1 + backend /api/admin/* endpoints):</p>
    <ul class="coming">
      <li><strong>Growth</strong> — waitlist signups, users, sessions over time</li>
      <li><strong>Usage</strong> — scans/day, source-type mix, verdict mix, feedback</li>
      <li><strong>Reliability</strong> — job error rate, error_log top fingerprints, P95 latency</li>
      <li><strong>Cost</strong> — $/day, tokens/day, $/user, $/source_type (from <code>llm_calls</code>)</li>
      <li><strong>Platform</strong> — link-outs to Cloudflare Workers Observability and Fly metrics</li>
    </ul>
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
