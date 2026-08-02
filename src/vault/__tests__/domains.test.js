// One rule: a credential only ever reaches the domain it belongs to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, domainMatches, cookiesForDomain, assertUrlBelongsTo } from "../domains.js";
import { cookie } from "./fakes.js";

test("domains normalise to a bare lowercase host", () => {
  for (const input of ["Resy.com", ".resy.com", "https://resy.com/cities/sf", "  resy.com "]) {
    assert.equal(normalizeDomain(input), "resy.com");
  }
});

test("an empty domain is an error, not a wildcard", () => {
  assert.throws(() => normalizeDomain(""), /domain is required/);
  assert.throws(() => normalizeDomain(null), /domain is required/);
});

test("subdomains match, lookalikes do not", () => {
  assert.equal(domainMatches("api.resy.com", "resy.com"), true);
  assert.equal(domainMatches(".resy.com", "resy.com"), true);
  // The suffix bug: endsWith("resy.com") would accept both of these.
  assert.equal(domainMatches("notresy.com", "resy.com"), false);
  assert.equal(domainMatches("evil-resy.com", "resy.com"), false);
  assert.equal(domainMatches("resy.com.evil.test", "resy.com"), false);
});

test("cookie filtering keeps only the domain's own cookies", () => {
  const mixed = [
    cookie("a", "x".repeat(20)),
    cookie("b", "x".repeat(20), { domain: "api.resy.com" }),
    cookie("c", "x".repeat(20), { domain: ".notresy.com" }),
    cookie("d", "x".repeat(20), { domain: ".example.com" }),
  ];
  assert.deepEqual(cookiesForDomain(mixed, "resy.com").map((c) => c.name), ["a", "b"]);
});

test("a URL off the domain is refused by name", () => {
  assert.throws(() => assertUrlBelongsTo("https://evil.test/x", "resy.com"), /refusing to use a resy\.com session against evil\.test/);
  assert.throws(() => assertUrlBelongsTo("https://resy.com.evil.test/", "resy.com"), /refusing/);
  assert.ok(assertUrlBelongsTo("https://api.resy.com/4/find", "resy.com"));
});

test("a malformed URL is an error, not a pass", () => {
  assert.throws(() => assertUrlBelongsTo("not a url", "resy.com"), /not a URL/);
});
