// Tests for the pricing page (public/pricing.html): the founding-member form
// wiring, and the landing page's links into /pricing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pricingHtml = fs.readFileSync(path.join(dir, "../public/pricing.html"), "utf8");
const indexHtml = fs.readFileSync(path.join(dir, "../public/index.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootPricing(waitlistResponse = { status: 200, body: { ok: true } }) {
  const calls = [];
  const dom = new JSDOM(pricingHtml, {
    runScripts: "dangerously",
    url: "http://localhost/pricing",
    beforeParse(window) {
      window.fetch = async (url, opts = {}) => {
        calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
        return {
          ok: waitlistResponse.status < 400,
          status: waitlistResponse.status,
          json: async () => waitlistResponse.body,
        };
      };
    },
  });
  await sleep(30);
  return { doc: dom.window.document, window: dom.window, calls };
}

test("founding form posts email with source=pricing and shows the done state", async () => {
  const { doc, window, calls } = await bootPricing();
  doc.getElementById("founding-email").value = "founder@example.com";
  doc.getElementById("founding-form").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );
  await sleep(30);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/waitlist");
  assert.equal(calls[0].body.email, "founder@example.com");
  assert.equal(calls[0].body.source, "pricing");
  assert.equal(calls[0].body.website, "", "honeypot must be sent (empty for humans)");
  assert.equal(doc.getElementById("founding-form").hidden, true);
  assert.equal(doc.getElementById("founding-done").hidden, false);
});

test("a rejected email shows the error and keeps the form usable", async () => {
  const { doc, window } = await bootPricing({ status: 400, body: { error: "invalid-email" } });
  doc.getElementById("founding-email").value = "not-an-email";
  doc.getElementById("founding-form").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );
  await sleep(30);

  assert.equal(doc.getElementById("founding-form").hidden, false);
  assert.equal(doc.getElementById("founding-err").hidden, false);
  assert.equal(doc.getElementById("founding-btn").disabled, false);
});

test("pricing page states both tiers and the founding price", () => {
  assert.match(pricingHtml, /\$20<span class="per"> \/month<\/span>/);
  assert.match(pricingHtml, /\$10\/mo locked/);
  assert.match(pricingHtml, /channel monitoring/i);
  assert.match(pricingHtml, /MCP server \+ API/);
});

test("landing page links to /pricing in nav, footer, and the how-it-works strip", () => {
  const dom = new JSDOM(indexHtml);
  const hrefs = [...dom.window.document.querySelectorAll('a[href="/pricing"]')];
  assert.ok(hrefs.length >= 3, `expected >=3 pricing links, got ${hrefs.length}`);
  assert.ok(dom.window.document.querySelector(".how"), "how-it-works strip missing");
});
