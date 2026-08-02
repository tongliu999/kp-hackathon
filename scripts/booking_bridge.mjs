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

import { bookStep, makeCancelFn } from "../src/booking/book.js";
import { resetAll } from "../src/booking/resetScript.js";
import { listOpenBookings } from "../src/booking/store.js";
import { isStubMode } from "../src/booking/stubMode.js";
import { getProvider } from "../src/booking/providers/index.js";
import { acquirePage, releaseBrowser } from "../src/booking/session.js";

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
      // A real open booking needs a real cancelFn. Without one resetAll refuses
      // rather than marking it cancelled in the store while the table stays
      // held -- so in real mode this must supply the authenticated page.
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
  // its tab open in the session the human is watching.
  await releaseBrowser();
}
