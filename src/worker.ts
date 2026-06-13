import { handleAdminRequest } from "./admin";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FROM_EMAIL?: string;
  REPLY_TO_EMAIL?: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL?: string;
  BOT_API_URL?: string;
  BOT_API_KEY?: string;
  BOT_TIMEOUT_MS?: string;

  // Admin (admin.filter.fyi) — auth handled entirely by Cloudflare Access.
  // CF_ACCESS_TEAM_DOMAIN: e.g. "filter-fyi.cloudflareaccess.com"
  // CF_ACCESS_AUD:         Application Audience tag from the Access app
  // ADMIN_DEV_EMAIL:       local-dev only; must be unset in production
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ADMIN_DEV_EMAIL?: string;
}

const ADMIN_HOSTNAME = "admin.filter.fyi";

interface Signup {
  email: string;
  challenges: string[];
  source: string;
}

const ALLOWED_CHALLENGES = new Set(["volume", "relevance", "fragmentation", "action"]);
const ALLOWED_SOURCES = new Set(["hero", "final-cta"]);

const CHALLENGE_LABELS: Record<string, string> = {
  volume: "Too much content, not enough time",
  relevance: "Hard to tell what's relevant vs. hype",
  fragmentation: "Sources spread across too many apps",
  action: "Saves things but never acts on them",
};

const ANON_COOKIE = "fyi_anon";
const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1y
const ANON_DAILY_LIMIT = 3;
const IP_DAILY_LIMIT = 10; // higher than anon so a shared NAT doesn't lock everyone out
const BOT_TIMEOUT_MS_DEFAULT = 25_000;
const RATE_LIMIT_CLEANUP_PROBABILITY = 0.01; // ~1% of /api/try calls sweep old rows
const SLOW_SOURCE_TYPES = new Set(["video"]); // Phase 1 bounces these before calling the bot

// Derive the backend root from BOT_API_URL (which still points at /api/try).
// All other backend endpoints — /api/users/upsert, /api/library/*, /api/claim,
// /api/link/start — live alongside it.
function backendBase(botApiUrl: string): string {
  return botApiUrl.replace(/\/api\/try\/?$/, "");
}

const SESSION_COOKIE = "fyi_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const USER_DAILY_LIMIT = 25;
const LOGIN_DAILY_LIMIT_PER_EMAIL = 5;
const LOGIN_DAILY_LIMIT_PER_IP = 20;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // admin.filter.fyi is served by the same Worker via host-routing, with
    // Cloudflare Access (Zero Trust) handling auth at the edge. Anything
    // matching the admin host (or, in local dev, /admin on localhost) is
    // routed into the admin module and never sees the public-site logic
    // below. In dev we strip the /admin prefix so admin.ts only has to
    // think about admin-relative paths.
    const isAdminHost = url.hostname === ADMIN_HOSTNAME;
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const isLocalAdmin = isLocalHost && url.pathname.startsWith("/admin");
    if (isAdminHost || isLocalAdmin) {
      const adminPath = isLocalAdmin
        ? url.pathname.replace(/^\/admin/, "") || "/"
        : url.pathname;
      return handleAdminRequest(req, env, adminPath, isLocalHost);
    }

    if (url.pathname === "/api/v1/waitlist") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleWaitlist(req, env, ctx);
    }

    if (url.pathname === "/api/v1/try") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleTry(req, env, ctx);
    }

    if (url.pathname === "/api/v1/login") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLogin(req, env, ctx);
    }

    if (url.pathname === "/login/verify") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleLoginVerify(req, env, ctx);
    }

    if (url.pathname === "/api/v1/logout") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLogout(req, env);
    }

    if (url.pathname === "/api/v1/me") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleMe(req, env);
    }

    const libraryItemMatch = url.pathname.match(/^\/api\/v1\/library\/(\d+)$/);
    if (libraryItemMatch) {
      if (req.method !== "GET" && req.method !== "DELETE") {
        return json({ error: "method-not-allowed" }, 405);
      }
      return handleLibraryItem(req, env, Number(libraryItemMatch[1]));
    }

    if (url.pathname === "/api/v1/link/start") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLinkStart(req, env);
    }

    if (url.pathname === "/api/v1/account/export") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleAccountExport(req, env);
    }

    if (url.pathname === "/api/v1/account") {
      if (req.method !== "DELETE") return json({ error: "method-not-allowed" }, 405);
      return handleAccountDelete(req, env);
    }

    if (url.pathname === "/api/v1/profile") {
      if (req.method !== "PUT") return json({ error: "method-not-allowed" }, 405);
      return handleProfileUpdate(req, env);
    }

    if (url.pathname === "/api/v1/stats") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleStats(req, env);
    }

    if (url.pathname === "/api/v1/feedback") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleFeedback(req, env);
    }

    if (url.pathname === "/api/v1/saved-suggestions") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json({ error: "method-not-allowed" }, 405);
      }
      return handleSavedSuggestions(req, env);
    }

    const savedItemMatch = url.pathname.match(/^\/api\/v1\/saved-suggestions\/(\d+)$/);
    if (savedItemMatch) {
      if (req.method !== "PATCH" && req.method !== "DELETE") {
        return json({ error: "method-not-allowed" }, 405);
      }
      return handleSavedSuggestionItem(req, env, Number(savedItemMatch[1]));
    }

    if (url.pathname === "/api/v1/suggestion-feedback") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleSuggestionFeedback(req, env, ctx);
    }

    if (url.pathname === "/api/v1/subscriptions") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json({ error: "method-not-allowed" }, 405);
      }
      return handleSubscriptions(req, env);
    }

    const subscriptionMatch = url.pathname.match(/^\/api\/v1\/subscriptions\/(\d+)$/);
    if (subscriptionMatch) {
      if (req.method !== "DELETE") return json({ error: "method-not-allowed" }, 405);
      return handleSubscriptionDelete(req, env, Number(subscriptionMatch[1]));
    }

    const jobMatch = url.pathname.match(/^\/api\/v1\/job\/([0-9a-f-]{36})$/i);
    if (jobMatch) {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleJobStatus(req, env, jobMatch[1]);
    }

    // /join was the old waitlist URL (still the advertised og:url out there);
    // the page now lives at /about. Permanent redirect so shared links survive.
    if (url.pathname === "/join" || url.pathname === "/join/") {
      return Response.redirect(new URL("/about", url).toString(), 301);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(req));
  },
};

// Security headers for served documents/assets. CSP is intentionally applied
// only to HTML responses; the pages still use inline <script>/<style>, so
// script/style-src need 'unsafe-inline' for now (dropping it means moving
// inline code to external files + nonces — tracked as a follow-up). The rest
// (frame-ancestors, object-src, base-uri, img/connect restrictions, HSTS,
// nosniff, referrer-policy) is enforced regardless.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:", // result thumbnails come from arbitrary https hosts
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=15552000"); // 180d, no subdomains
  if (headers.get("content-type")?.includes("text/html")) {
    headers.set("Content-Security-Policy", CSP);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleWaitlist(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "expected-json" }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  // Honeypot: hidden field bots tend to fill. Return success so we don't tip them off.
  if (typeof body.website === "string" && body.website.length > 0) {
    return json({ ok: true });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return json({ error: "invalid-email" }, 400);
  }

  const challenges = Array.isArray(body.challenges)
    ? body.challenges.filter(
        (c): c is string => typeof c === "string" && ALLOWED_CHALLENGES.has(c)
      )
    : [];

  const source =
    typeof body.source === "string" && ALLOWED_SOURCES.has(body.source)
      ? body.source
      : "unknown";

  const nowIso = new Date().toISOString();

  let isNewSignup = false;
  try {
    // created_at is only set on insert, never on the conflict update — so a
    // returned created_at matching nowIso means this was a brand-new signup.
    const row = await env.DB.prepare(
      `INSERT INTO waitlist (email, challenges, source, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         challenges = excluded.challenges,
         source = excluded.source
       RETURNING created_at`
    )
      .bind(email, JSON.stringify(challenges), source, nowIso)
      .first<{ created_at: string }>();
    isNewSignup = row?.created_at === nowIso;
  } catch (err) {
    console.error("waitlist insert failed", err);
    return json({ error: "storage-error" }, 500);
  }

  if (isNewSignup) {
    ctx.waitUntil(sendNotifications(env, { email, challenges, source }));
  }

  return json({ ok: true });
}

async function sendNotifications(env: Env, signup: Signup): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    console.log("email skipped — RESEND_API_KEY or FROM_EMAIL not configured");
    return;
  }

  const tasks: Promise<void>[] = [
    sendEmail(env, {
      to: signup.email,
      subject: "You're on the filter.fyi list",
      html: confirmationEmail(),
      text: confirmationEmailText(),
    }),
  ];

  if (env.NOTIFY_EMAIL) {
    tasks.push(
      sendEmail(env, {
        to: env.NOTIFY_EMAIL,
        subject: `New filter.fyi signup — ${signup.email}`,
        html: notificationEmail(signup),
        text: notificationEmailText(signup),
      })
    );
  }

  await Promise.allSettled(tasks);
}

async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; html: string; text: string }
): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(env.REPLY_TO_EMAIL ? { reply_to: env.REPLY_TO_EMAIL } : {}),
      }),
    });
    if (!res.ok) {
      console.error("resend send failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("resend send threw", err);
  }
}

function emailShell(inner: string): string {
  const mono = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace";
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#efece4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efece4;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#f7f4ec;border:1px solid #1c1c1a;">
          <tr>
            <td style="padding:28px;font-family:${mono};font-size:14px;line-height:1.6;color:#1c1c1a;">
              ${inner}
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-family:${mono};font-size:11px;color:#9b9b91;">filter.fyi — relevant, not noise.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function confirmationEmail(): string {
  return emailShell(`
    <p style="margin:0 0 16px;font-weight:700;font-size:16px;">You're on the list.</p>
    <p style="margin:0 0 16px;color:#5e5e58;">Thanks for signing up for early access to <span style="color:#1f7a3a;">filter.fyi</span>.</p>
    <p style="margin:0 0 16px;color:#5e5e58;">I'll be in touch when early access opens — no spam, no newsletter, just one message when there's something real to show you.</p>
    <p style="margin:0;color:#5e5e58;">— Johannes</p>
  `);
}

function notificationEmail(signup: Signup): string {
  const challengeList = signup.challenges.length
    ? signup.challenges
        .map((c) => `<li style="margin:0 0 4px;">${escapeHtml(CHALLENGE_LABELS[c] ?? c)}</li>`)
        .join("")
    : `<li style="margin:0;color:#9b9b91;">(none selected)</li>`;
  return emailShell(`
    <p style="margin:0 0 16px;font-weight:700;font-size:16px;">New signup</p>
    <p style="margin:0 0 6px;color:#5e5e58;"><b style="color:#1c1c1a;">email</b> &nbsp; ${escapeHtml(signup.email)}</p>
    <p style="margin:0 0 12px;color:#5e5e58;"><b style="color:#1c1c1a;">source</b> &nbsp; ${escapeHtml(signup.source)}</p>
    <p style="margin:0 0 6px;color:#5e5e58;"><b style="color:#1c1c1a;">challenges</b></p>
    <ul style="margin:0;padding-left:18px;color:#5e5e58;">${challengeList}</ul>
  `);
}

function confirmationEmailText(): string {
  return [
    "You're on the list.",
    "",
    "Thanks for signing up for early access to filter.fyi.",
    "",
    "I'll be in touch when early access opens — no spam, no newsletter,",
    "just one message when there's something real to show you.",
    "",
    "— Johannes",
    "",
    "filter.fyi — relevant, not noise.",
  ].join("\n");
}

function notificationEmailText(signup: Signup): string {
  const challenges = signup.challenges.length
    ? signup.challenges.map((c) => `  - ${CHALLENGE_LABELS[c] ?? c}`).join("\n")
    : "  (none selected)";
  return [
    "New signup",
    "",
    `email:   ${signup.email}`,
    `source:  ${signup.source}`,
    "challenges:",
    challenges,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function isValidEmail(s: string): boolean {
  return s.length > 0 && s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

// --- /api/try ---------------------------------------------------------------

interface BotResponse {
  url: string;
  title?: string;
  source_type?: string;
  image_urls?: string[];
  content?: string;
  content_preview?: string;
  verdict?: string;
  // `id` is only set when the signed-in path goes through /api/library/add,
  // where the backend persists to items and returns the new row id.
  id?: number;
  analysis?: {
    main_idea?: string;
    why_it_matters?: string;
    grounded_in?: string;
    category?: string;
    suggestions?: Array<{ title?: string; detail?: string; first_step?: string; effort?: string }>;
    // legacy fields (pre 0–5 migration) — still present on older stored items
    quick_win?: string;
    first_step?: string;
    bigger_play?: string;
    suggested_experiment?: string;
    time_required?: string;
  };
  // Agent-handoff actions: one paste-able "try this" brief per suggestion (0–5).
  // Built by the backend so web + Telegram share the same wording.
  actions?: Array<{ index: number; title: string; detail: string; effort: string; brief: string; brief_link?: string }>;
}

async function handleTry(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Detect signed-in user up front — when present, the analyse+save flow goes
  // entirely through the backend (/api/library/add) and skips D1 storage.
  // Anonymous tries land in D1.anon_summaries with the anon cookie so they're
  // claimable on signup; the cookie is minted on first visit if missing.
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);

  const existing = cookies[ANON_COOKIE];
  const mintedCookie = !existing || !isValidAnonId(existing);
  const anonId = mintedCookie ? crypto.randomUUID() : existing;

  const respond = (body: unknown, status = 200) =>
    json(body, status, mintedCookie ? { "set-cookie": anonCookieHeader(anonId) } : undefined);

  if (!req.headers.get("content-type")?.includes("application/json")) {
    return respond({ error: "expected-json" }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond({ error: "invalid-json" }, 400);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isValidHttpUrl(url)) {
    return respond({ error: "invalid-url", message: "Please paste a full http(s) URL." }, 400);
  }

  const ourSourceType = classifyUrl(url);
  // Long-form video (Vimeo/Loom/Wistia/StreamYard) is slow to transcribe, so
  // anonymous visitors get bounced before we call the bot. Signed-in users have
  // the full product unlocked — let it through to the backend, which handles
  // transcription (and degrades to a description-only summary when needed).
  if (!session && SLOW_SOURCE_TYPES.has(ourSourceType)) {
    return respond(
      {
        error: "unsupported-source",
        message:
          "Long-form video transcription is supported in the full product — join the waitlist and we'll let you know.",
      },
      415
    );
  }

  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("bot not configured (BOT_API_URL / BOT_API_KEY missing)");
    return respond(
      { error: "service-unavailable", message: "The summarizer isn't configured yet." },
      503
    );
  }

  // Rate limiting:
  // - Signed-in: per-user counter (USER_DAILY_LIMIT). No anon/IP gate — they
  //   identified themselves and we know who to throttle.
  // - Anonymous: dual counter (cookie + IP). Cookie can be cleared trivially,
  //   so IP is the backstop; IP cap is higher so a shared NAT doesn't lock
  //   everyone out. Over-limit attempts still consume a slot — that's the
  //   anti-abuse shape we want.
  const today = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  let limitInfo: { used: number; limit: number };
  try {
    if (session) {
      const userRow = await env.DB.prepare(
        `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
         ON CONFLICT (key, day) DO UPDATE SET count = count + 1
         RETURNING count`
      )
        .bind(`user:${session.userId}`, today)
        .first<{ count: number }>();
      const used = userRow?.count ?? 0;
      if (used > USER_DAILY_LIMIT) {
        return respond(
          {
            error: "rate-limited",
            message: "You've hit today's limit. Resets tomorrow.",
            limit: USER_DAILY_LIMIT,
          },
          429
        );
      }
      limitInfo = { used, limit: USER_DAILY_LIMIT };
    } else {
      const anonRow = await env.DB.prepare(
        `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
         ON CONFLICT (key, day) DO UPDATE SET count = count + 1
         RETURNING count`
      )
        .bind(`anon:${anonId}`, today)
        .first<{ count: number }>();
      const anonCount = anonRow?.count ?? 0;
      const ipRow = await env.DB.prepare(
        `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
         ON CONFLICT (key, day) DO UPDATE SET count = count + 1
         RETURNING count`
      )
        .bind(`ip:${ip}`, today)
        .first<{ count: number }>();
      const ipCount = ipRow?.count ?? 0;
      if (anonCount > ANON_DAILY_LIMIT) {
        return respond(
          {
            error: "rate-limited",
            message: "You've hit today's free limit — sign up to save and get more.",
            limit: ANON_DAILY_LIMIT,
          },
          429
        );
      }
      if (ipCount > IP_DAILY_LIMIT) {
        return respond(
          {
            error: "rate-limited",
            message: "Too many tries from this network today. Try again tomorrow.",
            limit: IP_DAILY_LIMIT,
          },
          429
        );
      }
      limitInfo = { used: anonCount, limit: ANON_DAILY_LIMIT };
    }
  } catch (err) {
    console.error("rate_limits upsert failed", err);
    return respond({ error: "storage-error" }, 500);
  }

  // Opportunistic cleanup so rate_limits doesn't grow forever. Cheap; runs on
  // ~1% of calls. Replace with a cron worker once we have one.
  if (Math.random() < RATE_LIMIT_CLEANUP_PROBABILITY) {
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM rate_limits WHERE day < date('now', '-30 days')")
        .run()
        .catch((err) => console.error("rate_limits cleanup failed", err))
    );
  }

  // Start an async job on the backend — returns a job_id immediately so the
  // Worker response stays well within Cloudflare's CPU/wall-clock limits.
  // The browser polls GET /api/v1/job/:id until the job is done or errors.
  // For anon traffic we forward the anon cookie as `anon_id` purely so the
  // backend can attribute LLM spend per visitor in `llm_calls` (no PII —
  // it's the same UUID the Worker already stores against anon_summaries).
  const jobBody = session
    ? JSON.stringify({ url, user_id: session.userId })
    : JSON.stringify({ url, anon_id: anonId });
  let jobRes: Response;
  try {
    jobRes = await fetch(`${backendBase(env.BOT_API_URL)}/api/job`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: jobBody,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      console.error("job start timed out");
      return respond(
        { error: "upstream-timeout", message: "The summarizer took too long. Try again in a moment." },
        504
      );
    }
    console.error("job start threw", err);
    return respond(
      { error: "upstream-unreachable", message: "Couldn't reach the summarizer. Try again in a moment." },
      502
    );
  }

  if (!jobRes.ok) {
    let payload: { error?: string } = {};
    try { payload = (await jobRes.json()) as { error?: string }; } catch {}
    console.error("job start non-ok", jobRes.status, payload);
    return respond(
      { error: "upstream-error", message: "The summarizer had a problem. Try a different URL?" },
      502
    );
  }

  let jobPayload: { job_id?: string };
  try {
    jobPayload = (await jobRes.json()) as { job_id?: string };
  } catch (err) {
    console.error("job start response not json", err);
    return respond({ error: "upstream-error" }, 502);
  }

  const jobId = typeof jobPayload.job_id === "string" ? jobPayload.job_id : "";
  if (!jobId) {
    console.error("job start returned no job_id", jobPayload);
    return respond({ error: "upstream-error" }, 502);
  }

  return respond({
    ok: true,
    pending: true,
    job_id: jobId,
    tries_used: limitInfo.used,
    tries_limit: limitInfo.limit,
    signed_in: !!session,
  });
}

async function handleJobStatus(req: Request, env: Env, jobId: string): Promise<Response> {
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    return json({ error: "service-unavailable" }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${backendBase(env.BOT_API_URL)}/api/job/${jobId}`, {
      headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("job poll threw", err);
    return json({ error: "upstream-unreachable" }, 502);
  }

  if (upstream.status === 404) return json({ error: "not-found" }, 404);
  if (!upstream.ok) {
    console.error("job poll non-ok", upstream.status);
    return json({ error: "upstream-error" }, 502);
  }

  type BackendJobStatus =
    | { status: "pending"; step?: string }
    | { status: "done"; result: BotResponse }
    | { status: "error"; error: string; message?: string };

  let statusPayload: BackendJobStatus;
  try {
    statusPayload = (await upstream.json()) as BackendJobStatus;
  } catch {
    return json({ error: "upstream-error" }, 502);
  }

  if (statusPayload.status === "pending") {
    return json({ status: "pending", step: statusPayload.step ?? "" });
  }

  if (statusPayload.status === "error") {
    const errCode = statusPayload.error;
    if (errCode === "no-transcript") {
      return json(
        {
          status: "error",
          error: "unsupported-source",
          message: "This video doesn't have a transcript yet — full video support is coming in the product.",
        }
      );
    }
    // Prefer the backend's specific explanation (paywall, JS-wall, fetch
    // failure, …); fall back to a generic line only when it didn't send one.
    return json({
      status: "error",
      error: "upstream-error",
      message: statusPayload.message || "The summarizer had a problem. Try a different URL?",
    });
  }

  // status === "done" — for anonymous users, persist to D1.anon_summaries.
  const summary = statusPayload.result;
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  const anonId = cookies[ANON_COOKIE];

  let savedId: number | undefined = typeof summary.id === "number" ? summary.id : undefined;

  if (!session && anonId && isValidAnonId(anonId)) {
    const nowIso = new Date().toISOString();
    // Strip `content` (the full brief, up to 32k chars) from the D1 payload —
    // it's only needed by the live result page, while the claim-on-signup path
    // reads `content_preview`. Keeps anon_summaries row size bounded.
    const { content: _omitContent, ...slimSummary } = summary;
    try {
      const row = await env.DB.prepare(
        `INSERT INTO anon_summaries (anon_id, url, source_type, title, verdict, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
        .bind(
          anonId,
          summary.url ?? "",
          typeof summary.source_type === "string" ? summary.source_type : null,
          typeof summary.title === "string" ? summary.title : null,
          typeof summary.verdict === "string" ? summary.verdict : null,
          JSON.stringify(slimSummary),
          nowIso
        )
        .first<{ id: number }>();
      savedId = row?.id;
    } catch (err) {
      console.error("anon_summaries insert failed", err);
    }
  }

  return json({ status: "done", id: savedId, summary });
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function anonCookieHeader(anonId: string): string {
  return `${ANON_COOKIE}=${encodeURIComponent(anonId)}; Path=/; Max-Age=${ANON_COOKIE_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
}

function isValidAnonId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isValidHttpUrl(s: string): boolean {
  if (s.length === 0 || s.length > 2048) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // Defense-in-depth against SSRF. The backend does the authoritative check
    // (DNS resolution + IP-range validation); this rejects the obvious
    // internal targets syntactically so they never leave the edge.
    return !isBlockedHost(u.hostname);
  } catch {
    return false;
  }
}

// Syntactic block-list for clearly-internal hosts. No DNS — the backend
// resolves and validates the address; this only catches literal private IPs
// and internal-looking hostnames.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(internal|local|localhost)$/.test(host)) return true;

  // IPv4 literal → check private/loopback/link-local/reserved ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true; // malformed
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 literal → block loopback, unspecified, unique-local (fc00::/7),
  // link-local (fe80::/10), and IPv4-mapped.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host)) return true; // fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10
    if (host.startsWith("::ffff:")) return true; // IPv4-mapped
    return false;
  }

  return false;
}

function classifyUrl(raw: string): string {
  let host = "";
  let path = "";
  try {
    const u = new URL(raw);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return "article";
  }
  if (host === "youtu.be" || /(^|\.)youtube\.com$/.test(host)) return "youtube";
  if (host === "twitter.com" || host === "x.com" || /(^|\.)twitter\.com$/.test(host)) return "social";
  if (path.endsWith(".pdf")) return "pdf";
  if (host === "vimeo.com" || /(^|\.)vimeo\.com$/.test(host)) return "video";
  if (/streamyard|loom\.com|wistia/.test(host)) return "video";
  return "article";
}

// --- auth -------------------------------------------------------------------

interface Session {
  id: string;
  userId: number;
  email: string;
}

async function claimAnonEntries(env: Env, userId: number, anonId: string): Promise<void> {
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("claim skipped: backend not configured");
    return;
  }
  try {
    const res = await env.DB.prepare(
      `SELECT url, source_type, title, verdict, payload
       FROM anon_summaries WHERE anon_id = ?`
    )
      .bind(anonId)
      .all<{
        url: string;
        source_type: string | null;
        title: string | null;
        verdict: string | null;
        payload: string;
      }>();
    const rows = res.results ?? [];
    if (rows.length === 0) return;

    const claimRows = rows.map((r) => {
      let parsed: { content_preview?: unknown; analysis?: unknown } = {};
      try {
        const p = JSON.parse(r.payload);
        if (p && typeof p === "object") parsed = p;
      } catch {}
      return {
        url: r.url,
        title: r.title ?? undefined,
        source_type: r.source_type ?? "article",
        verdict: r.verdict ?? "skim",
        content_preview:
          typeof parsed.content_preview === "string" ? parsed.content_preview : undefined,
        analysis:
          parsed.analysis && typeof parsed.analysis === "object"
            ? parsed.analysis
            : undefined,
      };
    });

    const claimRes = await fetch(`${backendBase(env.BOT_API_URL)}/api/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: JSON.stringify({ user_id: userId, rows: claimRows }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!claimRes.ok) {
      // Rows stay in D1; surface for diagnosis but don't fail the login flow.
      console.error("claim non-ok", claimRes.status);
      return;
    }

    await env.DB.prepare(`DELETE FROM anon_summaries WHERE anon_id = ?`)
      .bind(anonId)
      .run();
  } catch (err) {
    console.error("claim threw", err);
  }
}


async function loadSession(sessionId: string | undefined, env: Env): Promise<Session | null> {
  if (!sessionId || !isValidToken(sessionId)) return null;
  try {
    // Post unified-identity refactor: email is denormalised onto `sessions`
    // (written by handleLoginVerify), so we no longer JOIN against the
    // deprecated D1 `users` table. user_id refers to the backend users.id.
    const row = await env.DB.prepare(
      `SELECT id, user_id, email, expires_at FROM sessions WHERE id = ?`
    )
      .bind(await hashToken(sessionId))
      .first<{ id: string; user_id: number; email: string; expires_at: string }>();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return { id: row.id, userId: row.user_id, email: row.email };
  } catch (err) {
    console.error("session lookup failed", err);
    return null;
  }
}

async function handleLogin(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "expected-json" }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return json({ error: "invalid-email", message: "Please enter a valid email address." }, 400);
  }

  // Per-email + per-IP daily caps stop someone from spamming login emails or
  // mass-mailing a list of addresses through us.
  const today = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const emailRow = await env.DB.prepare(
      `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(`login:${email}`, today)
      .first<{ count: number }>();
    if ((emailRow?.count ?? 0) > LOGIN_DAILY_LIMIT_PER_EMAIL) {
      return json(
        { error: "rate-limited", message: "Too many login attempts for that email today." },
        429
      );
    }
    const ipRow = await env.DB.prepare(
      `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(`login-ip:${ip}`, today)
      .first<{ count: number }>();
    if ((ipRow?.count ?? 0) > LOGIN_DAILY_LIMIT_PER_IP) {
      return json(
        { error: "rate-limited", message: "Too many login attempts from this network today." },
        429
      );
    }
  } catch (err) {
    console.error("login rate limit upsert failed", err);
    return json({ error: "storage-error" }, 500);
  }

  const token = randomTokenHex(32);
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO login_tokens (token, email, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(await hashToken(token), email, expiresIso, nowIso)
      .run();
  } catch (err) {
    console.error("login_tokens insert failed", err);
    return json({ error: "storage-error" }, 500);
  }

  const origin = new URL(req.url).origin;
  const link = `${origin}/login/verify?token=${token}`;

  if (env.RESEND_API_KEY && env.FROM_EMAIL) {
    ctx.waitUntil(
      sendEmail(env, {
        to: email,
        subject: "Sign in to filter.fyi",
        html: magicLinkEmail(link),
        text: magicLinkEmailText(link),
      })
    );
  } else {
    // Dev convenience: surface the link in logs when email isn't configured.
    console.log(`[dev] magic link for ${email}: ${link}`);
  }

  return json({ ok: true });
}

async function handleLoginVerify(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!isValidToken(token)) {
    return Response.redirect(`${url.origin}/login?error=invalid-link`, 302);
  }
  // Look up and burn the token by its hash; the plaintext only ever arrives
  // from the emailed link, never the DB.
  const tokenHash = await hashToken(token);

  let tokenRow: { email: string; expires_at: string; used_at: string | null } | null;
  try {
    tokenRow = await env.DB.prepare(
      `SELECT email, expires_at, used_at FROM login_tokens WHERE token = ?`
    )
      .bind(tokenHash)
      .first<{ email: string; expires_at: string; used_at: string | null }>();
  } catch (err) {
    console.error("login_tokens lookup failed", err);
    return Response.redirect(`${url.origin}/login?error=storage`, 302);
  }

  if (!tokenRow) {
    return Response.redirect(`${url.origin}/login?error=invalid-link`, 302);
  }
  if (tokenRow.used_at) {
    return Response.redirect(`${url.origin}/login?error=used-link`, 302);
  }
  if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
    return Response.redirect(`${url.origin}/login?error=expired-link`, 302);
  }

  const email = tokenRow.email;
  const nowIso = new Date().toISOString();

  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured (BOT_API_URL / BOT_API_KEY missing)");
    return Response.redirect(`${url.origin}/login?error=storage`, 302);
  }

  let userId: number;
  try {
    // Mark token used immediately so a second click can't double-spend it,
    // even if the rest of this handler is slow.
    await env.DB.prepare(`UPDATE login_tokens SET used_at = ? WHERE token = ?`)
      .bind(nowIso, tokenHash)
      .run();

    // Get-or-create the canonical user on the backend. Post unified-identity
    // refactor, the backend's `users` table is the source of truth and
    // sessions.user_id refers to backend users.id (NOT D1.users.id — that
    // table is now orphaned). See filter.fyi-backend POST /api/users/upsert.
    const upsertRes = await fetch(`${backendBase(env.BOT_API_URL)}/api/users/upsert`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!upsertRes.ok) {
      console.error("backend user upsert failed", upsertRes.status);
      return Response.redirect(`${url.origin}/login?error=storage`, 302);
    }
    const upsertBody = (await upsertRes.json()) as { user_id?: number };
    if (typeof upsertBody.user_id !== "number") {
      console.error("backend user upsert returned no user_id", upsertBody);
      return Response.redirect(`${url.origin}/login?error=storage`, 302);
    }
    userId = upsertBody.user_id;
  } catch (err) {
    console.error("user upsert failed", err);
    return Response.redirect(`${url.origin}/login?error=storage`, 302);
  }

  // Claim anon entries produced on this device pre-signup. Cross-DB:
  // read D1.anon_summaries → POST to backend /api/claim → DELETE from D1.
  // Best-effort and runs in the background so a slow backend doesn't block
  // the login redirect; rows stay in D1 on failure for a future retry.
  const cookies = parseCookies(req.headers.get("cookie"));
  const anonId = cookies[ANON_COOKIE];
  if (anonId && isValidAnonId(anonId)) {
    ctx.waitUntil(claimAnonEntries(env, userId, anonId));
  }

  const sessionId = randomTokenHex(32);
  const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(await hashToken(sessionId), userId, email, sessionExpires, nowIso)
      .run();
  } catch (err) {
    console.error("sessions insert failed", err);
    return Response.redirect(`${url.origin}/login?error=storage`, 302);
  }

  const headers = new Headers({
    location: `${url.origin}/me`,
    "set-cookie": sessionCookieHeader(sessionId),
    "cache-control": "no-store",
  });
  return new Response(null, { status: 302, headers });
}

async function handleLogout(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId && isValidToken(sessionId)) {
    try {
      await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await hashToken(sessionId)).run();
    } catch (err) {
      console.error("session delete failed", err);
    }
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookieHeader() });
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  // Lean library from the backend. The page lazy-fetches full analysis per
  // item via /api/library/:id when the user opens "Show analysis".
  type LeanRow = {
    id: number;
    source_type: string | null;
    source: string | null;
    verdict: string | null;
    title: string | null;
    created_at: string;
  };
  type UserInfo = { telegram_chat_id: number | null; profile?: string };
  const base = backendBase(env.BOT_API_URL);
  const headers = { "x-filter-fyi-secret": env.BOT_API_KEY };

  let rows: LeanRow[] = [];
  let telegramLinked: boolean | undefined = undefined;
  let profile = "";
  try {
    // The user-info call is best-effort — if it fails the UI just omits the
    // "Telegram linked" indicator. The library call is load-bearing.
    const [libRes, userRes] = await Promise.all([
      fetch(`${base}/api/library?user_id=${session.userId}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }),
      fetch(`${base}/api/users/${session.userId}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null),
    ]);

    if (!libRes.ok) {
      console.error("/api/me upstream non-ok", libRes.status);
      return json({ error: "upstream-error" }, 502);
    }
    rows = (await libRes.json()) as LeanRow[];

    if (userRes && userRes.ok) {
      const info = (await userRes.json()) as UserInfo;
      telegramLinked = info.telegram_chat_id !== null;
      profile = typeof info.profile === "string" ? info.profile : "";
    }
  } catch (err) {
    console.error("/api/me upstream failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }

  return json({
    ok: true,
    user: { email: session.email, telegram_linked: telegramLinked, profile },
    summaries: rows.map((row) => ({
      id: row.id,
      url: row.source ?? "",
      source_type: row.source_type,
      title: row.title,
      verdict: row.verdict,
      created_at: row.created_at,
      // No `summary` field — me.html lazy-fetches from /api/library/:id.
    })),
  });
}

async function handleLinkStart(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  try {
    const res = await fetch(`${backendBase(env.BOT_API_URL)}/api/link/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: JSON.stringify({ user_id: session.userId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error("/api/link/start upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json());
  } catch (err) {
    console.error("/api/link/start upstream failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

async function handleLibraryItem(req: Request, env: Env, itemId: number): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  const upstream = `${backendBase(env.BOT_API_URL)}/api/library/${itemId}?user_id=${session.userId}`;

  if (req.method === "DELETE") {
    try {
      const res = await fetch(upstream, {
        method: "DELETE",
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) return json({ error: "not-found" }, 404);
      if (!res.ok) {
        console.error("DELETE /api/library/:id upstream non-ok", res.status);
        return json({ error: "upstream-error" }, 502);
      }
      // Backend returns 204; give the client a small JSON body to assert on.
      return json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/library/:id upstream failed", err);
      return json({ error: "upstream-unreachable" }, 502);
    }
  }

  try {
    const res = await fetch(upstream, {
      headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return json({ error: "not-found" }, 404);
    if (!res.ok) {
      console.error("/api/library/:id upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json());
  } catch (err) {
    console.error("/api/library/:id upstream failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// GDPR data export. Streams the backend's per-user dump back to the browser as
// a downloadable JSON file.
async function handleAccountExport(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  try {
    const res = await fetch(
      `${backendBase(env.BOT_API_URL)}/api/users/${session.userId}/export`,
      { headers: { "x-filter-fyi-secret": env.BOT_API_KEY }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      console.error("account export upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    const data = await res.json();
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="filter-fyi-export.json"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    console.error("account export failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// GDPR erasure. Deletes the user + items + files on the backend, then removes
// every trace we hold at the edge (D1 sessions, login tokens, waitlist, and
// any anon rows tied to this device), and clears the session cookie.
async function handleAccountDelete(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  // 1. Backend: user, items, link codes, stored files. 404 means already gone.
  try {
    const res = await fetch(`${backendBase(env.BOT_API_URL)}/api/users/${session.userId}`, {
      method: "DELETE",
      headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) {
      console.error("account delete upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
  } catch (err) {
    console.error("account delete upstream failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }

  // 2. Edge (D1): everything keyed to this person. Best-effort — the backend
  // delete (the source of truth) already succeeded, so don't fail the request.
  const anonId = cookies[ANON_COOKIE];
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(session.userId),
      env.DB.prepare(`DELETE FROM login_tokens WHERE email = ?`).bind(session.email),
      env.DB.prepare(`DELETE FROM waitlist WHERE email = ?`).bind(session.email),
      ...(anonId && isValidAnonId(anonId)
        ? [env.DB.prepare(`DELETE FROM anon_summaries WHERE anon_id = ?`).bind(anonId)]
        : []),
    ]);
  } catch (err) {
    console.error("account delete: D1 cleanup failed (backend already purged)", err);
  }

  return json({ ok: true }, 200, { "set-cookie": clearSessionCookieHeader() });
}

// Value stats for the /me ROI strip (#53) — proxied per-session so a client
// can only ever read its own numbers.
async function handleStats(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }
  try {
    const res = await fetch(
      `${backendBase(env.BOT_API_URL)}/api/users/${session.userId}/stats`,
      {
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) {
      console.error("stats upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json());
  } catch (err) {
    console.error("stats failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// Update the signed-in user's personalization profile (the analysis lens).
async function handleProfileUpdate(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const profile = typeof body.profile === "string" ? body.profile.slice(0, 4000) : "";

  try {
    const res = await fetch(
      `${backendBase(env.BOT_API_URL)}/api/users/${session.userId}/profile`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-filter-fyi-secret": env.BOT_API_KEY },
        body: JSON.stringify({ profile }),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) {
      console.error("profile update upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json());
  } catch (err) {
    console.error("profile update failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// Record a feedback/signal event for one of the user's library items.
async function handleFeedback(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const itemId = Number(body.item_id);
  const signal = typeof body.signal === "string" ? body.signal : "";
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return json({ error: "invalid-item" }, 400);
  }

  try {
    const res = await fetch(`${backendBase(env.BOT_API_URL)}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-filter-fyi-secret": env.BOT_API_KEY },
      body: JSON.stringify({ user_id: session.userId, item_id: itemId, signal }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 400) return json({ error: "invalid-signal" }, 400);
    if (res.status === 404) return json({ error: "not-found" }, 404);
    if (!res.ok) {
      console.error("feedback upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error("feedback failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// Shortlist (saved suggestions) — the durable "later" store. POST parks a
// suggestion, GET lists the user's Shortlist. Backend-gated; the session
// supplies user_id so a client can never pin against another account.
async function handleSavedSuggestions(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }
  const base = backendBase(env.BOT_API_URL);
  const headers = { "content-type": "application/json", "x-filter-fyi-secret": env.BOT_API_KEY };

  if (req.method === "GET") {
    try {
      const res = await fetch(`${base}/api/saved-suggestions?user_id=${session.userId}`, {
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.error("saved-suggestions list upstream non-ok", res.status);
        return json({ error: "upstream-error" }, 502);
      }
      return json(await res.json());
    } catch (err) {
      console.error("saved-suggestions list failed", err);
      return json({ error: "upstream-unreachable" }, 502);
    }
  }

  // POST — park a suggestion. Snapshot fields are clipped to bound row size.
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const itemId = Number(body.item_id);
  const index = Number(body.suggestion_index);
  if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(index) || index < 0) {
    return json({ error: "invalid-input" }, 400);
  }
  const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  try {
    const res = await fetch(`${base}/api/saved-suggestions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: session.userId,
        item_id: itemId,
        suggestion_index: index,
        title: clip(body.title, 300),
        detail: clip(body.detail, 2000),
        effort: clip(body.effort, 80),
        first_step: clip(body.first_step, 2000),
        grounded_in: clip(body.grounded_in, 2000),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return json({ error: "not-found" }, 404);
    if (!res.ok) {
      console.error("saved-suggestions create upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json(), 201);
  } catch (err) {
    console.error("saved-suggestions create failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// Channels (subscriptions) — the feeds a signed-in user follows
// (research-companion#68). GET lists them, POST subscribes; the backend
// resolves any supported URL (RSS/Atom, YouTube channel, page with an
// advertised feed) at subscribe time, so its 422/409 messages are worth
// passing through verbatim.
async function handleSubscriptions(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }
  const base = backendBase(env.BOT_API_URL);

  if (req.method === "GET") {
    try {
      const res = await fetch(`${base}/api/subscriptions?user_id=${session.userId}`, {
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.error("subscriptions list upstream non-ok", res.status);
        return json({ error: "upstream-error" }, 502);
      }
      return json(await res.json());
    } catch (err) {
      console.error("subscriptions list failed", err);
      return json({ error: "upstream-unreachable" }, 502);
    }
  }

  // POST — subscribe. Feed resolution fetches the target (and possibly its
  // advertised feed) server-side, so allow more than the usual 5s.
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const subUrl = typeof body.url === "string" ? body.url.trim().slice(0, 2048) : "";
  if (!subUrl) return json({ error: "invalid-input" }, 400);
  try {
    const res = await fetch(`${base}/api/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-filter-fyi-secret": env.BOT_API_KEY },
      body: JSON.stringify({ user_id: session.userId, url: subUrl }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 422 || res.status === 409) {
      // Resolution / duplicate / cap errors carry user-facing messages.
      const detail = ((await res.json().catch(() => ({}))) as { detail?: Record<string, unknown> }).detail || {};
      return json(
        { error: detail.error || "invalid-feed", message: detail.message || "" },
        res.status
      );
    }
    if (!res.ok) {
      console.error("subscription create upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json(), 201);
  } catch (err) {
    console.error("subscription create failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

async function handleSubscriptionDelete(
  req: Request,
  env: Env,
  subId: number
): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }
  const base = backendBase(env.BOT_API_URL);
  try {
    const res = await fetch(`${base}/api/subscriptions/${subId}?user_id=${session.userId}`, {
      method: "DELETE",
      headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return json({ error: "not-found" }, 404);
    if (!res.ok) {
      console.error("subscription delete upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error("subscription delete failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// PATCH (status: saved|tried|done) or DELETE one Shortlist entry by id.
async function handleSavedSuggestionItem(
  req: Request,
  env: Env,
  savedId: number
): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!env.BOT_API_URL || !env.BOT_API_KEY) {
    console.error("backend not configured");
    return json({ error: "service-unavailable" }, 503);
  }
  const base = backendBase(env.BOT_API_URL);
  const upstream = `${base}/api/saved-suggestions/${savedId}`;

  if (req.method === "DELETE") {
    try {
      const res = await fetch(`${upstream}?user_id=${session.userId}`, {
        method: "DELETE",
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) return json({ error: "not-found" }, 404);
      if (!res.ok) {
        console.error("saved-suggestions delete upstream non-ok", res.status);
        return json({ error: "upstream-error" }, 502);
      }
      return json({ ok: true });
    } catch (err) {
      console.error("saved-suggestions delete failed", err);
      return json({ error: "upstream-unreachable" }, 502);
    }
  }

  // PATCH status
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const status = typeof body.status === "string" ? body.status : "";
  try {
    const res = await fetch(upstream, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-filter-fyi-secret": env.BOT_API_KEY },
      body: JSON.stringify({ user_id: session.userId, status }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 400) return json({ error: "invalid-status" }, 400);
    if (res.status === 404) return json({ error: "not-found" }, 404);
    if (!res.ok) {
      console.error("saved-suggestions patch upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    return json(await res.json());
  } catch (err) {
    console.error("saved-suggestions patch failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }
}

// Records a suggestion interaction event to D1 — the interest signal for tuning
// suggestion quality (shown / open / copy / open_chatgpt / open_claude / dismiss
// [+reason]). Needs no backend round-trip and works for anonymous visitors (the
// landing page is anon-heavy). Keyed by anon_id, or user_id when signed in.
const SUGGESTION_EVENTS = new Set([
  "shown", "open", "copy", "open_chatgpt", "open_claude", "dismiss",
  // Shortlist actions: "save" = parked for later; "tried"/"done" = follow-up.
  "save", "tried", "done",
]);

async function handleSuggestionFeedback(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const session = await loadSession(cookies[SESSION_COOKIE], env);
  const anonRaw = cookies[ANON_COOKIE];
  const anonId = anonRaw && isValidAnonId(anonRaw) ? anonRaw : null;

  // Need at least one identity to attribute the event to.
  if (!session && !anonId) return json({ error: "no-identity" }, 400);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const event = clip(body.event, 32) || "dismiss"; // default keeps old callers working
  if (!SUGGESTION_EVENTS.has(event)) return json({ error: "invalid-event" }, 400);
  const url = clip(body.url, 2048);
  const text = clip(body.suggestion_text, 2048);
  const reason = clip(body.reason, 2048);
  const idxRaw = body.suggestion_index;
  const index = Number.isInteger(idxRaw) ? (idxRaw as number) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO suggestion_feedback
         (anon_id, user_id, url, event, suggestion_index, suggestion_text, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        anonId,
        session ? session.userId : null,
        url || null,
        event,
        index,
        text || null,
        reason || null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    console.error("suggestion_feedback insert failed", err);
    return json({ error: "storage-error" }, 500);
  }

  // Signed-in events also flow to the backend so the analyzer's behaviour-
  // signal digest can learn from them (research-companion#69). D1 stays the
  // canonical stream (incl. anonymous traffic); "shown" render events are
  // denominator-only noise, so they stay D1-only. Fire-and-forget — the
  // user-facing ack never waits on the backend.
  if (session && event !== "shown" && env.BOT_API_URL && env.BOT_API_KEY) {
    ctx.waitUntil(
      fetch(`${backendBase(env.BOT_API_URL)}/api/suggestion-signals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-filter-fyi-secret": env.BOT_API_KEY,
        },
        body: JSON.stringify({
          user_id: session.userId,
          event,
          url,
          suggestion_index: index,
          suggestion_text: text,
          reason,
        }),
      }).catch((err) => console.error("suggestion signal forward failed", err))
    );
  }
  return json({ ok: true });
}

function randomTokenHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Magic-link and session tokens are stored only as their SHA-256 hash, so a
// stolen read of D1 (login_tokens / sessions) can't be replayed to hijack a
// session or burn a login link — the plaintext exists only in the emailed
// link and the cookie. No salt/stretching: the input is already a 256-bit
// random secret, not a guessable password. Output is 64 lowercase hex chars,
// same shape as randomTokenHex(32), so it satisfies isValidToken and the
// existing column width.
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidToken(s: string): boolean {
  return /^[0-9a-f]{32,128}$/.test(s);
}

function sessionCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

function magicLinkEmail(link: string): string {
  return emailShell(`
    <p style="margin:0 0 16px;font-weight:700;font-size:16px;">Sign in to <span style="color:#1f7a3a;">filter.fyi</span></p>
    <p style="margin:0 0 16px;color:#5e5e58;">Click the button below to sign in. The link is good for 15 minutes and can only be used once.</p>
    <p style="margin:0 0 20px;">
      <a href="${link}" style="display:inline-block;padding:10px 18px;background:#1c1c1a;color:#f7f4ec;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.02em;">Sign in →</a>
    </p>
    <p style="margin:0 0 8px;color:#9b9b91;font-size:11px;">Or paste this URL into your browser:</p>
    <p style="margin:0 0 16px;color:#5e5e58;font-size:11px;word-break:break-all;">${link}</p>
    <p style="margin:0;color:#9b9b91;font-size:11px;">If you didn't request this, you can ignore this email.</p>
  `);
}

function magicLinkEmailText(link: string): string {
  return [
    "Sign in to filter.fyi",
    "",
    "Click this link to sign in (good for 15 minutes, single use):",
    link,
    "",
    "If you didn't request this, you can ignore this email.",
    "",
    "filter.fyi — relevant, not noise.",
  ].join("\n");
}
