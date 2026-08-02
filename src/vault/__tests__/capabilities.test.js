// Capability records: measured, never assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyCapability, markersFor, probeUrlFor, describeCapability, KNOWN_MARKERS,
} from "../capabilities.js";

test("an unprobed domain knows nothing, and says so", () => {
  const capability = emptyCapability("brand-new-site.com");
  assert.equal(capability.verdict, null);
  assert.equal(capability.needsTunnel, null);
  assert.equal(capability.refresh, null);
  assert.match(describeCapability(capability), /never probed/);
});

test("a probed domain describes its tunnel requirement in the operator's terms", () => {
  const needsTunnel = describeCapability({ probedAt: "2026-08-02T00:00:00Z", verdict: "residential-only", needsTunnel: true });
  assert.match(needsTunnel, /ssh -N -R 1080 booking\.sail/);
  assert.match(needsTunnel, /socks5:\/\/127\.0\.0\.1:1080/);

  const direct = describeCapability({ probedAt: "2026-08-02T00:00:00Z", verdict: "box-ok", needsTunnel: false });
  assert.match(direct, /authenticates from the box directly/);
});

test("a probe that could not decide does not claim the box is fine", () => {
  const text = describeCapability({ probedAt: "2026-08-02T00:00:00Z", verdict: "broken-request", needsTunnel: null });
  assert.match(text, /tunnel requirement unknown/);
});

test("Resy's markers are seeded from what was confirmed against a live session", () => {
  const markers = markersFor("resy.com", null);
  assert.equal(markers.signedIn, KNOWN_MARKERS["resy.com"].signedIn);
  assert.ok(markers.loggedOut);
  assert.ok(markers.hydrated);
});

test("an unknown domain has no markers, so it can never be reported authenticated", () => {
  assert.deepEqual(markersFor("brand-new-site.com", null), { signedIn: null, loggedOut: null, hydrated: null });
});

test("a recorded marker overrides the seeded one", () => {
  const capability = { markers: { signedIn: "[data-mine]" } };
  assert.equal(markersFor("resy.com", capability).signedIn, "[data-mine]");
  // Unrecorded fields still fall back rather than becoming null.
  assert.equal(markersFor("resy.com", capability).loggedOut, KNOWN_MARKERS["resy.com"].loggedOut);
});

test("probe URLs come from the record first, then what is known, then nothing", () => {
  assert.equal(probeUrlFor("resy.com", { probeUrl: "https://resy.com/mine" }), "https://resy.com/mine");
  assert.match(probeUrlFor("resy.com", null), /^https:\/\/resy\.com\//);
  assert.equal(probeUrlFor("brand-new-site.com", null), null);
});

test("domains are normalised on the way in", () => {
  assert.equal(emptyCapability("Resy.com").domain, "resy.com");
  assert.equal(markersFor(".resy.com", null).signedIn, KNOWN_MARKERS["resy.com"].signedIn);
});
