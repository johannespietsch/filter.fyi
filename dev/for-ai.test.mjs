// The /for/ai spoke embeds the shared try-it (/try.js) with AI-flavoured
// persona labels over the same leader/explorer/builder keys, and pre-selects
// `builder` (the audience default). These assert that wiring.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const trySrc = fs.readFileSync(path.join(dir, "../public/try.js"), "utf8");
const html = fs
  .readFileSync(path.join(dir, "../public/for/ai.html"), "utf8")
  .replace('<script src="/try.js"></script>', `<script>${trySrc}</script>`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `pretendToBeVisual` registers rAF/timer machinery on `window` that keeps
// the event loop alive until the window is explicitly closed — without this,
// `node --test` hangs forever after the last assertion (never exits).
const openWindows = [];
after(() => { for (const w of openWindows) w.close(); });

async function boot() {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/for/ai",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, opts = {}) => {
        if (url === "/api/v1/me") return { ok: false, status: 401, json: async () => ({}) };
        calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
        return { status: 200, ok: true, json: async () => ({ pending: true, job_id: "j1" }) };
      };
    },
  });
  openWindows.push(dom.window);
  await sleep(60);
  return { doc: dom.window.document, window: dom.window, calls };
}

test("shows the three lenses with AI-flavoured labels", async () => {
  const { doc } = await boot();
  const cards = [...doc.querySelectorAll(".persona-card")];
  assert.equal(cards.length, 3);
  assert.deepEqual(
    cards.map((c) => c.dataset.persona).sort(),
    ["builder", "explorer", "leader"]
  );
  const text = doc.getElementById("persona-pick").textContent;
  assert.match(text, /Set the AI direction/);
  assert.match(text, /Get up to speed/);
  assert.match(text, /Build with it/);
});

test("pre-selects the builder lens (the /for/ai default)", async () => {
  const { doc } = await boot();
  const builder = doc.querySelector('.persona-card[data-persona="builder"]');
  assert.ok(builder.classList.contains("selected"), "builder card is selected by default");
  const others = doc.querySelectorAll('.persona-card[data-persona="leader"].selected, .persona-card[data-persona="explorer"].selected');
  assert.equal(others.length, 0, "only builder is selected");
});

test("submitting sends persona=builder to the same backend as the hub", async () => {
  const { doc, window, calls } = await boot();
  doc.getElementById("url").value = "https://example.com/release";
  doc.getElementById("try-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(20);
  const tryCall = calls.find((c) => c.url === "/api/v1/try");
  assert.ok(tryCall, "posts to /api/v1/try");
  assert.equal(tryCall.body.persona, "builder");
});

test("carries the full try-it scaffolding /try.js drives (no missing ids)", async () => {
  const { doc } = await boot();
  for (const id of ["try-form", "url", "loading", "result", "actions", "nudge-waitlist", "notice-error"]) {
    assert.ok(doc.getElementById(id), `#${id} present`);
  }
});
