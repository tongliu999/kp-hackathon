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
// One parser, shared with the vault. Two copies drift, and the drift shows up
// as a session that imports through one entry point and not the other.
import { parseCookieText, normalizeCookie } from "../src/vault/cookie_formats.js";
import { cookiesForDomain } from "../src/vault/domains.js";

const PROBE_URL = process.env.BOOKING_PROBE_URL ?? DEFAULT_PROBE_URL;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
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

const raw = parseCookieText(readFileSync(file, "utf8")).map(normalizeCookie);
const wanted = cookiesForDomain(raw, domain);

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
