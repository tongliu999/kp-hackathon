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
//   book(page, slot, guestInfo) -> Promise<{ confirmationRef: string, raw: unknown }>
//     Drives the UI through to a completed booking. guestInfo is the loaded guest profile
//     (firstName, lastName, phone, email) for providers whose checkout needs contact info
//     without a full account (see providers/resy.js, guestProfile.js). Must throw rather than
//     return a falsy confirmationRef — book.js treats a missing ref as "not actually booked."
//
//   cancel(page, record) -> Promise<void>
//     Cancels the booking identified by record.confirmationRef. Must be safe to call with
//     nothing else going on in the page (resetScript calls this unattended between rehearsals).
//
// Provider status as of 2026-08-02:
//
//   opentable.js — dead from this environment. The domain is blocked at the network edge
//     (Akamai "Access Denied") before any page loads, login or no login. Selectors were never
//     verified live and can't be from here.
//
//   resy.js — the live path. Guest checkout needs no account (verified live: a real venue's
//     "Reserve Now" sits behind no login wall), which sidesteps the session-persistence problem
//     TON-8 hit entirely. Search, slot selection, and reaching the reservation modal are verified
//     live. The guest contact-info screen and the true final submit are NOT — completing that
//     live would create a real reservation, which needs a human's go-ahead first. Smoke-test that
//     last stretch, watching, before trusting it unattended.

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
