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
}

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

    if (url.pathname === "/api/waitlist") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleWaitlist(req, env, ctx);
    }

    if (url.pathname === "/api/try") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleTry(req, env, ctx);
    }

    if (url.pathname === "/api/login") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLogin(req, env, ctx);
    }

    if (url.pathname === "/login/verify") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleLoginVerify(req, env, ctx);
    }

    if (url.pathname === "/api/logout") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLogout(req, env);
    }

    if (url.pathname === "/api/me") {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleMe(req, env);
    }

    const libraryItemMatch = url.pathname.match(/^\/api\/library\/(\d+)$/);
    if (libraryItemMatch) {
      if (req.method !== "GET") return json({ error: "method-not-allowed" }, 405);
      return handleLibraryItem(req, env, Number(libraryItemMatch[1]));
    }

    if (url.pathname === "/api/link/start") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleLinkStart(req, env);
    }

    return env.ASSETS.fetch(req);
  },
};

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
  content_preview?: string;
  verdict?: string;
  // `id` is only set when the signed-in path goes through /api/library/add,
  // where the backend persists to items and returns the new row id.
  id?: number;
  analysis?: {
    main_idea?: string;
    why_it_matters?: string;
    category?: string;
    suggested_experiment?: string;
    time_required?: string;
  };
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
  if (SLOW_SOURCE_TYPES.has(ourSourceType)) {
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

  // Call bot — with timeout so a hung backend doesn't hang the Worker.
  // Signed-in calls go to /api/library/add, which analyses AND persists to the
  // backend's items table. Anonymous calls go to /api/try, which only analyses;
  // we then write to D1.anon_summaries ourselves for later claim-on-signup.
  const botEndpoint = session
    ? `${backendBase(env.BOT_API_URL)}/api/library/add`
    : env.BOT_API_URL;
  const botBody = session
    ? JSON.stringify({ user_id: session.userId, url })
    : JSON.stringify({ url });
  let botRes: Response;
  try {
    botRes = await fetch(botEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: botBody,
      signal: AbortSignal.timeout(Number(env.BOT_TIMEOUT_MS) || BOT_TIMEOUT_MS_DEFAULT),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      console.error("bot fetch timed out");
      return respond(
        {
          error: "upstream-timeout",
          message: "The summarizer took too long. Try again in a moment.",
        },
        504
      );
    }
    console.error("bot fetch threw", err);
    return respond(
      {
        error: "upstream-unreachable",
        message: "Couldn't reach the summarizer. Try again in a moment.",
      },
      502
    );
  }

  if (!botRes.ok) {
    let payload: { error?: string; message?: string } = {};
    try {
      payload = (await botRes.json()) as { error?: string; message?: string };
    } catch {}
    if (payload.error === "no-transcript") {
      return respond(
        {
          error: "unsupported-source",
          message:
            "This video doesn't have a transcript yet — full video support is coming in the product.",
        },
        415
      );
    }
    console.error("bot returned non-ok", botRes.status, payload);
    return respond(
      { error: "upstream-error", message: "The summarizer had a problem. Try a different URL?" },
      502
    );
  }

  let summary: BotResponse;
  try {
    summary = (await botRes.json()) as BotResponse;
  } catch (err) {
    console.error("bot response not json", err);
    return respond({ error: "upstream-error" }, 502);
  }

  let summaryId: number | undefined;
  if (session) {
    // Signed-in: backend's /api/library/add already saved to items and the
    // response includes the new id. No D1.anon_summaries write.
    summaryId = typeof summary.id === "number" ? summary.id : undefined;
  } else {
    // Anonymous: persist to D1.anon_summaries for later claim-on-signup.
    const nowIso = new Date().toISOString();
    try {
      const row = await env.DB.prepare(
        `INSERT INTO anon_summaries (anon_id, url, source_type, title, verdict, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
        .bind(
          anonId,
          url,
          typeof summary.source_type === "string" ? summary.source_type : null,
          typeof summary.title === "string" ? summary.title : null,
          typeof summary.verdict === "string" ? summary.verdict : null,
          JSON.stringify(summary),
          nowIso
        )
        .first<{ id: number }>();
      summaryId = row?.id;
    } catch (err) {
      // Don't fail the user-facing response — they still got a usable result.
      console.error("anon_summaries insert failed", err);
    }
  }

  return respond({
    ok: true,
    id: summaryId,
    summary,
    tries_used: limitInfo.used,
    tries_limit: limitInfo.limit,
    signed_in: !!session,
  });
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
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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
      .bind(sessionId)
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
      .bind(token, email, expiresIso, nowIso)
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

  let tokenRow: { email: string; expires_at: string; used_at: string | null } | null;
  try {
    tokenRow = await env.DB.prepare(
      `SELECT email, expires_at, used_at FROM login_tokens WHERE token = ?`
    )
      .bind(token)
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
      .bind(nowIso, token)
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
      .bind(sessionId, userId, email, sessionExpires, nowIso)
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
      await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
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
  let rows: LeanRow[] = [];
  try {
    const res = await fetch(
      `${backendBase(env.BOT_API_URL)}/api/library?user_id=${session.userId}`,
      {
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) {
      console.error("/api/me upstream non-ok", res.status);
      return json({ error: "upstream-error" }, 502);
    }
    rows = (await res.json()) as LeanRow[];
  } catch (err) {
    console.error("/api/me upstream failed", err);
    return json({ error: "upstream-unreachable" }, 502);
  }

  return json({
    ok: true,
    user: { email: session.email },
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

  try {
    const res = await fetch(
      `${backendBase(env.BOT_API_URL)}/api/library/${itemId}?user_id=${session.userId}`,
      {
        headers: { "x-filter-fyi-secret": env.BOT_API_KEY },
        signal: AbortSignal.timeout(5_000),
      }
    );
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

function randomTokenHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
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
