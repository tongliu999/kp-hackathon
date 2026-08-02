// The live Playwright page for the authenticated Sailbox session (TON-8).
//
// Attaches over CDP to the chromium ALREADY RUNNING in the box, launched with
// --user-data-dir=/root/booking/profile.
//
// Deliberately NOT launchPersistentContext() against that directory: chromium
// holds an exclusive lock on its user-data-dir, so a second instance pointed at
// the same profile either refuses to start or silently forks a copy of the
// profile, and the login appears to have vanished.
//
// contexts()[0] is the persistent profile's own context. A fresh newContext()
// would be incognito -- no cookies, no login -- which is the failure
// sail-notes.md warns passes local testing and dies on stage.
//
// Shared by scripts/booking_bridge.mjs and src/index.js so `npm run reset` can
// cancel a REAL booking. Without it resetAll has no cancelFn and refuses,
// which is safe but leaves the table held.

let cdpBrowser = null;
const openedPages = [];

export async function acquirePage() {
  const endpoint = process.env.BOOKING_CDP_URL;
  if (!endpoint) {
    throw new Error(
      "no authenticated browser session available: BOOKING_CDP_URL is unset. " +
        "Run `node scripts/vnc-start.mjs` to bring up the booking Sailbox and " +
        "print its CDP tunnel URL. Set BOOKING_STUB_MODE=1 to exercise the full " +
        "path without contacting a provider."
    );
  }

  if (!cdpBrowser) {
    const { chromium } = await import("playwright");
    try {
      cdpBrowser = await chromium.connectOverCDP(endpoint);
    } catch (cause) {
      throw new Error(
        `could not attach to the Sailbox browser at ${endpoint}: ${cause.message}. ` +
          "The box may be paused, the CDP tunnel's IP allowlist may not cover this " +
          "machine, or the egress proxy tunnel may be down -- re-run " +
          "`node scripts/vnc-start.mjs`."
      );
    }
  }

  const context = cdpBrowser.contexts()[0];
  if (!context) {
    throw new Error(
      "attached to the Sailbox browser but it exposes no browser context, so " +
        "there is no profile to book from."
    );
  }

  const page = await context.newPage();
  openedPages.push(page);
  return page;
}

/**
 * Close only the tabs this process opened, and never the browser.
 *
 * browser.close() on a CDP attachment tears down the connection rather than the
 * browser, but leaving tabs behind on every step would pile them up in the
 * session a human is watching over VNC.
 */
export async function releaseBrowser() {
  for (const page of openedPages.splice(0)) {
    await page.close().catch(() => {});
  }
  if (cdpBrowser) {
    await cdpBrowser.close().catch(() => {});
    cdpBrowser = null;
  }
}
