// Move a browser session INTO the booking Sailbox (TON-8).
//
// Why this exists: Resy's auth endpoints refuse Sail's egress. Identical
// request, only the source IP differing --
//
//     OPTIONS /4/auth/mobile     box 500 (no CORS headers)   residential 204
//     OPTIONS /3/auth/password   box 500                     residential 204
//     OPTIONS /4/find            box 204                     residential 204
//
// so logging in FROM the box is impossible no matter the credentials, while
// everything else works normally. The way round it is to authenticate on a
// residential IP and carry the session in. That is sound precisely because the
// non-auth endpoints are not blocked.
//
// The cookies land in the running browser's store, which belongs to the
// persistent on-disk profile at /root/booking/profile -- so the session
// survives pause/resume and fork exactly like a natively-created one, which is
// what TON-8 is actually trying to establish.
//
//   node scripts/import-session.mjs <cookies.json> [--domain resy.com] [--forget]
//
// Accepts Playwright storageState, Cookie-Editor / EditThisCookie exports, and
// Netscape cookies.txt.
//
// SECRETS. A session cookie is credential-equivalent: anyone holding it is
// logged in as that user. This script never prints cookie values, imports only
// the domain you ask for, and `--forget` overwrites and deletes the input file
// afterwards. Log the session out when the demo is done.

import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { chromium } from "playwright";
import { checkSession, DEFAULT_PROBE_URL } from "./session-check.mjs";

const PROBE_URL = process.env.BOOKING_PROBE_URL ?? DEFAULT_PROBE_URL;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Chromium's spellings vs Playwright's. Getting this wrong makes addCookies throw. */
function sameSite(value) {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "strict") return "Strict";
  if (raw === "none" || raw === "no_restriction") return "None";
  if (raw === "lax") return "Lax";
  return "Lax"; // "unspecified"/absent -- Chromium's own default
}

function expiry(cookie) {
  const value = cookie.expires ?? cookie.expirationDate ?? cookie.expiry;
  if (value == null) return -1; // session cookie
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return -1;
  return Math.floor(seconds);
}

function normalize(cookie) {
  const site = sameSite(cookie.sameSite);
  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain ?? "").trim(),
    path: cookie.path || "/",
    expires: expiry(cookie),
    httpOnly: Boolean(cookie.httpOnly),
    // SameSite=None is only honoured on a secure cookie; Chromium rejects the
    // combination otherwise, and the import fails on a detail nobody would
    // suspect.
    secure: site === "None" ? true : Boolean(cookie.secure),
    sameSite: site,
  };
}

/** Netscape cookies.txt: domain, includeSub, path, secure, expiry, name, value */
function parseNetscape(text) {
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    cookies.push({
      domain: f[0], path: f[2], secure: f[3] === "TRUE",
      expires: Number(f[4]), name: f[5], value: f.slice(6).join("\t"),
    });
  }
  return cookies;
}

function load(path) {
  const text = readFileSync(path, "utf8");
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    return parseNetscape(text);
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed; // Cookie-Editor et al
  if (Array.isArray(parsed.cookies)) return parsed.cookies; // Playwright storageState
  throw new Error("unrecognised cookie file: expected an array, {cookies:[…]}, or cookies.txt");
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: node scripts/import-session.mjs <cookies.json> [--domain resy.com] [--forget]");
  process.exit(2);
}
const endpoint = process.env.BOOKING_CDP_URL;
if (!endpoint) {
  console.error("BOOKING_CDP_URL is unset — run `node scripts/vnc-start.mjs` first");
  process.exit(2);
}
const domain = arg("--domain", "resy.com");

const raw = load(file);
const wanted = raw
  .map(normalize)
  .filter((c) => c.name && c.domain.replace(/^\./, "").endsWith(domain));

if (wanted.length === 0) {
  console.error(`no cookies for ${domain} in ${file} (file had ${raw.length} total)`);
  process.exit(1);
}

const sessionOnly = wanted.filter((c) => c.expires === -1).length;
console.log(`importing ${wanted.length} ${domain} cookies (${sessionOnly} session-scoped)`);
// Names only. Values are the secret.
console.log(`names: ${wanted.map((c) => c.name).join(", ")}`);

const browser = await chromium.connectOverCDP(endpoint);
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error("no browser context in the box");

  // Clear existing cookies for the domain first: a stale pre-login cookie
  // surviving alongside the imported ones is exactly the sort of thing that
  // makes a session look valid and behave logged-out.
  await context.clearCookies({ domain: `.${domain}` }).catch(() => {});
  await context.clearCookies({ domain }).catch(() => {});

  await context.addCookies(wanted);
  console.log("cookies installed into the box's persistent profile");

  // The only success criterion that means anything: the provider still accepts
  // it. A cookie that is present but rejected looks identical to a working one
  // until the demo.
  const { state, detail } = await checkSession(context, { probeUrl: PROBE_URL });
  if (state === "authenticated") {
    console.log(`\nAUTHENTICATED — the site accepts the imported session. (${detail})`);
    console.log("next: node scripts/verify-session.mjs   (checks a–d)");
  } else if (state === "logged-out") {
    console.log(`\nNOT AUTHENTICATED — cookies installed, but Resy still shows a login control. (${detail})`);
    console.log("Likely causes, in order:");
    console.log("  1. the export missed HttpOnly cookies (many extensions do) — re-export including them");
    console.log("  2. the session is bound to the origin IP or device fingerprint");
    console.log("  3. the exported session was already logged out or expired");
    process.exitCode = 1;
  } else {
    console.log(`\nINCONCLUSIVE — ${detail}`);
    console.log("Refusing to call this authenticated: absence of a login control is not proof.");
    process.exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
}

if (process.argv.includes("--forget")) {
  try {
    writeFileSync(file, "\0".repeat(statSync(file).size));
    unlinkSync(file);
    console.log(`\n${file} overwritten and deleted`);
  } catch (error) {
    console.error(`could not remove ${file}: ${error.message} — delete it by hand`);
  }
}
