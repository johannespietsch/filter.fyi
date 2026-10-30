// Unit tests for the brief disclosure label (public/brief-label.js).
// Run with `npm test` (node --test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { briefLabel, truncationNotice } from "../public/brief-label.js";

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

test("label says so when the source was cut to a size limit", () => {
  assert.equal(
    briefLabel("a b c", 17000, "youtube", 45000),
    "show our brief · 3 words (from the first 17,000 of 45,000 transcript words)",
  );
});

test("total equal to or below source_words is not a truncation", () => {
  assert.equal(
    briefLabel("a b", 1200, "article", 1200),
    "show our brief · 2 words (from 1,200 source words)",
  );
  assert.equal(truncationNotice(1200, 1200, "article"), "");
  assert.equal(truncationNotice(1200, null, "article"), "");
  assert.equal(truncationNotice(null, 5000, "article"), "");
});

test("truncation notice reports coverage", () => {
  assert.equal(
    truncationNotice(15000, 60000, "youtube"),
    "Partial read: this transcript is 60,000 words, longer than we can take in " +
      "at once, so the brief and verdict cover only the first 15,000 (25%).",
  );
  assert.match(truncationNotice(100, 400, "article"), /^Partial read: this text is 400 words/);
});
