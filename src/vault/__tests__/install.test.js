// Installing a session into a browser, and the round trip that proves it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installSession, explainFailure } from "../install.js";
import { emptyVault, putSession, selectSession } from "../vault.js";
import { markersFor, probeUrlFor } from "../capabilities.js";
import { STATES } from "../sessionCheck.js";
import { fakeContext, cookie, jwtWithExp } from "./fakes.js";

const HOUR = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const MARKERS = markersFor("resy.com", null);
const PROBE = probeUrlFor("resy.com", null);

function storedSession({ expSeconds = nowSeconds() + 30 * 24 * HOUR, extra = [] } = {}) {
  const data = emptyVault();
  putSession(data, {
    domain: "resy.com",
    label: "tong",
    cookies: [cookie("auth_token", jwtWithExp(expSeconds)), ...extra],
    mailbox: "tong@ours.test",
  });
  return data;
}

test("ROUND TRIP: store -> select -> install -> authenticated on positive evidence", async () => {
  const data = storedSession();
  const record = selectSession(data, { domain: "resy.com" });
  const context = fakeContext({ counts: { [MARKERS.signedIn]: 1, [MARKERS.hydrated]: 1 } });

  const result = await installSession(context, record, { probeUrl: PROBE, markers: MARKERS });

  assert.equal(result.state, STATES.AUTHENTICATED);
  assert.equal(result.installed, 1);
  assert.deepEqual(context.added.map((c) => c.name), ["auth_token"]);
});

test("stale cookies for the domain are cleared before the new ones go in", async () => {
  const record = selectSession(storedSession(), { domain: "resy.com" });
  const context = fakeContext({ counts: { [MARKERS.signedIn]: 1 } });
  await installSession(context, record, { probeUrl: PROBE, markers: MARKERS });
  assert.deepEqual(context.cleared, [{ domain: ".resy.com" }, { domain: "resy.com" }]);
});

// The demo-killer: cookies install fine and the check says nothing is wrong.
test("an installed-but-rejected session reports logged-out, not success", async () => {
  const record = selectSession(storedSession(), { domain: "resy.com" });
  const context = fakeContext({ counts: { [MARKERS.loggedOut]: 1, [MARKERS.hydrated]: 1 } });
  const result = await installSession(context, record, { probeUrl: PROBE, markers: MARKERS });
  assert.equal(result.state, STATES.LOGGED_OUT);
});

test("a garbage session that renders no marker is unknown, never authenticated", async () => {
  const data = emptyVault();
  putSession(data, { domain: "resy.com", label: "junk", cookies: [cookie("junk", "z".repeat(40))] });
  const record = selectSession(data, { domain: "resy.com" });
  const context = fakeContext({ counts: { [MARKERS.hydrated]: 1 } });
  const result = await installSession(context, record, { probeUrl: PROBE, markers: MARKERS });
  assert.equal(result.state, STATES.UNKNOWN);
});

test("an expired session is refused at the install boundary too, not just at select", async () => {
  const data = storedSession({ expSeconds: nowSeconds() - HOUR });
  // Reach past selectSession deliberately: a caller holding a stale record must
  // not be able to route around the refusal.
  const record = data.domains["resy.com"].sessions.tong;
  const context = fakeContext({ counts: { [MARKERS.signedIn]: 1 } });
  await assert.rejects(
    () => installSession(context, record, { probeUrl: PROBE, markers: MARKERS }),
    /refusing to install expired session resy\.com\/tong/
  );
  assert.deepEqual(context.added, [], "nothing may reach the browser");
});

test("a probe URL on another domain is refused before any cookie is installed", async () => {
  const record = selectSession(storedSession(), { domain: "resy.com" });
  const context = fakeContext({ counts: {} });
  await assert.rejects(
    () => installSession(context, record, { probeUrl: "https://evil.test/", markers: MARKERS }),
    /only ever sent to the domain it belongs to/
  );
  assert.deepEqual(context.added, []);
});

test("a domain with no probe URL refuses rather than guessing one", async () => {
  const data = emptyVault();
  putSession(data, {
    domain: "newsite.com", label: "a",
    cookies: [cookie("s", "q".repeat(40), { domain: ".newsite.com" })],
  });
  const record = selectSession(data, { domain: "newsite.com" });
  await assert.rejects(
    () => installSession(fakeContext({}), record, { probeUrl: probeUrlFor("newsite.com", null), markers: {} }),
    /no probe URL known for newsite\.com/
  );
});

test("the failure explanation points at the tunnel when the capability says so", () => {
  const text = explainFailure(STATES.LOGGED_OUT, {
    domain: "resy.com", label: "tong",
    capability: { needsTunnel: true, verdict: "residential-only" },
  });
  assert.match(text, /ssh -N -R 1080 booking\.sail/);
  assert.match(text, /socks5:\/\/127\.0\.0\.1:1080/);
});

test("the inconclusive explanation names the missing marker as the fix", () => {
  const text = explainFailure(STATES.UNKNOWN, { domain: "newsite.com", label: "a", capability: { markers: {} } });
  assert.match(text, /No positive signed-in marker/);
  assert.match(text, /probe newsite\.com --discover/);
});
