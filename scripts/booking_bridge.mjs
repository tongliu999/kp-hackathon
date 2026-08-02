#!/usr/bin/env node
// Track A (Python) <-> Track C (JavaScript) seam.
//
// Reads ONE JSON request on stdin, writes ONE JSON response on stdout, exits.
// One process per step: the booking modules keep no in-memory state worth
// preserving between steps (the booking store is on disk), and a short-lived
// process cannot leak a half-open browser session between runs.
//
//   in : {"action": "...", "arguments": {...}, "confirmed": false}
//   out: {"ok": true,  "result": {...}}
//        {"ok": false, "error": "...", "type": "ErrorName"}
//
// CONFIRMATION POLICY - the important part.
// There are two confirmation gates in this system: RunbookExecutor._confirm()
// on the Python side (spoken, templated readback, exact-yes) and confirmGate()
// inside bookStep(). Invariant 1 wants exactly ONE decision point, and the
// spoken one is the real one - it is what a human actually hears and answers.
//
// So Python is authoritative and this bridge REFUSES any irreversible action
// unless the caller passes confirmed:true, which NodeBookingRunner only sends
// when it was constructed with confirmation_is_upstream=True. Absent that flag
// this endpoint cannot book, which keeps a direct/scripted caller fail-closed.
// bookStep's own gate is then satisfied with the decision already obtained
// rather than asking a second time - a second prompt after the user already
// said yes reads as a bug on stage and trains people to double-approve.

import { bookStep } from "../src/booking/book.js";
import { resetAll } from "../src/booking/resetScript.js";
import { listOpenBookings } from "../src/booking/store.js";
import { isStubMode } from "../src/booking/stubMode.js";
import { getProvider } from "../src/booking/providers/index.js";

const IRREVERSIBLE = new Set(["restaurant.book"]);

/** snake_case from the runbook -> camelCase the booking modules expect. */
function camel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Map runbook arguments onto bookStep params.
 *
 * The runbook supplies {cuisine, city, date, time, party_size}; bookStep needs
 * {restaurant, date, time, partySize}. There is no `restaurant` slot because
 * the caller does not know one yet - picking it is the *search's* job.
 *
 * `restaurant` is therefore the provider's search term, and OpenTable's own
 * field is "location, restaurant, or cuisine", so a cuisine is a legitimate
 * value for it. We prefer an explicit `restaurant` when a synthesized runbook
 * provides one (TON-21 may lift a concrete name into a slot), and fall back to
 * cuisine. If neither exists we refuse rather than searching for "undefined".
 */
function toBookingParams(args) {
  const params = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    params[camel(key)] = value;
  }
  if (!params.restaurant) {
    if (!params.cuisine) {
      throw new Error(
        "cannot determine a search term: runbook supplied neither `restaurant` nor `cuisine`"
      );
    }
    params.restaurant = params.cuisine;
  }
  if (params.partySize != null) params.partySize = String(params.partySize);
  return params;
}

/**
 * This process is either running on the laptop (default) or has been
 * re-invoked INSIDE the persistent "booking" Sailbox by delegateToSailbox()
 * below. Only the in-box copy can reach the browser: the Sailbox's Chromium
 * exposes its debug port on 127.0.0.1 only, deliberately never on a public
 * interface, because CDP has no built-in auth of its own - whoever can reach
 * it fully controls the browser, cookies and all. Tunneling that out to the
 * open internet (the way the VNC bridge did for a *password-protected*
 * viewer) is not a tradeoff worth making for this.
 */
const INSIDE_SAILBOX = process.env.BOOKING_BRIDGE_INSIDE_SAILBOX === "1";

/**
 * Reuses exactly one tab in the persistent session, closing any others.
 *
 * The box stays up across every rehearsal and every step within a run, and
 * nothing here ever closes a tab it opened - so stray tabs from a previous
 * step (or from interactive debugging against this same box) accumulate.
 * Found live: 5 open tabs, one on a chrome-error page, turned a 1s navigation
 * into a 30s timeout. Enforcing a single tab is cheap insurance against that
 * recurring during a rehearsal.
 */
async function acquirePage() {
  if (!INSIDE_SAILBOX) {
    throw new Error("acquirePage() must only run inside the Sailbox — see delegateToSailbox().");
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  const pages = context.pages();
  const [keep, ...stray] = pages.length > 0 ? pages : [await context.newPage()];
  await Promise.all(stray.map((p) => p.close().catch(() => {})));
  return keep;
}

/**
 * Files the in-box copy of this bridge needs, mirrored under the same
 * relative layout (scripts/booking_bridge.mjs importing ../src/booking/*) so
 * its own `import` statements resolve unmodified once copied over.
 */
const SYNCED_FILES = [
  "scripts/booking_bridge.mjs",
  "src/booking/book.js",
  "src/booking/confirmGate.js",
  "src/booking/store.js",
  "src/booking/stubMode.js",
  "src/booking/guestProfile.js",
  "src/booking/paymentGuard.js",
  "src/booking/resetScript.js",
  "src/booking/providers/index.js",
  "src/booking/providers/opentable.js",
  "src/booking/providers/resy.js",
];
const REMOTE_ROOT = "/root/booking/repo";

async function syncToSailbox(box) {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  for (const relative of SYNCED_FILES) {
    const contents = await readFile(path.join(localRoot, relative), "utf8");
    await box.fs.write(`${REMOTE_ROOT}/${relative}`, contents);
  }
}

/**
 * Re-invokes this same script inside the Sailbox with the original request on
 * stdin, over the Sail SDK's run() (no network port opened at all - the SDK
 * is the transport). Only reached for restaurant.search / restaurant.book in
 * real mode; stub mode and booking.reset/list_open never touch a page and
 * stay local.
 */
async function delegateToSailbox(request) {
  const { Sailbox } = await import("@sailresearch/sdk");
  const boxes = await Sailbox.list({ limit: 50 });
  const box = boxes.find((b) => (b.name ?? "") === "booking");
  if (!box) {
    throw new Error(
      'no Sailbox named "booking" found — has the TON-8 persistent box been created?'
    );
  }

  await syncToSailbox(box);
  await box.fs.write(`${REMOTE_ROOT}/request.json`, JSON.stringify(request));

  const storeEnv = process.env.BOOKING_STORE_PATH
    ? ` BOOKING_STORE_PATH=${JSON.stringify(process.env.BOOKING_STORE_PATH)}`
    : "";
  const command =
    `cd ${REMOTE_ROOT} && BOOKING_BRIDGE_INSIDE_SAILBOX=1${storeEnv} ` +
    `node scripts/booking_bridge.mjs < request.json`;
  const res = await box.run(command, { timeout: 120_000 });

  const lastLine = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Sailbox bridge produced no output: ${(res.stderr ?? "").slice(0, 500)}`);
  }
  const payload = JSON.parse(lastLine);
  if (!payload.ok) throw new Error(payload.error);
  return payload.result;
}

/**
 * Resolve and VALIDATE the provider name, in stub mode too.
 *
 * getProvider() would catch an unknown name in real mode, but stub mode never
 * reaches it - so a runbook naming a provider that does not exist would pass
 * every rehearsal and throw on stage, at the irreversible step, in front of an
 * audience. Validating here means stub runs fail for the same reasons real
 * ones do, which is the only property that makes a stub rehearsal meaningful.
 */
function resolveProvider(args) {
  // opentable is network-blocked from this environment (Akamai edge denial) —
  // resy is the only reachable provider as of 2026-08-02. See providers/index.js.
  const name = args.provider ?? "resy";
  getProvider(name); // throws with the list of known providers
  return name;
}

const PAGE_ACTIONS = new Set(["restaurant.search", "restaurant.book"]);

async function handle(request) {
  const { action, arguments: args = {}, confirmed = false } = request;
  if (!action) throw new Error("request is missing `action`");

  if (IRREVERSIBLE.has(action) && confirmed !== true) {
    throw new Error(
      `refused: "${action}" is irreversible and arrived without upstream ` +
        "confirmation. The spoken gate in RunbookExecutor is authoritative; " +
        "this endpoint will not book on its own."
    );
  }

  // Real (non-stub) search/book need the live browser, which only exists
  // inside the Sailbox. Hop over once, here, rather than threading that
  // decision through every case below.
  if (!isStubMode() && !INSIDE_SAILBOX && PAGE_ACTIONS.has(action)) {
    return delegateToSailbox(request);
  }

  switch (action) {
    case "restaurant.search": {
      const params = toBookingParams(args);
      const provider = resolveProvider(args);
      if (isStubMode()) {
        return { candidates: 1, stub: true, query: params.restaurant, provider };
      }
      const page = await acquirePage();
      const results = await getProvider(provider).search(page, params);
      return { candidates: results.length, query: params.restaurant, provider };
    }

    case "restaurant.book": {
      const params = toBookingParams(args);
      const provider = resolveProvider(args);
      const page = isStubMode() ? undefined : await acquirePage();
      const booking = await bookStep({
        provider,
        params,
        page,
        // Already decided upstream, by voice. See CONFIRMATION POLICY above.
        getYes: async () => "yes",
        storePath: process.env.BOOKING_STORE_PATH,
      });
      return {
        confirmation_id: booking.confirmationRef,
        provider: booking.provider,
        stub: booking.stub === true,
      };
    }

    case "booking.reset": {
      const result = await resetAll({ storePath: process.env.BOOKING_STORE_PATH });
      return { cancelled: result.cancelled };
    }

    case "booking.list_open": {
      const open = await listOpenBookings(process.env.BOOKING_STORE_PATH);
      return { open: open.map((b) => b.confirmationRef) };
    }

    default:
      throw new Error(`unknown action "${action}"`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
try {
  const result = await handle(JSON.parse(raw));
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error?.message ?? String(error),
      type: error?.constructor?.name ?? "Error",
    }) + "\n"
  );
  process.exitCode = 1;
}
