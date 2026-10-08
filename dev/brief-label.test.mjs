// Unit tests for the brief disclosure label (public/brief-label.js).
// Run with `npm test` (node --test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { briefLabel } from "../public/brief-label.js";

test("shows brief and source counts when source_words is known", () => {
  assert.equal(
    briefLabel("a b c", 8185, "youtube"),
    "show our brief · 3 words (from 8,185 transcript words)",
  );
});

test("non-video sources are called 'source', not 'transcript'", () => {
  assert.equal(
    briefLabel("a b", 1200, "article"),
    "show our brief · 2 words (from 1,200 source words)",
  );
});

test("falls back to the brief count alone for older items", () => {
  assert.equal(briefLabel("a b", null, "youtube"), "show our brief · 2 words");
  assert.equal(briefLabel("a b", undefined, "article"), "show our brief · 2 words");
  assert.equal(briefLabel("a b", 0, "article"), "show our brief · 2 words");
});
