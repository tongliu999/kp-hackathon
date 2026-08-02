// Does the provider still accept this session? Provider-agnostic.
//
// THE TRAP THIS EXISTS TO AVOID. A site renders a "Log in" control only when
// signed out, so its absence looks like proof of a session. It is not: it is
// also what an unhydrated page looks like. A first draft of the import script
// checked the marker after a fixed sleep and cheerfully reported AUTHENTICATED
// for a profile holding nothing but junk example.com cookies.
//
// Two structural rules follow, and they are enforced here rather than left to
// each caller's discipline:
//
//   1. "authenticated" requires a POSITIVE signed-in marker to be present. A
//      domain with no such marker recorded cannot be reported authenticated at
//      all -- the answer is "unknown", and the fix is to discover the marker
//      against a real session.
//   2. Anything that is neither a rendered login control nor a rendered
//      signed-in marker is "unknown", never a pass.
//
// A false positive is the worst outcome available in this component: a rejected
// session is byte-identical to a working one until the demo.

import { assertUrlBelongsTo } from "./domains.js";

const RENDER_TIMEOUT_MS = 45_000;
const GOTO_TIMEOUT_MS = 90_000;
// Hydration can land the header before the session-dependent controls.
const SETTLE_MS = 4_000;

export const STATES = Object.freeze({
  AUTHENTICATED: "authenticated",
  LOGGED_OUT: "logged-out",
  UNKNOWN: "unknown",
});

/**
 * @param {object} context     a Playwright BrowserContext (or any object with newPage())
 * @param {object} options
 * @param {string} options.domain    the domain this session belongs to
 * @param {string} options.probeUrl  a page on that domain that renders the markers
 * @param {{signedIn:string|null,loggedOut:string|null,hydrated:string|null}} options.markers
 * @returns {Promise<{state: string, detail: string}>}
 */
export async function checkSession(context, { domain, probeUrl, markers, settleMs = SETTLE_MS } = {}) {
  if (!probeUrl) throw new Error("checkSession needs a probeUrl");
  if (domain) assertUrlBelongsTo(probeUrl, domain);

  const { signedIn, loggedOut, hydrated } = markers ?? {};
  if (!signedIn && !loggedOut) {
    return {
      state: STATES.UNKNOWN,
      detail:
        `no DOM markers recorded for ${domain ?? "this domain"} — cannot tell signed-in from signed-out. ` +
        "Discover them against a real session: node scripts/vault.mjs probe " +
        `${domain ?? "<domain>"} --discover`,
    };
  }

  const page = await context.newPage();
  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });

    // Settle on whichever appears first: the app shell, the logged-out control,
    // or the signed-in marker. Waiting on a fixed timer instead is what produced
    // the false positive -- a slow load and a live session are indistinguishable
    // to a sleep.
    const targets = [hydrated, loggedOut, signedIn].filter(Boolean);
    try {
      await Promise.race(
        targets.map((selector) =>
          page.locator(selector).first().waitFor({ state: "attached", timeout: RENDER_TIMEOUT_MS })
        )
      );
    } catch {
      return {
        state: STATES.UNKNOWN,
        detail: "page never rendered any known marker; cannot tell signed-in from not",
      };
    }

    await page.waitForTimeout(settleMs);

    const [loggedOutCount, signedInCount, hydratedCount] = await Promise.all([
      loggedOut ? page.locator(loggedOut).count() : Promise.resolve(0),
      signedIn ? page.locator(signedIn).count() : Promise.resolve(0),
      hydrated ? page.locator(hydrated).count() : Promise.resolve(0),
    ]);

    if (loggedOutCount > 0) {
      return { state: STATES.LOGGED_OUT, detail: `logged-out control present (${loggedOutCount})` };
    }
    if (signedInCount > 0) {
      return { state: STATES.AUTHENTICATED, detail: `signed-in marker rendered (${signedInCount})` };
    }
    if (!signedIn) {
      return {
        state: STATES.UNKNOWN,
        detail:
          "no logged-out control, but no positive signed-in marker is recorded for this domain, " +
          "so this is not evidence of a session. Discover one with --discover.",
      };
    }
    // No login control AND no signed-in marker. That is not a session -- it is a
    // page we cannot read (interstitial, challenge, redirect, half-hydrated).
    // Calling it authenticated here is precisely the mistake this module exists
    // to prevent.
    return {
      state: STATES.UNKNOWN,
      detail: hydratedCount
        ? `page rendered but neither marker present at ${page.url()}`
        : `page never rendered at ${page.url()}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Name the candidate markers on a page, to be run against a KNOWN-GOOD logged-in
 * session. The output is candidates for a human to choose from, not an
 * auto-configured marker: picking one from a logged-out page is how you record
 * a marker that is always present and always "proves" authentication.
 */
export async function discoverMarkers(context, { probeUrl, domain } = {}) {
  if (domain) assertUrlBelongsTo(probeUrl, domain);
  const page = await context.newPage();
  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(7_000);
    return await page.evaluate(() => {
      const attrs = ["data-test-id", "data-testid", "data-qa", "aria-label"];
      const hits = new Map();
      for (const attr of attrs) {
        for (const el of document.querySelectorAll(`[${attr}]`)) {
          const value = el.getAttribute(attr);
          if (value && /menu|profile|account|avatar|user|log ?in|log ?out|sign ?in|sign ?out/i.test(value)) {
            hits.set(`[${attr}="${value}"]`, (hits.get(`[${attr}="${value}"]`) ?? 0) + 1);
          }
        }
      }
      return [...hits.entries()].map(([selector, count]) => ({ selector, count }));
    });
  } finally {
    await page.close().catch(() => {});
  }
}
