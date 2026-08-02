// Move a stored session into a running browser, then ask the SITE whether it
// took.
//
// "Cookies installed" is not success. The only success criterion that means
// anything is that the provider still accepts them, because a rejected cookie
// is byte-identical to a working one until the demo.

import { checkSession, STATES } from "./sessionCheck.js";
import { cookiesForDomain, assertUrlBelongsTo } from "./domains.js";
import { isExpired } from "./expiry.js";

/**
 * @param {object} context   Playwright BrowserContext
 * @param {object} record    a session record from the vault
 * @param {object} options   {probeUrl, markers, now, check}
 * @returns {Promise<{state: string, detail: string, installed: number}>}
 */
export async function installSession(context, record, { probeUrl, markers, now = new Date(), check = checkSession } = {}) {
  if (!record?.domain) throw new Error("installSession needs a session record with a domain");
  if (isExpired(record.expiresAt, now)) {
    // Belt and braces: selectSession already refuses these. Re-checking here
    // means no future caller can route round the refusal by holding a record.
    throw new Error(`refusing to install expired session ${record.domain}/${record.label} (expired ${record.expiresAt})`);
  }
  if (!probeUrl) {
    throw new Error(
      `no probe URL known for ${record.domain} — pass --probe-url <a page on ${record.domain} that renders when signed in>`
    );
  }
  assertUrlBelongsTo(probeUrl, record.domain);

  // Filter again at the boundary. The record was built from filtered cookies,
  // but this is the last point before a credential leaves the process, and the
  // rule is that a session only ever reaches its own domain.
  const cookies = cookiesForDomain(record.cookies ?? [], record.domain);
  if (cookies.length === 0) throw new Error(`session ${record.domain}/${record.label} holds no cookies for its own domain`);

  // Clear first: a stale pre-login cookie surviving alongside the imported ones
  // is exactly the sort of thing that makes a session look valid and behave
  // logged-out.
  await context.clearCookies({ domain: `.${record.domain}` }).catch(() => {});
  await context.clearCookies({ domain: record.domain }).catch(() => {});
  await context.addCookies(cookies);

  const { state, detail } = await check(context, { domain: record.domain, probeUrl, markers });
  return { state, detail, installed: cookies.length };
}

/** Human-readable next steps for a check that did not come back authenticated. */
export function explainFailure(state, { domain, label, capability }) {
  if (state === STATES.LOGGED_OUT) {
    return [
      `NOT AUTHENTICATED — cookies installed, but ${domain} still shows a login control.`,
      "Likely causes, in order:",
      "  1. the export missed HttpOnly cookies (many extensions do) — re-export including them",
      "  2. the session is bound to the origin IP or device fingerprint",
      `  3. the session behind "${label}" was already logged out or expired`,
      capability?.needsTunnel
        ? `  4. ${domain} needs residential egress to refresh (${capability.verdict}) — start the tunnel: ` +
          "ssh -N -R 1080 booking.sail, then chromium --proxy-server=socks5://127.0.0.1:1080"
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "INCONCLUSIVE — refusing to call this authenticated.",
    "Absence of a login control is not proof of a session; it is also what an unhydrated page looks like.",
    capability?.markers?.signedIn
      ? null
      : `No positive signed-in marker is recorded for ${domain}. Discover one against a real session:\n` +
        `  node scripts/vault.mjs probe ${domain} --discover`,
  ]
    .filter(Boolean)
    .join("\n");
}
