// `probe <domain>`: send the SAME request from the Sailbox and from the host,
// and compare.
//
// That comparison is the only diagnostic that distinguishes "this egress is
// blocked" from "this request is wrong". Without it you get the Resy afternoon:
// a 500 with no Access-Control-Allow-Origin reaches the browser as a CORS
// error, the login button silently does nothing, and three people spend hours
// on "the account must be unverified" before anyone compares source IPs.
//
// The request is built ONCE and handed to both transports. If the two sides
// were allowed to construct their own requests, a difference between them would
// be indistinguishable from a difference between the networks, and the whole
// diagnostic would be worthless.

import { classifyProbe } from "./capabilities.js";
import { normalizeDomain, assertUrlBelongsTo } from "./domains.js";

/**
 * Auth endpoints already measured. Anything not listed must be passed with
 * --auth-url: guessing an endpoint and probing the wrong one produces a
 * confident, wrong capability record.
 */
export const KNOWN_AUTH_URLS = {
  "resy.com": "https://api.resy.com/4/auth/mobile",
};

export const KNOWN_REFRESH_URLS = {
  "resy.com": "https://api.resy.com/3/auth/refresh",
};

/**
 * A CORS preflight, which is what a browser actually sends before a login POST
 * and therefore what gets blocked first. Cheap, unauthenticated, and carries no
 * credential -- so probing is safe to run against a domain we hold no session
 * for.
 */
export function buildPreflight({ url, origin, requestMethod = "POST", requestHeaders = "content-type,authorization" }) {
  if (!origin) throw new Error("a preflight needs an Origin — that is what the server keys the decision on");
  return {
    url,
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": requestMethod,
      "access-control-request-headers": requestHeaders,
    },
  };
}

/** Parse `curl -D -` output. Pure, so the box transport can be tested offline. */
export function parseCurlHead(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let status = null;
  let corsAllowOrigin = null;
  for (const line of lines) {
    const statusMatch = line.match(/^HTTP\/[\d.]+\s+(\d{3})/i);
    // Last status line wins: redirects and HTTP/2 upgrades emit several.
    if (statusMatch) {
      status = Number(statusMatch[1]);
      corsAllowOrigin = null;
    }
    const corsMatch = line.match(/^access-control-allow-origin:\s*(.+)$/i);
    if (corsMatch) corsAllowOrigin = corsMatch[1].trim();
  }
  return { status, corsAllowOrigin, error: status == null ? "no HTTP status in response" : null };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function curlCommand(request, { timeoutSeconds = 20 } = {}) {
  const headers = Object.entries(request.headers)
    .map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
    .join(" ");
  return `curl -sS -o /dev/null -D - -X ${request.method} ${headers} --max-time ${timeoutSeconds} ${shellQuote(request.url)}`;
}

/** Host transport: this machine's own egress, i.e. residential. */
export function hostTransport({ fetchImpl = fetch } = {}) {
  return {
    name: "host",
    async send(request) {
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
        });
        return {
          status: response.status,
          corsAllowOrigin: response.headers.get("access-control-allow-origin"),
          error: null,
        };
      } catch (error) {
        return { status: null, corsAllowOrigin: null, error: error.message };
      }
    },
  };
}

/** Box transport: curl inside the Sailbox, so the request leaves Sail's egress. */
export function sailboxTransport(box) {
  return {
    name: "box",
    async send(request) {
      try {
        const result = await box.run(curlCommand(request), { timeout: 60_000 });
        const parsed = parseCurlHead(result.stdout);
        if (parsed.status == null && result.stderr) {
          return { status: null, corsAllowOrigin: null, error: String(result.stderr).trim().slice(0, 200) };
        }
        return parsed;
      } catch (error) {
        return { status: null, corsAllowOrigin: null, error: error.message };
      }
    },
  };
}

/**
 * Run both sides and classify. Transports are injected, so the comparison logic
 * is exercised by tests with a synthetic oracle and no network at all.
 *
 * @returns a capability patch, ready for putCapability()
 */
export async function probeDomain(domain, { authUrl, origin, box, host, now = new Date() }) {
  const key = normalizeDomain(domain);
  const url = authUrl ?? KNOWN_AUTH_URLS[key];
  if (!url) {
    throw new Error(
      `no auth endpoint known for ${key}. Pass --auth-url <url>; probing a guessed endpoint ` +
        "records a confident, wrong answer."
    );
  }
  // A probe carries no credential, but it must still not be aimed off-domain:
  // an --auth-url typo would otherwise record another site's behaviour as this
  // domain's capability.
  assertUrlBelongsTo(url, key);

  const request = buildPreflight({ url, origin: origin ?? `https://${key}` });

  // Sequential, not parallel: a rate limiter that sees two simultaneous
  // identical requests can answer them differently, which would put the
  // difference in the comparison rather than in the network.
  const boxResponse = await box.send(request);
  const hostResponse = await host.send(request);

  const verdict = classifyProbe({ box: boxResponse, host: hostResponse });

  return {
    probedAt: now.toISOString(),
    authUrl: url,
    verdict: verdict.verdict,
    needsTunnel: verdict.needsTunnel,
    summary: verdict.summary,
    browserInvisible: verdict.browserInvisible ?? false,
    evidence: { box: boxResponse, host: hostResponse, request: { url, method: request.method } },
  };
}

/**
 * Which requests during a page load look like a session refresh.
 *
 * Finding 2: a session is a cookie PLUS the right to refresh it. Resy exchanges
 * its cookie at /3/auth/refresh on every page load, so a session imported into
 * an environment that cannot reach that endpoint is a valid credential that
 * never activates. Recording the refresh endpoint is what lets the probe check
 * reachability of the thing that actually keeps the session alive.
 */
export function classifyRefreshRequests(urls, domain) {
  const key = normalizeDomain(domain);
  const seen = new Map();
  for (const url of urls) {
    let host;
    let pathname;
    try {
      ({ hostname: host, pathname } = new URL(url));
    } catch {
      continue;
    }
    if (!host.endsWith(key)) continue;
    if (!/refresh|token|session|auth/i.test(pathname)) continue;
    const endpoint = `https://${host}${pathname}`;
    seen.set(endpoint, (seen.get(endpoint) ?? 0) + 1);
  }
  return [...seen.entries()]
    .map(([endpoint, count]) => ({ endpoint, count }))
    .sort((a, b) => b.count - a.count);
}
