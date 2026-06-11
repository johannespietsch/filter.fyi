// DOM smoke tests for the /me library page — exercises the wiring that a
// syntax check can't: routing to the detail view, the now/later/never
// suggestion actions, the post-save follow-up, and the Shortlist pane.
//
// jsdom has no layout engine, so it can't catch CSS-visibility bugs (those
// need a real browser); these assert the JS behaviour via the `hidden`
// property and the fetch calls made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "../public/me.html"), "utf8");
const mdSrc = fs.readFileSync(path.join(dir, "../public/md.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot me.html in jsdom with a stubbed backend; returns { window, doc, calls }.
async function boot(opts = {}) {
  const calls = [];
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
        if (url === "/api/v1/saved-suggestions" && method === "POST")
          return { status: 201, ok: true, json: async () => ({ id: 99, status: "saved" }) };
        if (url === "/api/v1/saved-suggestions")
          return ok([{ id: 99, item_id: 7, suggestion_index: 0, title: "Do X", detail: "Detail", effort: "a weekend", first_step: "step", grounded_in: "", status: "saved", source: "https://example.com/a", item_title: "First" }]);
        return ok({ ok: true });
      };
      window.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const { window } = dom;
  // The md module is a separate <script type=module src> jsdom won't fetch.
  window.renderMarkdown = new window.Function(
    mdSrc.replace(/export function renderMarkdown/, "function renderMarkdown").replace(/if \(typeof window[\s\S]*$/, "") + "\nreturn renderMarkdown;"
  )();
  await sleep(150); // let load() resolve
  return { window, doc: window.document, calls };
}

test("nav lists Shortlist between Library and Lens", async () => {
  const { doc } = await boot();
  const order = [...doc.querySelectorAll("#side-nav a")].map((a) => a.dataset.section);
  assert.deepEqual(order, ["library", "shortlist", "lens", "telegram", "account"]);
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
