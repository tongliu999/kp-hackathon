// Provider adapter contract (TON-11). An adapter is an object with:
//
//   search(page, params) -> Promise<Result[]>
//     Runs the provider's search UI. Returns whatever the adapter needs to pick a slot from.
//     Never throws on "no results" — return an empty array and let book.js decide that's fatal.
//
//   selectSlot(results, params) -> Result | null
//     Pure function: pick the matching slot out of `results`, or null if nothing matches.
//     No page access — keeps the matching logic testable without a browser.
//
//   book(page, slot) -> Promise<{ confirmationRef: string, raw: unknown }>
//     Drives the UI through to a completed booking. Must throw rather than return a falsy
//     confirmationRef — book.js treats a missing ref as "not actually booked."
//
//   cancel(page, record) -> Promise<void>
//     Cancels the booking identified by record.confirmationRef. Must be safe to call with
//     nothing else going on in the page (resetScript calls this unattended between rehearsals).
//
// PROVIDER STATUS (TON-8, verified against the live sites from the booking Sailbox):
//
//   resy      — CHOSEN. Selectors read off the live DOM through the box's browser.
//   opentable — UNUSABLE FROM SAIL. Akamai answers 403 "Access Denied" to its search,
//               city and restaurant pages from Sail's egress, in a real Chromium with a
//               real browser fingerprint. Reproduced from three separate Sail IPs
//               (including a forked box, which gets a different IP), so it is an egress
//               range block, not one poisoned address. Only /my/profile renders. The
//               adapter is kept because it is a working reference for the contract, but
//               it cannot complete a booking from this infrastructure.
//
// opentable.js's selectors remain unverified for the same reason — the pages they target
// cannot be loaded from here.

import * as opentable from "./opentable.js";
import * as resy from "./resy.js";

const PROVIDERS = {
  opentable,
  resy,
};

export function getProvider(name) {
  const key = String(name ?? "").toLowerCase();
  const adapter = PROVIDERS[key];
  if (!adapter) {
    throw new Error(`Unknown booking provider "${name}" — known providers: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return adapter;
}

export function registerProvider(name, adapter) {
  const key = String(name ?? "").toLowerCase();
  if (!key) throw new Error("registerProvider requires a non-empty name.");
  for (const method of ["search", "selectSlot", "book", "cancel"]) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`Provider "${name}" is missing required method "${method}".`);
    }
  }
  PROVIDERS[key] = adapter;
}

export { PROVIDERS };
