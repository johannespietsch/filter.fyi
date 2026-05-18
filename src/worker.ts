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
        <p style="margin:16px 0 0;font-family:${mono};font-size:11px;color:#9b9b91;">filter.fyi — relevant, not reactive.</p>
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
    "filter.fyi — relevant, not reactive.",
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
  analysis?: {
    main_idea?: string;
    why_it_matters?: string;
    category?: string;
    suggested_experiment?: string;
    time_required?: string;
  };
}

async function handleTry(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Get or mint anonymous device id (so a single browser's pre-signup
  // summaries can later be claimed by an account in Phase 2).
  const cookies = parseCookies(req.headers.get("cookie"));
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

  // Dual rate limit: cookie can be cleared trivially, so we also track per-IP.
  // IP cap is higher than anon so a shared NAT doesn't lock everyone out.
  // Over-limit attempts still consume a slot — that's the anti-abuse shape we want.
  const today = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  let anonCount = 0;
  let ipCount = 0;
  try {
    const anonRow = await env.DB.prepare(
      `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(`anon:${anonId}`, today)
      .first<{ count: number }>();
    anonCount = anonRow?.count ?? 0;
    const ipRow = await env.DB.prepare(
      `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(`ip:${ip}`, today)
      .first<{ count: number }>();
    ipCount = ipRow?.count ?? 0;
  } catch (err) {
    console.error("rate_limits upsert failed", err);
    return respond({ error: "storage-error" }, 500);
  }
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
  let botRes: Response;
  try {
    botRes = await fetch(env.BOT_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-filter-fyi-secret": env.BOT_API_KEY,
      },
      body: JSON.stringify({ url }),
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

  const nowIso = new Date().toISOString();
  let summaryId: number | undefined;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO summaries (anon_id, url, source_type, title, verdict, payload, created_at)
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
    console.error("summaries insert failed", err);
  }

  return respond({
    ok: true,
    id: summaryId,
    summary,
    tries_used: anonCount,
    tries_limit: ANON_DAILY_LIMIT,
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
