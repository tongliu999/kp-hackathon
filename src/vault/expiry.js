// When does this session die?
//
// Three sources, in descending authority:
//
//   jwt:exp         a JWT inside a cookie value. This is the credential's own
//                   statement of its lifetime, so it wins outright.
//   cookie:expires  the browser's expiry. Only an UPPER BOUND -- the server can
//                   revoke earlier, and non-auth cookies live alongside the
//                   auth one, so the latest is taken, not the earliest.
//   session         no expiry recorded anywhere. Unknown, not "fine".
//
// Expiry is a REFUSAL input, never a health signal. Past its exp, a session is
// certainly dead and the vault refuses it. Before its exp it is merely
// not-certainly-dead; only positive evidence from the site (sessionCheck.js)
// says otherwise. Treating "not expired" as "authenticated" is the same
// mistake as treating "no login button" as "signed in".

import { SESSION_COOKIE } from "./cookie_formats.js";

// A JWT is often wrapped: URL-encoded, or one field of a JSON cookie value.
// Match the token shape anywhere inside rather than requiring the whole value
// to be one -- Resy's auth cookie is a JSON blob carrying the refresh token.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/;

function decodePayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The `exp` claim, in epoch seconds, of a JWT found in `value`.
 * Returns null when there is no JWT or it carries no usable exp.
 * Reads `exp` and nothing else -- no other claim is ever surfaced.
 */
export function jwtExpiry(value) {
  const raw = String(value ?? "");
  const candidates = [raw];
  if (raw.includes("%")) {
    try {
      candidates.push(decodeURIComponent(raw));
    } catch {
      // A malformed escape is not an error here; the undecoded form still scans.
    }
  }
  for (const candidate of candidates) {
    const match = candidate.match(JWT_PATTERN);
    if (!match) continue;
    const payload = decodePayload(match[0]);
    const exp = payload?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return Math.floor(exp);
  }
  return null;
}

/**
 * @returns {{expiresAt: string|null, source: "jwt:exp"|"cookie:expires"|"session"}}
 */
export function sessionExpiry(cookies) {
  const jwtExpiries = cookies.map((c) => jwtExpiry(c.value)).filter((e) => e != null);
  if (jwtExpiries.length > 0) {
    // Earliest across tokens: the session is over when the first credential in
    // it dies, and here every one of them is a credential.
    const seconds = Math.min(...jwtExpiries);
    return { expiresAt: new Date(seconds * 1000).toISOString(), source: "jwt:exp" };
  }

  const cookieExpiries = cookies.map((c) => c.expires).filter((e) => typeof e === "number" && e > SESSION_COOKIE && e > 0);
  if (cookieExpiries.length > 0) {
    return { expiresAt: new Date(Math.max(...cookieExpiries) * 1000).toISOString(), source: "cookie:expires" };
  }

  return { expiresAt: null, source: "session" };
}

export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false; // unknown lifetime is not proof of death
  return new Date(expiresAt).getTime() <= now.getTime();
}

export function describeRemaining(expiresAt, now = new Date()) {
  if (!expiresAt) return "unknown";
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.floor(ms / 60_000)}m left`;
  if (hours < 48) return `${Math.floor(hours)}h left`;
  return `${Math.floor(hours / 24)}d left`;
}
