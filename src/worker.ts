interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const ALLOWED_CHALLENGES = new Set(["volume", "relevance", "fragmentation", "action"]);
const ALLOWED_SOURCES = new Set(["hero", "final-cta"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/waitlist" && req.method === "POST") {
      return handleWaitlist(req, env);
    }

    if (url.pathname === "/api/waitlist") {
      return json({ error: "method-not-allowed" }, 405);
    }

    return env.ASSETS.fetch(req);
  },
};

async function handleWaitlist(req: Request, env: Env): Promise<Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "expected-json" }, 415);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }

  // Honeypot: hidden field bots tend to fill. Real users leave it empty.
  // Return success so we don't tip them off.
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

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (email, challenges, source, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         challenges = excluded.challenges,
         source = excluded.source`
    )
      .bind(email, JSON.stringify(challenges), source, new Date().toISOString())
      .run();
  } catch (err) {
    console.error("waitlist insert failed", err);
    return json({ error: "storage-error" }, 500);
  }

  return json({ ok: true });
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
