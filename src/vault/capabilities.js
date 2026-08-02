// What we have MEASURED about a domain, as opposed to what we assume.
//
// Every field here is written by probing. The default for an unprobed domain is
// null -- never a guess -- because the whole reason this record exists is that
// guessing was wrong three times in a row:
//
//   * "we can read the site, so we can log into it" -- false. Bot vendors guard
//     auth endpoints far harder than content. On Resy, identical request, only
//     the source IP differing:
//         OPTIONS /4/auth/mobile   Sailbox 500 (no CORS headers)  residential 204
//         OPTIONS /3/auth/refresh  Sailbox 500                    residential 204
//         OPTIONS /4/find          Sailbox 204                    residential 204
//     Search returned 80 real results from the box the whole time.
//
//   * "a session is a cookie" -- false. It is a cookie plus the right to
//     refresh it. Resy exchanges its cookie at /3/auth/refresh on every page
//     load, so a session imported into an environment that cannot reach that
//     endpoint is a valid credential that never activates.
//
//   * "no login button means signed in" -- false. That is also what an
//     unhydrated page looks like.
//
// Assume all three apply to a new domain until its probe says otherwise.

import { normalizeDomain } from "./domains.js";

/**
 * @typedef {object} Capability
 * @property {string} domain
 * @property {string|null} probedAt
 * @property {string|null} authUrl            endpoint the probe exercised
 * @property {string|null} verdict            see classifyProbe
 * @property {boolean|null} needsTunnel       does the box need residential egress to authenticate
 * @property {object|null} evidence           the two raw responses, for the record
 * @property {object} markers                 positive signed-in DOM evidence
 * @property {object|null} refresh            {endpoint, observed}
 */

export function emptyCapability(domain) {
  return {
    domain: normalizeDomain(domain),
    probedAt: null,
    authUrl: null,
    verdict: null,
    needsTunnel: null,
    evidence: null,
    markers: { signedIn: null, loggedOut: null, hydrated: null, discoveredAt: null },
    refresh: null,
  };
}

const OK = (r) => Number.isInteger(r?.status) && r.status >= 200 && r.status < 300;

/**
 * The only diagnostic that separates "blocked" from "broken form": the SAME
 * request, from two egress points, compared.
 *
 * @param {{box: object, host: object}} responses each {status, corsAllowOrigin, error}
 */
export function classifyProbe({ box, host }) {
  const boxOk = OK(box);
  const hostOk = OK(host);

  if (boxOk && hostOk) {
    return {
      verdict: "box-ok",
      needsTunnel: false,
      summary: "the auth endpoint answers from the Sailbox; no tunnel needed",
    };
  }

  if (!boxOk && hostOk) {
    // The signature from finding 1. A 5xx with no Access-Control-Allow-Origin
    // is indistinguishable in a browser from a CORS misconfiguration, so the
    // console blames CORS and the login button silently does nothing.
    const browserInvisible = Number(box?.status) >= 500 && !box?.corsAllowOrigin;
    return {
      verdict: "residential-only",
      needsTunnel: true,
      browserInvisible,
      summary:
        `auth blocked from the box (${describe(box)}) but fine from the host (${describe(host)}) — ` +
        "same request, only the source IP differs, so this is egress-based blocking, not a bad request" +
        (browserInvisible
          ? ". In a browser this surfaces as a CORS error and a login button that does nothing; it is not a CORS misconfiguration."
          : ""),
    };
  }

  if (!boxOk && !hostOk) {
    // Both ends fail, so egress is not the variable. Blaming the box here is
    // how people lose hours to "the account must be unverified".
    return {
      verdict: "broken-request",
      needsTunnel: null,
      summary:
        `the request fails from both the box (${describe(box)}) and the host (${describe(host)}) — ` +
        "this is the request or the endpoint, not egress blocking. Fix the request before blaming the box.",
    };
  }

  return {
    verdict: "inconclusive",
    needsTunnel: null,
    summary:
      `the box succeeded (${describe(box)}) where the host failed (${describe(host)}) — ` +
      "unexpected; re-run before recording anything",
  };
}

function describe(r) {
  if (!r) return "no response";
  if (r.error) return `error: ${r.error}`;
  const cors = r.corsAllowOrigin ? "" : ", no CORS headers";
  return `${r.status}${cors}`;
}

/**
 * Markers that prove a session is live, per domain.
 *
 * Seeded only with what has been confirmed against a real logged-in session.
 * Anything else must come from `vault probe --discover`; a domain with no
 * signedIn marker cannot be reported authenticated at all, which is the point.
 */
export const KNOWN_MARKERS = {
  "resy.com": {
    // Rendered ONLY when signed in -- positive evidence, not the absence of
    // something. Confirmed by --discover against a live session.
    signedIn: '[data-test-id="menu_container-button-profile_photo"]',
    loggedOut: '[data-test-id="menu_container-button-log_in"]',
    // Present signed in or out, so it means "the app rendered", not "you are in".
    hydrated: 'input[placeholder*="Search restaurants" i]',
    discoveredAt: "2026-08-02",
  },
};

/**
 * A page on the domain that renders the markers. Needs to be a real content
 * page: a bare origin often redirects or serves a marketing shell that renders
 * neither marker, which reads as "unknown" forever.
 */
export const KNOWN_PROBE_URLS = {
  "resy.com": "https://resy.com/cities/san-francisco-ca?date=2026-08-03&seats=2",
};

export function probeUrlFor(domain, capability) {
  return capability?.probeUrl ?? KNOWN_PROBE_URLS[normalizeDomain(domain)] ?? null;
}

export function markersFor(domain, capability) {
  const recorded = capability?.markers ?? {};
  const known = KNOWN_MARKERS[normalizeDomain(domain)] ?? {};
  return {
    signedIn: recorded.signedIn ?? known.signedIn ?? null,
    loggedOut: recorded.loggedOut ?? known.loggedOut ?? null,
    hydrated: recorded.hydrated ?? known.hydrated ?? null,
  };
}

export function describeCapability(capability) {
  if (!capability?.probedAt) {
    return "never probed — nothing is known about this domain's auth path";
  }
  const tunnel =
    capability.needsTunnel === true
      ? "needs the residential tunnel (ssh -N -R 1080 booking.sail + chromium --proxy-server=socks5://127.0.0.1:1080)"
      : capability.needsTunnel === false
        ? "authenticates from the box directly"
        : "tunnel requirement unknown";
  return `${capability.verdict}: ${tunnel}`;
}
