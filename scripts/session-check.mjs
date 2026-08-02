// Resy-shaped entry point to the provider-agnostic auth check.
//
// The logic -- and the reason it refuses to guess -- now lives in
// src/vault/sessionCheck.js, so every domain the vault holds is checked the
// same way rather than each site growing its own slightly-wrong copy. This file
// is the Resy binding: its probe URL and its markers, kept because
// verify-session.mjs and import-session.mjs call it by name.

import { checkSession as checkAnyDomain } from "../src/vault/sessionCheck.js";
import { markersFor, probeUrlFor, KNOWN_PROBE_URLS } from "../src/vault/capabilities.js";

const DOMAIN = "resy.com";

export const DEFAULT_PROBE_URL = KNOWN_PROBE_URLS[DOMAIN];

/**
 * @returns {Promise<{state: "authenticated"|"logged-out"|"unknown", detail: string}>}
 */
export async function checkSession(context, { probeUrl, domain = DOMAIN, capability } = {}) {
  return checkAnyDomain(context, {
    domain,
    probeUrl: probeUrl ?? probeUrlFor(domain, capability) ?? DEFAULT_PROBE_URL,
    markers: markersFor(domain, capability),
  });
}
