// Output safety. Names, lengths and dates leave this process; values do not.
//
// The summariser alone would be enough if every print site used it. They will
// not: someone will eventually interpolate an error object or a raw cookie into
// a log line. `redact` is the net under that, and `assertNoSecrets` is the
// tripwire that turns a leak into a failed test instead of a leaked token.

const MIN_REDACTABLE = 8; // shorter values are flags like "1"/"true", and matching them would blank ordinary prose

export function summarizeCookies(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    bytes: Buffer.byteLength(String(c.value ?? ""), "utf8"),
    domain: c.domain,
    httpOnly: Boolean(c.httpOnly),
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
  }));
}

export function secretValues(cookies) {
  return cookies
    .map((c) => String(c.value ?? ""))
    .filter((v) => v.length >= MIN_REDACTABLE);
}

export function redact(text, values) {
  let out = String(text);
  // Longest first: a short value that is a substring of a longer one would
  // otherwise leave the tail of the longer one visible.
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (!value) continue;
    out = out.split(value).join(`«redacted:${value.length}b»`);
  }
  return out;
}

/** Throws if any secret survived into `text`. Used in tests and before printing. */
export function assertNoSecrets(text, values) {
  for (const value of values) {
    if (value && String(text).includes(value)) {
      throw new Error(`refusing to emit output containing a ${value.length}-byte credential value`);
    }
  }
  return text;
}

/**
 * A console whose every argument is redacted before it is written.
 * Wrap the real console once, at the CLI entry point, and leaks become
 * impossible rather than merely discouraged.
 */
export function guardedPrinter(values, sink = console.log) {
  return (...parts) => {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    sink(assertNoSecrets(redact(line, values), values));
  };
}
