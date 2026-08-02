// The false positive is the bug this component exists to prevent, so it gets
// the most tests. Goal: prove that "authenticated" is reachable ONLY from
// positive evidence, and that every ambiguous page shape lands on "unknown".

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSession, STATES } from "../sessionCheck.js";
import { fakeContext } from "./fakes.js";

const MARKERS = {
  signedIn: '[data-test-id="menu_container-button-profile_photo"]',
  loggedOut: '[data-test-id="menu_container-button-log_in"]',
  hydrated: 'input[placeholder*="Search restaurants" i]',
};
const PROBE = "https://resy.com/cities/san-francisco-ca";
const opts = (counts) => ({ domain: "resy.com", probeUrl: PROBE, markers: MARKERS, settleMs: 0 });

test("a rendered signed-in marker is the only route to authenticated", async () => {
  const context = fakeContext({ counts: { [MARKERS.signedIn]: 1, [MARKERS.hydrated]: 1 } });
  const result = await checkSession(context, opts());
  assert.equal(result.state, STATES.AUTHENTICATED);
});

test("a rendered login control is logged-out, even with the shell present", async () => {
  const context = fakeContext({ counts: { [MARKERS.loggedOut]: 1, [MARKERS.hydrated]: 1 } });
  const result = await checkSession(context, opts());
  assert.equal(result.state, STATES.LOGGED_OUT);
});

// The exact regression: a profile holding nothing but junk cookies renders a
// page with no login control and no avatar. An earlier draft called that
// AUTHENTICATED.
test("junk cookies — hydrated page, no login control, no avatar — is unknown, NOT authenticated", async () => {
  const context = fakeContext({ counts: { [MARKERS.hydrated]: 1 } });
  const result = await checkSession(context, opts());
  assert.equal(result.state, STATES.UNKNOWN);
  assert.match(result.detail, /neither marker/);
});

test("a page that never renders anything is unknown, not authenticated", async () => {
  const context = fakeContext({ counts: {} });
  const result = await checkSession(context, opts());
  assert.equal(result.state, STATES.UNKNOWN);
  assert.match(result.detail, /never rendered/);
});

test("the login control wins over a stray avatar match — ambiguity is never a pass", async () => {
  const context = fakeContext({ counts: { [MARKERS.loggedOut]: 1, [MARKERS.signedIn]: 1 } });
  const result = await checkSession(context, opts());
  assert.equal(result.state, STATES.LOGGED_OUT);
});

test("a domain with no signed-in marker recorded can never be reported authenticated", async () => {
  const loggedOutOnly = { signedIn: null, loggedOut: MARKERS.loggedOut, hydrated: MARKERS.hydrated };
  const context = fakeContext({ counts: { [MARKERS.hydrated]: 1 } });
  const result = await checkSession(context, {
    domain: "resy.com", probeUrl: PROBE, markers: loggedOutOnly, settleMs: 0,
  });
  assert.equal(result.state, STATES.UNKNOWN);
  assert.match(result.detail, /no positive signed-in marker/);
});

test("a domain with no markers at all says so, and names the fix", async () => {
  const context = fakeContext({ counts: {} });
  const result = await checkSession(context, {
    domain: "newsite.com", probeUrl: "https://newsite.com/", markers: {}, settleMs: 0,
  });
  assert.equal(result.state, STATES.UNKNOWN);
  assert.match(result.detail, /--discover/);
  assert.equal(context.pagesOpened, 0, "must refuse before opening a page");
});

test("the probe URL must belong to the session's domain", async () => {
  const context = fakeContext({ counts: {} });
  await assert.rejects(
    () => checkSession(context, { domain: "resy.com", probeUrl: "https://evil.test/", markers: MARKERS }),
    /only ever sent to the domain it belongs to/
  );
});
