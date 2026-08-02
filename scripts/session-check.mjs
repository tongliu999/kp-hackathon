// Does the provider still accept the session? Shared by import-session.mjs and
// verify-session.mjs so both answer the question the same way.
//
// THE TRAP THIS EXISTS TO AVOID. Resy renders a "Log in" control only when
// signed out, so its absence looks like proof of a session. It is not: it is
// also what an unhydrated page looks like. A first draft of the import script
// checked the marker after a fixed sleep and cheerfully reported
// AUTHENTICATED for a profile holding nothing but junk example.com cookies.
//
// A false positive is the worst outcome available here. TON-8's whole warning
// is that a rejected cookie is byte-identical to a working one right up until
// the demo, so this waits for the page to actually render before believing
// anything, and returns "unknown" rather than guessing when it cannot tell.

const LOGGED_OUT = '[data-test-id="menu_container-button-log_in"]';
// The account avatar. Rendered ONLY when signed in, so this is positive
// evidence rather than the absence of something -- confirmed by --discover
// against a real live session.
const SIGNED_IN = '[data-test-id="menu_container-button-profile_photo"]';
// Present signed in or out, so it means "the app rendered", not "you are in".
const HYDRATED = 'input[placeholder*="Search restaurants" i]';

export const DEFAULT_PROBE_URL =
  "https://resy.com/cities/san-francisco-ca?date=2026-08-03&seats=2";

/**
 * @returns {Promise<{state: "authenticated"|"logged-out"|"unknown", detail: string}>}
 */
export async function checkSession(context, { probeUrl = DEFAULT_PROBE_URL } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

    // Settle on whichever appears first: the app shell, or the logged-out
    // control. Waiting on a fixed timer instead is what produced the false
    // positive -- a slow load and a live session are indistinguishable to a
    // sleep.
    try {
      await Promise.race([
        page.locator(HYDRATED).first().waitFor({ state: "attached", timeout: 45_000 }),
        page.locator(LOGGED_OUT).first().waitFor({ state: "attached", timeout: 45_000 }),
      ]);
    } catch {
      return {
        state: "unknown",
        detail: "page never rendered its header; cannot tell signed-in from not",
      };
    }

    // Hydration can land the header before the session-dependent controls.
    await page.waitForTimeout(4000);

    const [loggedOut, signedIn, hydrated] = await Promise.all([
      page.locator(LOGGED_OUT).count(),
      page.locator(SIGNED_IN).count(),
      page.locator(HYDRATED).count(),
    ]);

    if (loggedOut > 0) {
      return { state: "logged-out", detail: `"Log in" control present (${loggedOut})` };
    }
    if (signedIn > 0) {
      return { state: "authenticated", detail: "account avatar rendered" };
    }
    // No login control AND no avatar. That is not a session -- it is a page we
    // cannot read (interstitial, challenge, redirect, half-hydrated). Calling
    // it authenticated here is precisely the mistake this module exists to
    // prevent.
    return {
      state: "unknown",
      detail: hydrated
        ? `header rendered but neither login control nor avatar at ${page.url()}`
        : `page never rendered at ${page.url()}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
