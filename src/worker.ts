interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FROM_EMAIL?: string;
  REPLY_TO_EMAIL?: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL?: string;
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/waitlist") {
      if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405);
      return handleWaitlist(req, env, ctx);
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
    }),
  ];

  if (env.NOTIFY_EMAIL) {
    tasks.push(
      sendEmail(env, {
        to: env.NOTIFY_EMAIL,
        subject: `New filter.fyi signup — ${signup.email}`,
        html: notificationEmail(signup),
      })
    );
  }

  await Promise.allSettled(tasks);
}

async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; html: string }
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
