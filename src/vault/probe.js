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

import { classifyProbe, KNOWN_AUTH_URLS } from "./capabilities.js";
import { normalizeDomain, assertUrlBelongsTo } from "./domains.js";

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

/**
 * Both sides run curl, driven by the SAME command string. Only the machine it
 * runs on differs.
 *
 * This is not fussiness. The host side originally used Node's fetch while the
 * box side used curl, and against the very endpoint this tool exists to
 * diagnose the two disagree: identical URL, identical explicit headers,
 *
 *     curl        -> 204
 *     node fetch  -> 500
 *
 * because undici's default headers and TLS fingerprint are not a browser's or
 * curl's. A client difference of that size is indistinguishable from an egress
 * difference in the comparison, which would make the probe confidently report
 * "blocked from the box" for two clients that were never the same request.
 */
function curlTransport(name, exec) {
  return {
    name,
    async send(request) {
      try {
        const { stdout, stderr } = await exec(curlCommand(request));
        const parsed = parseCurlHead(stdout);
        if (parsed.status == null && stderr) {
          return { status: null, corsAllowOrigin: null, error: String(stderr).trim().slice(0, 200) };
        }
        return parsed;
      } catch (error) {
        return { status: null, corsAllowOrigin: null, error: error.message };
      }
    },
    async clientVersion() {
      try {
        const { stdout } = await exec("curl --version");
        return String(stdout).split("\n")[0].trim();
      } catch {
        return null;
      }
    },
  };
}

async function localExec(command) {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(exec)(command, { timeout: 60_000, maxBuffer: 1 << 20 }).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? error.message,
  }));
}

/** Host transport: this machine's own egress, i.e. residential. */
export function hostTransport({ exec = localExec } = {}) {
  return curlTransport("host", exec);
}

/** Box transport: the same curl, inside the Sailbox, so it leaves Sail's egress. */
export function sailboxTransport(box) {
  return curlTransport("box", async (command) => {
    const result = await box.run(command, { timeout: 60_000 });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
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

  // The comparison is only meaningful if both sides ran the same client. They
  // are the same program by construction, but not necessarily the same build,
  // so record both and let a mismatch be visible instead of silent.
  const [boxClient, hostClient] = await Promise.all([
    box.clientVersion?.() ?? null,
    host.clientVersion?.() ?? null,
  ]);

  return {
    probedAt: now.toISOString(),
    authUrl: url,
    verdict: verdict.verdict,
    needsTunnel: verdict.needsTunnel,
    summary: verdict.summary,
    browserInvisible: verdict.browserInvisible ?? false,
    clients: { box: boxClient, host: hostClient, matched: boxClient === hostClient },
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
