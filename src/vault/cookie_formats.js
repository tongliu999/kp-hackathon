// Cookie file parsing, shared by scripts/import-session.mjs and the vault.
//
// Extracted rather than copied: two parsers drift, and the drift shows up as a
// session that imports from one entry point and not the other.
//
// Handles Playwright storageState, Cookie-Editor / EditThisCookie exports, and
// Netscape cookies.txt.

/** Chromium's spellings vs Playwright's. Getting this wrong makes addCookies throw. */
export function sameSite(value) {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "strict") return "Strict";
  if (raw === "none" || raw === "no_restriction") return "None";
  if (raw === "lax") return "Lax";
  return "Lax"; // "unspecified"/absent -- Chromium's own default
}

export const SESSION_COOKIE = -1;

export function expiry(cookie) {
  const value = cookie.expires ?? cookie.expirationDate ?? cookie.expiry;
  if (value == null) return SESSION_COOKIE;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return SESSION_COOKIE;
  return Math.floor(seconds);
}

export function normalizeCookie(cookie) {
  const site = sameSite(cookie.sameSite);
  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain ?? "").trim(),
    path: cookie.path || "/",
    expires: expiry(cookie),
    httpOnly: Boolean(cookie.httpOnly),
    // SameSite=None is only honoured on a secure cookie; Chromium rejects the
    // combination otherwise, and the import fails on a detail nobody would
    // suspect.
    secure: site === "None" ? true : Boolean(cookie.secure),
    sameSite: site,
  };
}

/** Netscape cookies.txt: domain, includeSub, path, secure, expiry, name, value */
export function parseNetscape(text) {
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    cookies.push({
      domain: f[0], path: f[2], secure: f[3] === "TRUE",
      expires: Number(f[4]), name: f[5], value: f.slice(6).join("\t"),
    });
  }
  return cookies;
}

export function parseCookieText(text) {
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    return parseNetscape(text);
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed; // Cookie-Editor et al
  if (Array.isArray(parsed.cookies)) return parsed.cookies; // Playwright storageState
  throw new Error("unrecognised cookie file: expected an array, {cookies:[…]}, or cookies.txt");
}
