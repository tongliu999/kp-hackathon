// One parser, three export formats. Shared by scripts/import-session.mjs and
// the vault, so a session imports identically through either entry point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookieText, normalizeCookie, parseNetscape, sameSite, SESSION_COOKIE } from "../cookie_formats.js";

test("Playwright storageState parses", () => {
  const text = JSON.stringify({ cookies: [{ name: "a", value: "1", domain: ".resy.com" }], origins: [] });
  assert.deepEqual(parseCookieText(text).map((c) => c.name), ["a"]);
});

test("a Cookie-Editor array parses", () => {
  const text = JSON.stringify([{ name: "a", value: "1", domain: ".resy.com", expirationDate: 1893456000 }]);
  assert.equal(normalizeCookie(parseCookieText(text)[0]).expires, 1893456000);
});

test("Netscape cookies.txt parses, comments and blank lines ignored", () => {
  const text = [
    "# Netscape HTTP Cookie File",
    "",
    ".resy.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\tabc123",
  ].join("\n");
  const [cookie] = parseCookieText(text);
  assert.deepEqual(cookie, {
    domain: ".resy.com", path: "/", secure: true, expires: 1893456000, name: "auth_token", value: "abc123",
  });
});

test("a cookies.txt value containing tabs is preserved whole", () => {
  const [cookie] = parseNetscape(".resy.com\tTRUE\t/\tTRUE\t0\tk\tva\tlue");
  assert.equal(cookie.value, "va\tlue");
});

test("an unrecognised file is refused rather than silently yielding nothing", () => {
  assert.throws(() => parseCookieText('{"notcookies": 1}'), /unrecognised cookie file/);
});

test("sameSite maps every spelling Chromium and the extensions use", () => {
  assert.equal(sameSite("no_restriction"), "None");
  assert.equal(sameSite("None"), "None");
  assert.equal(sameSite("strict"), "Strict");
  assert.equal(sameSite("unspecified"), "Lax");
  assert.equal(sameSite(undefined), "Lax");
});

test("SameSite=None is forced secure, or Chromium rejects the import", () => {
  assert.equal(normalizeCookie({ name: "a", value: "1", domain: ".x.test", sameSite: "no_restriction" }).secure, true);
});

test("a missing or nonsense expiry reads as a session cookie", () => {
  for (const expires of [undefined, null, 0, -5, "abc"]) {
    assert.equal(normalizeCookie({ name: "a", value: "1", domain: ".x.test", expires }).expires, SESSION_COOKIE);
  }
});
