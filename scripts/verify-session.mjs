// TON-8 checks (a)-(d): does a real provider session survive Sail's lifecycle?
//
//   a) attach over CDP and assert authenticated
//   b) disconnect fully, re-check from a genuinely FRESH OS PROCESS
//   c) pause() -> resume() -> still authenticated      <- the one that matters
//   d) fork() -> child still authenticated, and is its egress IP different?
//
// Success is "the provider still accepts the session", never "a cookie file
// exists". A rejected cookie is byte-identical to a working one until the demo,
// so every leg asserts on something the SITE rendered.
//
// Usage:
//   node scripts/verify-session.mjs                     # oracle: resy DOM
//   node scripts/verify-session.mjs --oracle cookie:NAME # harness self-test
//   node scripts/verify-session.mjs --discover           # name the logged-in markers
//
// The cookie oracle exists so the harness's own mechanics -- pause, resume,
// fork, reconnect -- can be proven before a real login exists. It proves the
// plumbing, NOT that a provider accepts anything.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Sailbox } from "@sailresearch/sdk";
import { chromium } from "playwright";

const SELF = fileURLToPath(import.meta.url);
const BOX_NAME = process.env.BOOKING_BOX_NAME ?? "booking";
const CDP_URL = process.env.BOOKING_CDP_URL;
const PROBE_URL = process.env.BOOKING_PROBE_URL ?? "https://resy.com/cities/san-francisco-ca?date=2026-08-02&seats=2";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function findBox() {
  const boxes = await Sailbox.list({ limit: 100 });
  const box = boxes.find((b) => (b.name ?? "") === BOX_NAME && b.status !== "terminated");
  if (!box) throw new Error(`no live Sailbox named "${BOX_NAME}"`);
  return box;
}

/**
 * Ask the site whether it still knows who we are.
 *
 * Resy renders a "Log in" control only when signed out, so its ABSENCE after a
 * real page load is the signal. `--discover` exists because the positive
 * marker (account menu) can only be named once a real session exists -- run it
 * right after logging in and it will print the selector to pin here.
 */
async function isAuthenticated(context, oracle) {
  if (oracle.startsWith("cookie:")) {
    const name = oracle.slice("cookie:".length);
    const cookies = await context.cookies();
    return { ok: cookies.some((c) => c.name === name), detail: `cookie ${name}` };
  }

  const page = await context.newPage();
  try {
    await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(7000);
    const loginCount = await page.locator('[data-test-id="menu_container-button-log_in"]').count();
    return { ok: loginCount === 0, detail: `resy log_in control count=${loginCount}` };
  } finally {
    await page.close().catch(() => {});
  }
}

async function withBrowser(fn) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    return await fn(browser.contexts()[0], browser);
  } finally {
    // Disconnects the client; does not kill the box's browser.
    await browser.close().catch(() => {});
  }
}

async function discover() {
  await withBrowser(async (context) => {
    const page = await context.newPage();
    await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(7000);
    const found = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll("[data-test-id],[data-testid]").forEach((el) =>
        ids.add(el.getAttribute("data-test-id") ?? el.getAttribute("data-testid"))
      );
      return {
        accountish: [...ids].filter((i) => /menu|profile|account|avatar|user|log/i.test(i)),
        cookies: null,
      };
    });
    const cookies = await context.cookies("https://resy.com");
    console.log("candidate account markers:", found.accountish);
    console.log("cookie names:", cookies.map((c) => c.name).join(", "));
    await page.close();
  });
}

/** Leg (b): a separate OS process. In-process reconnect would prove nothing. */
function checkInFreshProcess(oracle) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, "--child-check", "--oracle", oracle], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => {
      const m = out.match(/CHILD_RESULT (true|false) (.*)/);
      resolve(m ? { ok: m[1] === "true", detail: m[2].trim() } : { ok: false, detail: out.trim().slice(0, 200) });
    });
  });
}

if (process.argv.includes("--child-check")) {
  const oracle = arg("--oracle") ?? "resy";
  const result = await withBrowser((ctx) => isAuthenticated(ctx, oracle));
  console.log(`CHILD_RESULT ${result.ok} ${result.detail}`);
  process.exit(0);
}

if (process.argv.includes("--discover")) {
  await discover();
  process.exit(0);
}

const oracle = arg("--oracle") ?? "resy";
if (!CDP_URL) throw new Error("BOOKING_CDP_URL is unset — run scripts/vnc-start.mjs first");

const results = [];
const record = (leg, ok, detail) => {
  results.push({ leg, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${leg}  — ${detail}`);
};

let box = await findBox();
console.log(`box ${box.sailboxId} (${box.status}), oracle=${oracle}\n`);

// (a) authenticated at all
{
  const r = await withBrowser((ctx) => isAuthenticated(ctx, oracle));
  record("(a) authenticated over CDP", r.ok, r.detail);
  if (!r.ok) {
    console.log("\nNo live session — (b)-(d) would all report a vacuous pass. Stopping.");
    process.exit(1);
  }
}

// (b) fresh process
{
  const r = await checkInFreshProcess(oracle);
  record("(b) fresh-process reconnect", r.ok, r.detail);
}

// (c) pause -> resume. THE ONE THAT MATTERS.
{
  const bootBefore = (await box.run("cat /proc/sys/kernel/random/boot_id", { timeout: 30_000 })).stdout.trim();
  await box.pause();
  await box.resume();
  box = await findBox();
  const bootAfter = (await box.run("cat /proc/sys/kernel/random/boot_id", { timeout: 60_000 })).stdout.trim();
  const warm = bootBefore === bootAfter;
  const r = await checkInFreshProcess(oracle);
  record("(c) pause -> resume", r.ok, `${r.detail}; ${warm ? "warm (memory restored)" : "COLD (rebooted)"}`);
}

// (d) fork: does the child inherit the session, and does its egress IP differ?
{
  const parentIp = (await box.run("curl -sS --max-time 15 https://ifconfig.me", { timeout: 40_000 })).stdout.trim();
  const child = await box.fork({ name: "booking-verify-fork" });
  try {
    const childIp = (await child.run("curl -sS --max-time 15 https://ifconfig.me", { timeout: 40_000 })).stdout.trim();

    // The child's CDP is not exposed, so the check runs INSIDE it.
    const script = `
const { chromium } = require("/root/booking/node_modules/playwright");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0];
  ${
    oracle.startsWith("cookie:")
      ? `const cs = await ctx.cookies(); console.log("CHILD_AUTH", cs.some(c => c.name === ${JSON.stringify(oracle.slice(7))}));`
      : `const p = await ctx.newPage();
  await p.goto(${JSON.stringify(PROBE_URL)}, { waitUntil: "domcontentloaded", timeout: 90000 });
  await p.waitForTimeout(7000);
  const n = await p.locator('[data-test-id="menu_container-button-log_in"]').count();
  console.log("CHILD_AUTH", n === 0, "log_in=" + n);
  await p.close();`
  }
  await b.close();
})();
`;
    await child.fs.write("/root/booking/verify_child.js", script);
    const out = await child.run("cd /root/booking && node verify_child.js 2>&1", { timeout: 180_000 });
    const ok = /CHILD_AUTH true/.test(out.stdout ?? "");
    record("(d) fork inherits session", ok, `${(out.stdout ?? "").trim().slice(0, 90)}`);
    record("(d) fork egress IP differs", parentIp !== childIp, `parent=${parentIp} child=${childIp}`);
  } finally {
    await child.terminate();
  }
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
