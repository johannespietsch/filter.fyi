// DOM smoke tests for the /me library page — exercises the wiring that a
// syntax check can't: routing to the detail view, the now/later/never
// suggestion actions, the post-save follow-up, and the Shortlist pane.
//
// jsdom has no layout engine, so it can't catch CSS-visibility bugs (those
// need a real browser); these assert the JS behaviour via the `hidden`
// property and the fetch calls made.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "../public/me.html"), "utf8");
const mdSrc = fs.readFileSync(path.join(dir, "../public/md.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `pretendToBeVisual` registers rAF/timer machinery on `window` that keeps
// the event loop alive until the window is explicitly closed — without this,
// `node --test` hangs forever after the last assertion (never exits).
const openWindows = [];
after(() => { for (const w of openWindows) w.close(); });

// Boot me.html in jsdom with a stubbed backend; returns { window, doc, calls }.
async function boot(opts = {}) {
  const calls = [];
  // Mutable per-boot subscription store for the Channels pane tests.
  const subs = opts.subs ?? [
    { id: 5, feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCx", title: "Some Creator", source_kind: "youtube", last_polled_at: "", created_at: "2026-06-10T10:00:00" },
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/me",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, init = {}) => {
        const method = init.method || "GET";
        calls.push(`${method} ${url}`);
        const ok = (body) => ({ status: 200, ok: true, json: async () => body });
        if (url === "/api/v1/me")
          return ok({
            ok: true,
            user: { email: "x@y.z", telegram_linked: false, profile: opts.profile ?? "" },
            summaries: [{ id: 7, url: "https://example.com/a", source_type: "article", title: "First", verdict: "watch", created_at: "2026-06-01T10:00:00" }],
          });
        if (/\/api\/v1\/library\/\d+/.test(url))
          return ok({
            source: "https://example.com/a",
            content: "## H\n- b",
            analysis: JSON.stringify({ verdict: "watch", main_idea: "M", suggestions: [{ title: "Do X", detail: "Detail", effort: "a weekend", first_step: "step" }] }),
          });
        if (url === "/api/v1/subscriptions" && method === "POST") {
          if (opts.subscribeError) {
            return { status: 422, ok: false, json: async () => opts.subscribeError };
          }
          const created = { id: 6, feed_url: "https://blog.example/feed.xml", title: "Example Blog", source_kind: "rss", last_polled_at: "", created_at: "2026-06-11T10:00:00" };
          subs.push(created);
          return { status: 201, ok: true, json: async () => created };
        }
        if (url === "/api/v1/subscriptions")
          return ok(subs.slice());
        if (/\/api\/v1\/subscriptions\/\d+/.test(url) && method === "DELETE") {
          const id = Number(url.split("/").pop());
          const i = subs.findIndex((s) => s.id === id);
          if (i >= 0) subs.splice(i, 1);
          return ok({ ok: true });
        }
        if (url === "/api/v1/stats")
          return ok(opts.stats ?? { month: { items: 0 }, all_time: { items: 0 } });
        if (url === "/api/v1/saved-suggestions" && method === "POST")
          return { status: 201, ok: true, json: async () => (opts.saveResponse ?? { id: 99, status: "saved" }) };
        if (url === "/api/v1/saved-suggestions")
          return ok(opts.shortlistRows ?? [{ id: 99, item_id: 7, suggestion_index: 0, title: "Do X", detail: "Detail", effort: "a weekend", first_step: "step", grounded_in: "", status: "saved", source: "https://example.com/a", item_title: "First", sources: [] }]);
        return ok({ ok: true });
      };
      window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const { window } = dom;
  openWindows.push(window);
  // The md module is a separate <script type=module src> jsdom won't fetch.
  window.renderMarkdown = new window.Function(
    mdSrc.replace(/export function renderMarkdown/, "function renderMarkdown").replace(/if \(typeof window[\s\S]*$/, "") + "\nreturn renderMarkdown;"
  )();
  await sleep(150); // let load() resolve
  return { window, doc: window.document, calls };
}

test("nav lists Shortlist and Channels between Library and Lens", async () => {
  const { doc } = await boot();
  const order = [...doc.querySelectorAll("#side-nav a")].map((a) => a.dataset.section);
  assert.deepEqual(order, ["library", "shortlist", "channels", "lens", "telegram", "account"]);
});

test("opening an item shows a suggestion box in the decide state", async () => {
  const { window, doc } = await boot();
  window.location.hash = "#item/7";
  await sleep(120);
  const box = doc.querySelector("#detail .sug");
  assert.ok(box, "suggestion box rendered");
  assert.equal(box.querySelector(".sug-decide").hidden, false);
  assert.equal(box.querySelector(".sug-saved").hidden, true);
});

test("later parks the suggestion and flips to the follow-up state", async () => {
  const { window, doc, calls } = await boot();
  window.location.hash = "#item/7";
  await sleep(120);
  const box = doc.querySelector("#detail .sug");
  box.querySelector(".sug-later").click();
  await sleep(80);
  assert.ok(calls.includes("POST /api/v1/saved-suggestions"), "POST sent");
  assert.equal(box.dataset.savedId, "99");
  assert.equal(box.querySelector(".sug-decide").hidden, true);
  assert.equal(box.querySelector(".sug-saved").hidden, false);
});

test("done advances status via PATCH and marks the chip", async () => {
  const { window, doc, calls } = await boot();
  window.location.hash = "#item/7";
  await sleep(120);
  const box = doc.querySelector("#detail .sug");
  box.querySelector(".sug-later").click();
  await sleep(80);
  box.querySelector('.sug-status[data-status="done"]').click();
  await sleep(50);
  assert.ok(calls.some((c) => c.startsWith("PATCH /api/v1/saved-suggestions/99")));
  assert.ok(box.querySelector('.sug-status[data-status="done"]').classList.contains("sent"));
});

test("now ▾ toggles the hand-off panel", async () => {
  const { window, doc } = await boot();
  window.location.hash = "#item/7";
  await sleep(120);
  const box = doc.querySelector("#detail .sug");
  box.querySelector(".sug-open").click();
  await sleep(20);
  assert.equal(box.querySelector(".sug-panel").hidden, false);
  assert.equal(box.querySelector(".sug-open").textContent, "now ▴");
});

test("Shortlist pane lists saved suggestions with a back-link", async () => {
  const { window, doc, calls } = await boot();
  window.location.hash = "#shortlist";
  await sleep(120);
  assert.ok(calls.includes("GET /api/v1/saved-suggestions"));
  const box = doc.querySelector("#shortlist-list .sl-entry .sug");
  assert.ok(box, "shortlist entry rendered");
  // Starts already-saved (decide hidden, follow-up shown).
  assert.equal(box.querySelector(".sug-decide").hidden, true);
  assert.equal(box.querySelector(".sug-saved").hidden, false);
  assert.equal(doc.querySelector(".sl-source").getAttribute("href"), "#item/7");
});

test("remove drops the entry and shows the empty state", async () => {
  const { window, doc, calls } = await boot();
  window.location.hash = "#shortlist";
  await sleep(120);
  doc.querySelector("#shortlist-list .sug-remove").click();
  await sleep(50);
  assert.ok(calls.some((c) => c.startsWith("DELETE /api/v1/saved-suggestions/99")));
  assert.equal(doc.querySelector("#shortlist-list .sl-entry"), null);
  assert.equal(doc.getElementById("shortlist-empty").hidden, false);
});

// --- Lens onboarding (first sign-in) ---

test("first boot with no lens routes to the Lens pane and shows the composer", async () => {
  const { window, doc } = await boot();
  assert.equal(window.location.hash, "#lens");
  assert.equal(doc.querySelector('[data-pane="lens"]').hidden, false);
  assert.equal(doc.getElementById("lens-onboard").hidden, false);
});

test("a user with a lens is neither routed nor shown the composer", async () => {
  const { window, doc } = await boot({ profile: "Backend engineer." });
  assert.equal(window.location.hash, "");
  assert.equal(doc.getElementById("lens-onboard").hidden, true);
});

test("draft my lens composes the answers into the editor", async () => {
  const { doc } = await boot();
  doc.getElementById("lens-q-role").value = "backend engineer";
  doc.getElementById("lens-q-goal").value = "production LLM features";
  doc.getElementById("lens-q-time").value = "two evenings a week";
  doc.getElementById("lens-compose").click();
  const v = doc.getElementById("profile-input").value;
  assert.match(v, /backend engineer/);
  assert.match(v, /production LLM features/);
  assert.match(v, /two evenings a week/);
});

test("skip for now remembers the offer and returns to the library", async () => {
  const { window, doc } = await boot();
  doc.getElementById("lens-skip").click();
  await sleep(20);
  assert.equal(window.location.hash, "#library");
  assert.equal(window.localStorage.getItem("fyi_lens_offered"), "1");
});

test("saving a lens retires the composer", async () => {
  const { doc } = await boot();
  doc.getElementById("profile-input").value = "ML engineer in fintech.";
  doc.getElementById("profile-save").click();
  await sleep(50);
  assert.equal(doc.getElementById("lens-onboard").hidden, true);
});

// --- Channels pane (channel monitoring) ---

test("channels pane lists followed feeds", async () => {
  const { window, doc, calls } = await boot({ profile: "set" });
  window.location.hash = "#channels";
  await sleep(120);
  assert.ok(calls.includes("GET /api/v1/subscriptions"));
  const row = doc.querySelector("#ch-list .ch-row");
  assert.ok(row, "channel row rendered");
  assert.equal(row.querySelector(".ch-title").textContent, "Some Creator");
  assert.equal(row.querySelector(".ch-kind").textContent, "youtube");
});

test("empty channel list shows the empty state", async () => {
  const { window, doc } = await boot({ profile: "set", subs: [] });
  window.location.hash = "#channels";
  await sleep(120);
  assert.equal(doc.getElementById("ch-empty").hidden, false);
  assert.equal(doc.getElementById("ch-list").hidden, true);
});

test("follow posts the URL and refreshes the list", async () => {
  const { window, doc, calls } = await boot({ profile: "set" });
  window.location.hash = "#channels";
  await sleep(120);
  doc.getElementById("ch-input").value = "https://blog.example";
  doc.getElementById("ch-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(80);
  assert.ok(calls.includes("POST /api/v1/subscriptions"));
  const titles = [...doc.querySelectorAll("#ch-list .ch-title")].map((el) => el.textContent);
  assert.deepEqual(titles, ["Some Creator", "Example Blog"]);
  assert.equal(doc.getElementById("ch-input").value, "");
});

test("a resolver error surfaces its message", async () => {
  const { window, doc } = await boot({
    profile: "set",
    subscribeError: { error: "invalid-feed", message: "No feed found at that URL." },
  });
  window.location.hash = "#channels";
  await sleep(120);
  doc.getElementById("ch-input").value = "https://nofeed.example";
  doc.getElementById("ch-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  await sleep(80);
  const err = doc.getElementById("ch-error");
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /No feed found/);
});

test("unfollow deletes and falls back to the empty state", async () => {
  const { window, doc, calls } = await boot({ profile: "set" });
  window.location.hash = "#channels";
  await sleep(120);
  doc.querySelector("#ch-list .ch-remove").click();
  await sleep(80);
  assert.ok(calls.some((c) => c.startsWith("DELETE /api/v1/subscriptions/5")));
  assert.equal(doc.querySelector("#ch-list .ch-row"), null);
  assert.equal(doc.getElementById("ch-empty").hidden, false);
});

// --- ROI strip (#53) ---

test("roi strip renders month numbers and hides on empty months", async () => {
  const { doc } = await boot({
    profile: "set",
    stats: { month: { items: 14, watch: 5, skim: 6, skip: 3, minutes_saved: 210,
                      suggestions_saved: 2, suggestions_tried: 1, suggestions_done: 3 } },
  });
  const strip = doc.getElementById("roi-strip");
  assert.equal(strip.hidden, false);
  assert.match(strip.textContent, /14.*reads filtered/);
  assert.match(strip.textContent, /~3\.5 hrs.*of skips not read/);
  assert.match(strip.textContent, /3.*actions done/);
});

test("roi strip stays hidden with no activity", async () => {
  const { doc } = await boot({ profile: "set", stats: { month: { items: 0 } } });
  assert.equal(doc.getElementById("roi-strip").hidden, true);
});
