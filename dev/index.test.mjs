// DOM smoke tests for the landing page's URL ⇆ paste-text input modes (#67).
// jsdom can't see layout, so we assert the JS wiring: which row is shown, what
// body the submit sends, and the post-failure paste nudge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "../public/index.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot index.html with a stubbed /api/v1/try; `tryResponse` controls the reply.
// `signedIn` makes /api/v1/me return a user (drops the anon-only persona picker).
async function boot(tryResponse = { status: 200, body: { pending: true, job_id: "j1" } }, signedIn = false) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, opts = {}) => {
        if (url === "/api/v1/me") {
          return signedIn
            ? { ok: true, status: 200, json: async () => ({ user: { email: "x@y.z", profile: "" } }) }
            : { ok: false, status: 401, json: async () => ({}) };
        }
        calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
        return { status: tryResponse.status, ok: tryResponse.status < 400,
                 json: async () => tryResponse.body };
      };
    },
  });
  await sleep(60);
  return { doc: dom.window.document, window: dom.window, calls };
}

function submit(doc, window) {
  doc.getElementById("try-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
}

test("defaults to URL mode", async () => {
  const { doc } = await boot();
  assert.equal(doc.getElementById("url-row").hidden, false);
  assert.equal(doc.getElementById("paste-row").hidden, true);
});

test("the [hidden] paste row is actually display:none, not just attr-hidden", async () => {
  // The rows set display:flex via a class, which overrides the UA [hidden]
  // rule — so the attribute alone leaves both rows visible. Pin that the
  // global `[hidden]{display:none!important}` guard is in effect.
  const { doc, window } = await boot();
  const pasteRow = doc.getElementById("paste-row");
  assert.equal(window.getComputedStyle(pasteRow).display, "none");
  doc.getElementById("mode-toggle").click();
  assert.equal(window.getComputedStyle(pasteRow).display, "flex");
  assert.equal(window.getComputedStyle(doc.getElementById("url-row")).display, "none");
});

test("toggle switches to paste mode and back", async () => {
  const { doc } = await boot();
  const toggle = doc.getElementById("mode-toggle");
  toggle.click();
  assert.equal(doc.getElementById("url-row").hidden, true);
  assert.equal(doc.getElementById("paste-row").hidden, false);
  assert.match(toggle.textContent, /back to a URL/);
  toggle.click();
  assert.equal(doc.getElementById("url-row").hidden, false);
});

test("URL mode submits { url }", async () => {
  const { doc, window, calls } = await boot();
  doc.getElementById("url").value = "https://example.com/post";
  submit(doc, window);
  await sleep(20);
  const tryCall = calls.find((c) => c.url === "/api/v1/try");
  assert.deepEqual(tryCall.body, { url: "https://example.com/post", persona: "" });
});

test("paste mode submits { text }", async () => {
  const { doc, window, calls } = await boot();
  doc.getElementById("mode-toggle").click();
  doc.getElementById("paste").value = "A pasted post about text-to-SQL benchmarks.";
  submit(doc, window);
  await sleep(20);
  const tryCall = calls.find((c) => c.url === "/api/v1/try");
  assert.deepEqual(tryCall.body, { text: "A pasted post about text-to-SQL benchmarks.", persona: "" });
});

test("empty submit does not call the API", async () => {
  const { doc, window, calls } = await boot();
  submit(doc, window); // URL mode, empty
  await sleep(20);
  assert.equal(calls.filter((c) => c.url === "/api/v1/try").length, 0);
});

test("a fetch failure nudges toward paste mode", async () => {
  const { doc, window } = await boot({ status: 422, body: { message: "Reddit blocks…" } });
  doc.getElementById("url").value = "https://www.reddit.com/r/x/comments/abc/t/";
  submit(doc, window);
  await sleep(20);
  assert.match(doc.getElementById("mode-toggle").textContent, /paste the text instead/);
});

// --- anon persona picker (#72) ---

test("three persona cards are shown for anon", async () => {
  const { doc } = await boot();
  const keys = [...doc.querySelectorAll(".persona-card")].map((c) => c.dataset.persona);
  assert.deepEqual(keys, ["leader", "explorer", "builder"]);
});

test("selecting a persona highlights it and persists", async () => {
  const { doc, window } = await boot();
  doc.querySelector('.persona-card[data-persona="explorer"]').click();
  assert.ok(doc.querySelector('.persona-card[data-persona="explorer"]').classList.contains("selected"));
  assert.equal(window.localStorage.getItem("fyi_persona"), "explorer");
});

test("the selected persona is sent with the try request", async () => {
  const { doc, window, calls } = await boot();
  doc.querySelector('.persona-card[data-persona="leader"]').click();
  doc.getElementById("url").value = "https://example.com/x";
  submit(doc, window);
  await sleep(20);
  const tryCall = calls.find((c) => c.url === "/api/v1/try");
  assert.equal(tryCall.body.persona, "leader");
  assert.equal(tryCall.body.url, "https://example.com/x");
});

test("no selection sends an empty persona", async () => {
  const { doc, window, calls } = await boot();
  doc.getElementById("url").value = "https://example.com/x";
  submit(doc, window);
  await sleep(20);
  assert.equal(calls.find((c) => c.url === "/api/v1/try").body.persona, "");
});

test("clicking the selected persona again clears it", async () => {
  const { doc, window } = await boot();
  const card = doc.querySelector('.persona-card[data-persona="builder"]');
  card.click();
  card.click();
  assert.ok(!card.classList.contains("selected"));
  assert.equal(window.localStorage.getItem("fyi_persona"), null);
});

test("signed-in users don't see the persona picker", async () => {
  const { doc } = await boot(undefined, true);
  assert.equal(doc.getElementById("persona-pick"), null);
});

// --- "what we read" brief renders Markdown (#74) ---
// The renderer itself is covered in md.test.mjs; here we pin the wiring that
// regressed: md.js loaded, the brief container is .md, and it's rendered
// through md() rather than textContent. (Driving the full job-poll flow is
// flaky on the 2s interval, and jsdom doesn't load the md.js module.)

test("landing page wires the Markdown renderer for the brief", async () => {
  assert.match(html, /<script type="module" src="\/md\.js">/);
  assert.match(html, /<div class="brief-body md" id="brief-body">/);
  assert.match(html, /getElementById\('brief-body'\)\.innerHTML = md\(brief\)/);
  assert.ok(!/getElementById\('brief-body'\)\.textContent = brief/.test(html),
    "brief must not be rendered as plain text");
});

// --- lens colours (#75) ---

test("each persona card carries its own lens hue at rest", async () => {
  // The per-card gel vars drive the border-top + selected fill; pin they're wired.
  assert.match(html, /persona-card\[data-persona="leader"\][^}]*--lens-leader/);
  assert.match(html, /persona-card\[data-persona="explorer"\][^}]*--lens-explorer/);
  assert.match(html, /persona-card\[data-persona="builder"\][^}]*--lens-builder/);
});

test("selecting a persona shifts the active --lens, deselecting reverts", async () => {
  const { doc } = await boot();
  const root = doc.documentElement.style;
  assert.equal(root.getPropertyValue("--lens"), ""); // default comes from :root (green)
  doc.querySelector('.persona-card[data-persona="explorer"]').click();
  assert.equal(root.getPropertyValue("--lens"), "var(--lens-explorer)");
  assert.equal(root.getPropertyValue("--lens-soft"), "var(--lens-explorer-soft)");
  doc.querySelector('.persona-card[data-persona="explorer"]').click(); // deselect
  assert.equal(root.getPropertyValue("--lens"), "");
});

// --- focus-driven hero (#75) ---

function focusin(doc, window, el) {
  el.focus();
  el.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
}
function focusout(doc, window, el) {
  el.blur();
  doc.body.focus();
  el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: doc.body }));
}

test("hero starts un-focused (pitch shown, picker collapsed)", async () => {
  const { doc } = await boot();
  assert.ok(!doc.getElementById("hero").classList.contains("focused"));
});

test("focusing the URL bar expands the hero", async () => {
  const { doc, window } = await boot();
  focusin(doc, window, doc.getElementById("url"));
  assert.ok(doc.getElementById("hero").classList.contains("focused"));
});

test("leaving an empty, idle form collapses back to the pitch", async () => {
  const { doc, window } = await boot();
  const url = doc.getElementById("url");
  focusin(doc, window, url);
  focusout(doc, window, url);
  await sleep(10);
  assert.ok(!doc.getElementById("hero").classList.contains("focused"));
});

test("a typed URL keeps the hero expanded on blur", async () => {
  const { doc, window } = await boot();
  const url = doc.getElementById("url");
  focusin(doc, window, url);
  url.value = "https://example.com/x";
  focusout(doc, window, url);
  await sleep(10);
  assert.ok(doc.getElementById("hero").classList.contains("focused"));
});

test("an on-screen result keeps the hero expanded on blur", async () => {
  const { doc, window } = await boot();
  const url = doc.getElementById("url");
  focusin(doc, window, url);
  doc.getElementById("loading").classList.add("visible"); // simulate in-flight
  focusout(doc, window, url);
  await sleep(10);
  assert.ok(doc.getElementById("hero").classList.contains("focused"));
});

test("focus actually collapses the pitch and reveals the picker (computed style)", async () => {
  const { doc, window } = await boot();
  const gtr = (id) => window.getComputedStyle(doc.getElementById(id)).gridTemplateRows;
  assert.equal(gtr("hero-copy"), "1fr");      // pitch shown at rest
  assert.equal(gtr("persona-pick"), "0fr");   // picker hidden at rest
  doc.getElementById("hero").classList.add("focused");
  assert.equal(gtr("hero-copy"), "0fr");      // pitch collapsed
  assert.equal(gtr("persona-pick"), "1fr");   // picker revealed
});
