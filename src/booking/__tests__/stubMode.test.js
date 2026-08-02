import { test } from "node:test";
import assert from "node:assert/strict";
import { isStubMode, stubBooking, STUB_ENV_VAR } from "../stubMode.js";

test("isStubMode reads the flag from an injected env", () => {
  assert.equal(isStubMode({ [STUB_ENV_VAR]: "1" }), true);
  assert.equal(isStubMode({ [STUB_ENV_VAR]: "true" }), true);
  assert.equal(isStubMode({ [STUB_ENV_VAR]: "0" }), false);
  assert.equal(isStubMode({}), false);
});

test("stubBooking never touches a provider and has the same shape as a real booking", () => {
  const params = { restaurant: "Test Bistro", date: "2026-08-05", time: "7:00 PM", partySize: 2 };
  const booking = stubBooking({ provider: "opentable", params });

  assert.equal(booking.stub, true);
  assert.match(booking.confirmationRef, /^STUB-OPENTABLE-/);
  assert.equal(booking.provider, "opentable");
  assert.deepEqual(booking.params, params);
  assert.equal(typeof booking.createdAt, "string");
});

test("stubBooking logs the [STUB MODE] tell so a stub run can't be mistaken for real", () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    stubBooking({ provider: "resy", params: { restaurant: "x", date: "x", time: "x", partySize: 1 } });
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((line) => line.includes("[STUB MODE]")));
});
