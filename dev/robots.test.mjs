// robots.txt and sitemap.xml are static assets in public/. Cloudflare's
// managed robots.txt only prepends a comment preamble, so the User-agent
// group has to come from this file — without it the agent-readiness scan
// (isitagentready.com) fails robots.txt as invalid.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pub = (f) => path.join(dir, "../public", f);
const robots = fs.readFileSync(pub("robots.txt"), "utf8");
const sitemap = fs.readFileSync(pub("sitemap.xml"), "utf8");

test("robots.txt has a User-agent group with rules", () => {
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
});

test("robots.txt keeps crawlers off the API and signed-in pages", () => {
  for (const p of ["/api/", "/me", "/login"]) {
    assert.match(robots, new RegExp(`^Disallow: ${p}$`, "m"));
  }
});

test("robots.txt points at the sitemap, which exists", () => {
  assert.match(robots, /^Sitemap: https:\/\/filter\.fyi\/sitemap\.xml$/m);
  assert.ok(fs.existsSync(pub("sitemap.xml")));
});

test("every sitemap URL maps to a page in public/", () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0);
  for (const loc of locs) {
    const p = new URL(loc).pathname;
    const file = p.endsWith("/") ? `${p}index.html` : `${p}.html`;
    assert.ok(fs.existsSync(pub(file.slice(1))), `${loc} → public${file} missing`);
  }
});

test("sitemap never lists disallowed paths", () => {
  assert.doesNotMatch(sitemap, /\/(api|me|login)\b/);
});
