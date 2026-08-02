// Expiry is the refusal input. It must never report a dead session as live,
// and it must not invent an expiry it did not read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtExpiry, sessionExpiry, isExpired, describeRemaining } from "../expiry.js";
import { cookie, jwtWithExp } from "./fakes.js";

const HOUR = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);

test("a JWT's exp is read out of a bare cookie value", () => {
  assert.equal(jwtExpiry(jwtWithExp(1893456000)), 1893456000);
});

test("a JWT wrapped in URL encoding is still found", () => {
  assert.equal(jwtExpiry(encodeURIComponent(`{"token":"${jwtWithExp(1893456000)}"}`)), 1893456000);
});

test("a JWT embedded in a JSON cookie value is still found", () => {
  // Resy's auth cookie is a JSON blob carrying the refresh token, not a bare JWT.
  assert.equal(jwtExpiry(`{"refresh_token":"${jwtWithExp(1893456000)}","v":1}`), 1893456000);
});

test("a value that is not a JWT yields null rather than a guess", () => {
  for (const value of ["", "abc", "eyJ", "not.a.jwt", "eyJhbGci.notbase64!!.x"]) {
    assert.equal(jwtExpiry(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("a JWT with no exp claim yields null", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "nobody" })).toString("base64url");
  assert.equal(jwtExpiry(`${header}.${payload}.sig`), null);
});

test("a JWT exp beats cookie expiry — the token states its own lifetime", () => {
  const soon = nowSeconds() + HOUR;
  const { expiresAt, source } = sessionExpiry([
    cookie("auth", jwtWithExp(soon), { expires: nowSeconds() + 365 * 24 * HOUR }),
  ]);
  assert.equal(source, "jwt:exp");
  assert.equal(expiresAt, new Date(soon * 1000).toISOString());
});

test("with several tokens the earliest exp wins — each one is a credential", () => {
  const early = nowSeconds() + HOUR;
  const late = nowSeconds() + 10 * HOUR;
  const { expiresAt } = sessionExpiry([cookie("a", jwtWithExp(late)), cookie("b", jwtWithExp(early))]);
  assert.equal(expiresAt, new Date(early * 1000).toISOString());
});

test("with no token, the LATEST cookie expiry is the upper bound", () => {
  // Earliest would let a short-lived analytics cookie mark a live session dead.
  const late = nowSeconds() + 10 * HOUR;
  const { expiresAt, source } = sessionExpiry([
    cookie("analytics", "a".repeat(20), { expires: nowSeconds() + 60 }),
    cookie("auth", "b".repeat(20), { expires: late }),
  ]);
  assert.equal(source, "cookie:expires");
  assert.equal(expiresAt, new Date(late * 1000).toISOString());
});

test("session-only cookies report unknown, not infinite", () => {
  const { expiresAt, source } = sessionExpiry([cookie("s", "x".repeat(20))]);
  assert.equal(expiresAt, null);
  assert.equal(source, "session");
});

test("unknown expiry is not treated as expired", () => {
  assert.equal(isExpired(null), false);
});

test("expiry is inclusive at the boundary — a session expiring now is dead", () => {
  const at = new Date("2026-08-02T12:00:00Z");
  assert.equal(isExpired(at.toISOString(), at), true);
  assert.equal(isExpired(new Date(at.getTime() + 1000).toISOString(), at), false);
});

test("remaining time reads as names and dates, never a value", () => {
  const at = new Date("2026-08-02T12:00:00Z");
  assert.equal(describeRemaining(null, at), "unknown");
  assert.equal(describeRemaining("2026-08-02T11:00:00Z", at), "expired");
  assert.equal(describeRemaining("2026-08-02T12:30:00Z", at), "30m left");
  assert.equal(describeRemaining("2026-08-03T12:00:00Z", at), "24h left");
  assert.equal(describeRemaining("2026-08-12T12:00:00Z", at), "10d left");
});
