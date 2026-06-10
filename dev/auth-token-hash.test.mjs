// Contract test for the at-rest hashing of magic-link + session tokens.
//
// worker.ts stores only SHA-256(token) in D1 (login_tokens.token, sessions.id)
// while the plaintext lives solely in the emailed link / the cookie. The
// worker module isn't importable from this node:test harness (it's a
// TypeScript Cloudflare module), so this re-declares the same one-liner and
// pins the *contract* the worker's hashToken() must satisfy: a deterministic
// lowercase-hex SHA-256. If anyone changes the encoding (e.g. to base64) or
// the algorithm, the stored value would no longer match isValidToken's shape
// or the existing column — these assertions catch that.

import { test } from "node:test";
import assert from "node:assert/strict";

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same format guard the worker applies to incoming cookie/url tokens.
const isValidToken = (s) => /^[0-9a-f]{32,128}$/.test(s);

test("matches the known SHA-256 vector for 'abc'", async () => {
  assert.equal(
    await hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("output is 64 lowercase hex chars (same shape as randomTokenHex(32))", async () => {
  const h = await hashToken("deadbeef".repeat(8));
  assert.equal(h.length, 64);
  assert.ok(isValidToken(h), "hash must satisfy the token format guard");
});

test("is deterministic", async () => {
  const tok = "a".repeat(64);
  assert.equal(await hashToken(tok), await hashToken(tok));
});

test("hash differs from the plaintext (the whole point of storing at rest)", async () => {
  const tok = "f".repeat(64);
  assert.notEqual(await hashToken(tok), tok);
});

test("distinct tokens hash to distinct values", async () => {
  assert.notEqual(await hashToken("a".repeat(64)), await hashToken("b".repeat(64)));
});
