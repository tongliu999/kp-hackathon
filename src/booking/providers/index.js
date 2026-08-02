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
//     confirmationRef — book.js treats a missing ref as "not actually booked." Confirm against
//     the provider's own record of the booking, never a confirmation banner: see resy.js.
//
//   cancel(page, record) -> Promise<void>
//     Cancels the booking identified by record.confirmationRef. Must be safe to call with
//     nothing else going on in the page (resetScript calls this unattended between rehearsals).
//
// PROVIDER STATUS (TON-8, verified live from the booking Sailbox):
//
//   resy      — CHOSEN AND VERIFIED. A real reservation was made through this adapter and
//               cancelled again, both confirmed against the Resy account. Selectors read off
//               the live DOM, not guessed.
//
//   opentable — UNUSABLE FROM SAIL. Akamai answers 403 "Access Denied" to its search, city
//               and restaurant pages from Sail's egress, in a real Chromium with a real
//               browser fingerprint, from three separate Sail IPs. Its selectors below remain
//               unverified guesses because the pages cannot be loaded from here. Kept as a
//               reference implementation of this contract.
//
// GUEST CHECKOUT DOES NOT EXIST ON RESY — tested, so nobody rebuilds it. From a forked box on
// raw Sail egress with all cookies cleared, clicking "Reserve Now" as a guest opens Resy's
// account wall ("Please enter your mobile phone number to verify or create an account"), not a
// contact form. Booking requires an account, and creating one hits /4/auth/mobile, which Sail's
// egress is blocked from. Hence the session-import + egress-proxy setup in scripts/.

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
