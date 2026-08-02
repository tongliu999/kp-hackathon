// Names, lengths and dates leave this process. Values do not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCookies, secretValues, redact, assertNoSecrets, guardedPrinter } from "../redact.js";
import { cookie } from "./fakes.js";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature";
const cookies = [cookie("auth_token", TOKEN, { expires: 1893456000 }), cookie("sid", "s".repeat(30))];

test("a cookie summary carries names, lengths and dates but no values", () => {
  const summary = summarizeCookies(cookies);
  assert.deepEqual(summary[0], {
    name: "auth_token",
    bytes: TOKEN.length,
    domain: ".resy.com",
    httpOnly: true,
    expires: new Date(1893456000 * 1000).toISOString(),
  });
  assert.ok(!JSON.stringify(summary).includes(TOKEN));
});

test("a session cookie's expiry reads as null, not as the epoch", () => {
  assert.equal(summarizeCookies([cookie("s", "x".repeat(20))])[0].expires, null);
});

test("redaction replaces a value with its length", () => {
  const line = redact(`Cookie: ${TOKEN}`, secretValues(cookies));
  assert.ok(!line.includes(TOKEN));
  assert.match(line, new RegExp(`«redacted:${TOKEN.length}b»`));
});

test("a short value that is a substring of a longer one does not leave a tail behind", () => {
  const values = ["abcdefghij", "abcdefghijKLMNOP"];
  const line = redact("token=abcdefghijKLMNOP", values);
  assert.ok(!line.includes("KLMNOP"));
});

test("flag-like short values are left alone, so ordinary prose is not blanked", () => {
  assert.deepEqual(secretValues([cookie("consent", "1"), cookie("tz", "UTC")]), []);
});

test("assertNoSecrets throws rather than letting a value through", () => {
  assert.throws(() => assertNoSecrets(`leak ${TOKEN}`, [TOKEN]), /refusing to emit output containing a \d+-byte credential/);
  assert.equal(assertNoSecrets("safe line", [TOKEN]), "safe line");
});

test("the guarded printer redacts every argument, including interpolated objects", () => {
  const lines = [];
  const print = guardedPrinter(secretValues(cookies), (line) => lines.push(line));
  print("installing", { name: "auth_token", value: TOKEN });
  print(`raw: ${TOKEN}`);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(!line.includes(TOKEN), `leaked: ${line}`);
});
