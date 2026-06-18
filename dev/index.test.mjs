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
async function boot(tryResponse = { status: 200, body: { pending: true, job_id: "j1" } }) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, opts = {}) => {
        if (url === "/api/v1/me") return { ok: false, status: 401, json: async () => ({}) };
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
  assert.deepEqual(tryCall.body, { url: "https://example.com/post" });
});

test("paste mode submits { text }", async () => {
  const { doc, window, calls } = await boot();
  doc.getElementById("mode-toggle").click();
  doc.getElementById("paste").value = "A pasted post about text-to-SQL benchmarks.";
  submit(doc, window);
  await sleep(20);
  const tryCall = calls.find((c) => c.url === "/api/v1/try");
  assert.deepEqual(tryCall.body, { text: "A pasted post about text-to-SQL benchmarks." });
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
