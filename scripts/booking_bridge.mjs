#!/usr/bin/env node
// Track A (Python) <-> Track C (JavaScript) seam.
//
// Reads ONE JSON request on stdin, writes ONE JSON response on stdout, exits.
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
//
// TRANSPORT. In real mode this script re-invokes itself INSIDE the Sailbox over
// the Sail SDK's run(), so the browser is driven from within the box and no
// debug port is ever exposed. CDP has no authentication of its own: whoever
// reaches it owns the browser, its cookies and its saved payment method.
//
// EVERY real-mode action is delegated, not just the page-driving ones. The
// booking store must live on exactly one filesystem -- if book() records in the
// box while list_open and reset read the laptop's copy, a real reservation
// becomes invisible to the reset that is supposed to cancel it, which is the
// orphaned-booking failure this system must never have.

import { bookStep, makeCancelFn } from "../src/booking/book.js";
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
 * Real mode is OPT-IN, by naming the box explicitly. Without this the bridge
 * refuses rather than delegating.
 *
 * This exists because of a real incident, not a hypothetical. When delegation
 * replaced the CDP transport, the old gate went with it: real mode used to
 * throw unless BOOKING_CDP_URL was set, and delegation had no equivalent, so
 * "not stub" silently became "reach the Sailbox and book". The unit suite --
 * which sends confirmed:true to prove the bridge refuses without it -- then
 * placed a real reservation at a real restaurant. It had to be cancelled by
 * hand.
 *
 * A test run must never be one env var away from an irreversible action, so
 * booking now requires someone to have named the box on purpose.
 */
const BOX_NAME = process.env.BOOKING_SAILBOX ?? "";

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
let cdpBrowser = null;

async function acquirePage() {
  if (!INSIDE_SAILBOX) {
    throw new Error("acquirePage() must only run inside the Sailbox — see delegateToSailbox().");
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  cdpBrowser = browser;
  const context = browser.contexts()[0];
  const pages = context.pages();
  const [keep, ...stray] = pages.length > 0 ? pages : [await context.newPage()];
  await Promise.all(stray.map((p) => p.close().catch(() => {})));
  return keep;
}

/**
 * Disconnect from CDP so this process can exit.
 *
 * Not cosmetic: the CDP websocket is an active handle, so without this the
 * in-box bridge writes its JSON response and then hangs forever, and
 * delegateToSailbox()'s box.run() waits on an exit that never comes. It looks
 * exactly like the browser work being slow -- running the same command with a
 * `timeout` wrapper "fixes" it and hides the cause.
 *
 * close() on a CDP attachment disconnects the client; it does not kill the
 * box's browser, which must survive between steps and rehearsals.
 */
async function releaseBrowser() {
  if (!cdpBrowser) return;
  const browser = cdpBrowser;
  cdpBrowser = null;
  await browser.close().catch(() => {});
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
  // Without this Node treats every synced .js as typeless, reparses it as ESM
  // and says so on stderr -- noise in the middle of the transport's own stdout
  // protocol, plus a real per-module cost on a path that runs per step.
  await box.fs.write(`${REMOTE_ROOT}/package.json`, JSON.stringify({ type: "module" }));
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
  const box = boxes.find((b) => (b.name ?? "") === BOX_NAME);
  if (!box) {
    throw new Error(
      `no Sailbox named ${JSON.stringify(BOX_NAME)} found — has the TON-8 persistent box been created?`
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
  const name = args.provider ?? "resy";
  getProvider(name); // throws with the list of known providers
  return name;
}

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

  // Hop into the box once, here. Real mode drives a browser and owns the
  // booking store; both live in the Sailbox.
  if (!isStubMode() && !INSIDE_SAILBOX) {
    if (!BOX_NAME) {
      throw new Error(
        "no authenticated browser session available: BOOKING_SAILBOX is unset, " +
          "so this bridge will not reach a Sailbox or place a real booking. Set " +
          "BOOKING_SAILBOX=booking to opt in, or BOOKING_STUB_MODE=1 to exercise " +
          "the full path without contacting a provider."
      );
    }
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

    case "restaurant.select": {
      const rank = Number(args.rank ?? 1);
      if (!Number.isInteger(rank) || rank < 1) {
        throw new Error("restaurant.select rank must be a positive integer");
      }
      return { selected_rank: rank, requested_time: args.time ?? null };
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
      // A real open booking needs a real cancelFn, or resetAll refuses rather
      // than marking the store cancelled while the table stays held.
      const page = isStubMode() ? undefined : await acquirePage();
      const result = await resetAll({
        storePath: process.env.BOOKING_STORE_PATH,
        cancelFn: page ? makeCancelFn(page) : undefined,
      });
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
} finally {
  // Runs on the failure path too: a step that threw mid-booking must not leave
  // the process pinned open by its CDP connection.
  await releaseBrowser();
}
