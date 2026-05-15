#!/usr/bin/env node
// Local mock of the research-companion `/api/try` endpoint.
// Speaks the contract documented in the plan: shared-secret header in,
// structured analysis JSON out. Zero dependencies — Node built-ins only.
//
// Trigger error/edge cases via query params on the submitted URL:
//   ?mock=no-transcript   → 422 {error:"no-transcript"} (Worker maps to 415)
//   ?mock=500             → 500 server error
//   ?mock=slow            → 3s delay, then success
//   ?mock=invalid         → 400 {error:"invalid-url"}

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const SECRET = process.env.MOCK_BOT_SECRET ?? "local-dev-secret";

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
    "access-control-allow-origin": "*",
  });
  res.end(json);
}

function classify(url) {
  const u = url.toLowerCase();
  if (/youtu\.be|youtube\.com/.test(u)) return "youtube";
  if (/twitter\.com|x\.com/.test(u)) return "social";
  if (/\.pdf(\?|$)/.test(u)) return "pdf";
  return "article";
}

function buildSuccess(url, sourceType) {
  const samples = {
    article: {
      title: "The unreasonable effectiveness of small models for relevance ranking",
      verdict: "watch",
      main_idea:
        "Tiny models (sub-1B params) consistently outperform LLMs on focused ranking tasks once you fine-tune on real user signals.",
      why_it_matters:
        "If your product is drowning in content and you need a relevance layer, you don't need a frontier model — you need a small one trained on your own click data. This shifts the cost equation by ~100x.",
      category: "ml-engineering",
      suggested_experiment:
        "Try a 350M-param model fine-tuned on your last 30 days of click-through data; compare nDCG@10 to your current LLM-as-a-reranker.",
      time_required: "12 min read",
    },
    youtube: {
      title: "Why your second brain is a graveyard (and what to do about it)",
      verdict: "skim",
      main_idea:
        "Capture without action is hoarding. The fix is a forcing function: every saved item gets a one-line 'next action' or it gets deleted.",
      why_it_matters:
        "Most knowledge workers save 10x more than they ever revisit. A trivial process change recovers most of the value.",
      category: "productivity",
      suggested_experiment:
        "For one week, require yourself to write a single 'so what' sentence next to every item you save. Anything without one gets deleted at end of week.",
      time_required: "8 min watch",
    },
    social: {
      title: "Thread on agent eval harnesses",
      verdict: "skip",
      main_idea:
        "Engineer argues most public agent benchmarks are gameable; suggests private, task-specific evals instead.",
      why_it_matters:
        "Useful framing if you're building agents, but the thread is light on concrete examples — the linked blog post covers the same ground better.",
      category: "ai-evals",
      suggested_experiment:
        "Skip the thread; read the linked blog post directly. Try writing 3 task-specific evals for your own agent in under an hour.",
      time_required: "2 min read",
    },
    pdf: {
      title: "Attention Is All You Need — annotated re-read",
      verdict: "watch",
      main_idea:
        "Revisits the original Transformer paper with eight years of hindsight; flags which design choices held up and which got replaced.",
      why_it_matters:
        "If you've only read the paper once, the annotations surface what's still load-bearing vs. what was a historical artifact (e.g., specific positional encoding choices).",
      category: "ml-fundamentals",
      suggested_experiment:
        "Open the original paper alongside the annotations; spend 20 min on Section 3.2 and write down every choice that's been superseded.",
      time_required: "45 min read",
    },
  };
  const a = samples[sourceType] ?? samples.article;
  return {
    url,
    title: a.title,
    source_type: sourceType,
    image_urls:
      sourceType === "youtube"
        ? ["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]
        : [],
    content_preview:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod " +
      "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, " +
      "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo " +
      "consequat. (This is mock content_preview — real backend returns ~2000 chars.)",
    verdict: a.verdict,
    analysis: {
      main_idea: a.main_idea,
      why_it_matters: a.why_it_matters,
      category: a.category,
      suggested_experiment: a.suggested_experiment,
      time_required: a.time_required,
    },
  };
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${req.method} ${req.url}`);

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, service: "mock-bot" });
  }

  if (!(req.method === "POST" && req.url === "/api/try")) {
    return send(res, 404, { error: "not-found" });
  }

  const auth = req.headers["x-filter-fyi-secret"];
  if (auth !== SECRET) {
    return send(res, 401, { error: "unauthorized", message: "missing or wrong X-Filter-Fyi-Secret header" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid-json" });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    return send(res, 400, { error: "invalid-url", message: "url must start with http(s)://" });
  }

  // Trigger flags via the URL itself
  if (/mock=invalid\b/.test(url)) {
    return send(res, 400, { error: "invalid-url", message: "mock: forced invalid" });
  }
  if (/mock=500\b/.test(url)) {
    return send(res, 500, { error: "bot-error", message: "mock: forced 500" });
  }
  if (/mock=no-transcript\b/.test(url) || /\/no-transcript/.test(url)) {
    return send(res, 422, { error: "no-transcript", message: "no transcript available for this video" });
  }
  if (/mock=slow\b/.test(url)) {
    await new Promise((r) => setTimeout(r, 3000));
  }

  return send(res, 200, buildSuccess(url, classify(url)));
});

server.listen(PORT, () => {
  console.log(`mock-bot listening on http://localhost:${PORT}`);
  console.log(`  secret: ${SECRET}`);
  console.log(`  try:    curl -sX POST http://localhost:${PORT}/api/try \\`);
  console.log(`            -H 'content-type: application/json' \\`);
  console.log(`            -H 'x-filter-fyi-secret: ${SECRET}' \\`);
  console.log(`            -d '{"url":"https://example.com/post"}'`);
});
