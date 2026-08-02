// Domain scoping. One rule, enforced everywhere a credential moves:
//
//   a session may only ever be sent to the domain it was imported for.
//
// This is not defensive dressing. The vault holds sessions for many sites at
// once, so "install the session" and "open the probe page" both take a domain
// and a URL from different places, and a mismatch between them ships a live
// credential to somebody else's host.

export function normalizeDomain(domain) {
  const raw = String(domain ?? "").trim().toLowerCase();
  if (!raw) throw new Error("domain is required");
  return raw.replace(/^\./, "").replace(/^https?:\/\//, "").split("/")[0];
}

/** True when `candidate` is the domain itself or a subdomain of it. */
export function domainMatches(candidate, domain) {
  const host = normalizeDomain(candidate);
  const base = normalizeDomain(domain);
  return host === base || host.endsWith(`.${base}`);
}

export function cookiesForDomain(cookies, domain) {
  return cookies.filter((c) => c.name && c.domain && domainMatches(c.domain, domain));
}

/**
 * Throw unless `url` belongs to `domain`. Call this before any request that
 * carries, or is meant to exercise, a stored session.
 */
export function assertUrlBelongsTo(url, domain) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (!domainMatches(host, domain)) {
    throw new Error(
      `refusing to use a ${normalizeDomain(domain)} session against ${host}: ` +
        "a credential is only ever sent to the domain it belongs to"
    );
  }
  return url;
}
