import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGuestProfile } from "../guestProfile.js";

const COMPLETE_ENV = {
  BOOKING_GUEST_FIRST_NAME: "Jamie",
  BOOKING_GUEST_LAST_NAME: "Rivera",
  BOOKING_GUEST_PHONE: "555-010-1234",
  BOOKING_GUEST_EMAIL: "jamie.rivera@example.com",
};

test("loadGuestProfile returns a profile when all fields are set", () => {
  assert.deepEqual(loadGuestProfile(COMPLETE_ENV), {
    firstName: "Jamie",
    lastName: "Rivera",
    phone: "555-010-1234",
    email: "jamie.rivera@example.com",
  });
});

test("loadGuestProfile throws listing every missing field", () => {
  assert.throws(() => loadGuestProfile({}), (err) => {
    return (
      /firstName/.test(err.message) &&
      /lastName/.test(err.message) &&
      /phone/.test(err.message) &&
      /email/.test(err.message)
    );
  });
});

test("loadGuestProfile throws when only some fields are missing", () => {
  const partial = { ...COMPLETE_ENV, BOOKING_GUEST_EMAIL: undefined };
  delete partial.BOOKING_GUEST_EMAIL;
  assert.throws(() => loadGuestProfile(partial), /email/);
});
