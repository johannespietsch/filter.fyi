// Unit tests for the safe-subset Markdown renderer (public/md.js).
// Run with `npm test` (node --test). The renderer turns stored briefs into
// HTML on the /me detail view, so the security cases (no raw HTML, no unsafe
// link schemes) matter as much as the formatting ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/md.js";

test("headings render at the right level", () => {
  assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
  assert.equal(renderMarkdown("### Deeper"), "<h3>Deeper</h3>");
});

test("unordered and ordered lists", () => {
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
});

test("paragraphs split on blank lines, join wrapped lines", () => {
  assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>");
});

test("inline emphasis and code", () => {
  assert.equal(renderMarkdown("**bold**"), "<p><strong>bold</strong></p>");
  assert.equal(renderMarkdown("_em_"), "<p><em>em</em></p>");
  assert.equal(renderMarkdown("use `code` here"), "<p>use <code>code</code> here</p>");
});

test("snake_case is not italicised", () => {
  assert.equal(renderMarkdown("a snake_case_name x"), "<p>a snake_case_name x</p>");
});

test("digits surrounded by spaces are not eaten by the code-span sentinel", () => {
  // Regression: a naive ` N ` placeholder would swallow "3 apples".
  assert.equal(renderMarkdown("I have 3 apples and 5 pears"), "<p>I have 3 apples and 5 pears</p>");
});

test("code spans are not reprocessed for emphasis", () => {
  assert.equal(renderMarkdown("`a*b*c`"), "<p><code>a*b*c</code></p>");
});

test("blockquote and fenced code", () => {
  assert.equal(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(renderMarkdown("```\nx = 1\n```"), "<pre><code>x = 1</code></pre>");
});

test("fenced code is not emphasised and is escaped", () => {
  assert.equal(renderMarkdown("```\n<b>*x*</b>\n```"), "<pre><code>&lt;b&gt;*x*&lt;/b&gt;</code></pre>");
});

test("safe links get noopener/nofollow + target", () => {
  assert.equal(
    renderMarkdown("[site](https://example.com)"),
    '<p><a href="https://example.com" target="_blank" rel="noopener nofollow">site</a></p>'
  );
});

// --- security ------------------------------------------------------------

test("raw HTML in the source is escaped, never emitted", () => {
  assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("javascript: links never emit an anchor", () => {
  // No-paren form degrades cleanly; the paren form leaves stray text but the
  // security property that matters — no active link — holds for both.
  assert.equal(renderMarkdown("[x](javascript:alert)"), "<p>x</p>");
  const withParen = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!withParen.includes("<a "), "no anchor tag");
  assert.ok(!withParen.includes("href"), "no href");
});

test("data: links degrade to plain text", () => {
  assert.equal(renderMarkdown("[x](data:text/html,<script>)"), "<p>x</p>");
});

test("link text is escaped", () => {
  assert.equal(
    renderMarkdown('[<b>](https://e.com)'),
    '<p><a href="https://e.com" target="_blank" rel="noopener nofollow">&lt;b&gt;</a></p>'
  );
});

test("null/empty input is safe", () => {
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown(""), "");
});

test("GFM pipe table renders thead/tbody with cells", () => {
  const md = "| Model | Score |\n| --- | --- |\n| GPT | 9 |\n| Claude | 10 |";
  assert.equal(
    renderMarkdown(md),
    "<table><thead><tr><th>Model</th><th>Score</th></tr></thead>" +
      "<tbody><tr><td>GPT</td><td>9</td></tr><tr><td>Claude</td><td>10</td></tr></tbody></table>"
  );
});

test("table column alignment comes from the delimiter row", () => {
  const md = "| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |";
  const html = renderMarkdown(md);
  assert.match(html, /<th style="text-align:left">L<\/th>/);
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
  assert.match(html, /<td style="text-align:center">b<\/td>/);
});

test("table cells are inline-formatted and escaped", () => {
  const md = "| A | B |\n| --- | --- |\n| **bold** | <img> |";
  const html = renderMarkdown(md);
  assert.match(html, /<td><strong>bold<\/strong><\/td>/);
  assert.match(html, /<td>&lt;img&gt;<\/td>/);
  assert.ok(!html.includes("<img>"), "raw HTML never emitted");
});

test("ragged body rows are padded/truncated to the header width", () => {
  const md = "| A | B |\n| --- | --- |\n| only-one |\n| x | y | z |";
  const html = renderMarkdown(md);
  assert.match(html, /<tr><td>only-one<\/td><td><\/td><\/tr>/); // padded
  assert.match(html, /<tr><td>x<\/td><td>y<\/td><\/tr>/);       // truncated
});

test("a paragraph immediately before a table is not swallowed", () => {
  const md = "intro line\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  const html = renderMarkdown(md);
  assert.match(html, /^<p>intro line<\/p>/);
  assert.match(html, /<table>/);
});

test("escaped pipes stay literal inside a cell", () => {
  const md = "| A | B |\n| --- | --- |\n| a \\| b | c |";
  assert.match(renderMarkdown(md), /<td>a \| b<\/td>/);
});

test("a pipe line without a delimiter row is just a paragraph", () => {
  assert.equal(renderMarkdown("a | b | c"), "<p>a | b | c</p>");
});
