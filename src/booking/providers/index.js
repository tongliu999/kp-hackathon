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
// Selectors in the concrete adapters (opentable.js, resy.js) are a first pass built against
// each site's public reservation-widget structure using role-based locators, chosen specifically
// to survive minor markup changes. They have not been run against a live authenticated session —
// that requires the human login step from TON-8 (real credentials, 2FA/CAPTCHA can't be automated
// or delegated to an assistant). Smoke-test whichever provider gets chosen against the live box
// before relying on it for a rehearsal.

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
