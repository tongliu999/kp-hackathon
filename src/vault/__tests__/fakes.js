// A synthetic browser, so the auth-check logic can be exercised without a
// network, a Sailbox or a real credential.
//
// It models the one behaviour that matters: a selector that is absent does not
// resolve immediately, it TIMES OUT. The false positive this whole component
// exists to prevent came from treating "not there yet" as "not there", so a
// fake that resolved absent selectors instantly would test the wrong thing.

const ABSENT_TIMEOUT_MS = 5;

/**
 * @param {object} options
 * @param {Record<string, number>} options.counts  selector -> how many render
 * @param {string} options.url
 */
export function fakeContext({ counts = {}, url = "https://resy.com/cities/san-francisco-ca" } = {}) {
  const added = [];
  const cleared = [];
  const visited = [];

  const page = {
    async goto(target) {
      visited.push(target);
      return null;
    },
    url: () => url,
    locator(selector) {
      const count = counts[selector] ?? 0;
      return {
        first: () => ({
          waitFor: () =>
            count > 0
              ? Promise.resolve()
              : new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(`timeout waiting for ${selector}`)), ABSENT_TIMEOUT_MS)
                ),
        }),
        count: async () => count,
      };
    },
    async waitForTimeout() {},
    async close() {},
    async evaluate(fn) {
      return fn();
    },
  };

  return {
    added,
    cleared,
    visited,
    pagesOpened: 0,
    async newPage() {
      this.pagesOpened += 1;
      return page;
    },
    async addCookies(cookies) {
      added.push(...cookies);
    },
    async clearCookies(filter) {
      cleared.push(filter);
    },
  };
}

/** A JWT carrying nothing but the `exp` we want to test against. */
export function jwtWithExp(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, sub: "synthetic" })).toString("base64url");
  return `${header}.${payload}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}

export function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: ".resy.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  };
}

/** A transport that replays a canned response, and records what it was asked. */
export function fakeTransport(name, response) {
  const sent = [];
  return {
    name,
    sent,
    async send(request) {
      sent.push(request);
      return response;
    },
  };
}
