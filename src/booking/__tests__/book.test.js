import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bookStep, makeCancelFn, UnexpectedPageStateError } from "../book.js";
import { resetAll } from "../resetScript.js";
import { listOpenBookings } from "../store.js";
import { ConfirmationAbortedError } from "../confirmGate.js";
import { registerProvider } from "../providers/index.js";

const STUB_ENV = { BOOKING_STUB_MODE: "1" };
const GUEST_ENV = {
  BOOKING_GUEST_FIRST_NAME: "Jamie",
  BOOKING_GUEST_LAST_NAME: "Rivera",
  BOOKING_GUEST_PHONE: "555-010-1234",
  BOOKING_GUEST_EMAIL: "jamie.rivera@example.com",
};
const PARAMS = { restaurant: "Test Bistro", date: "2026-08-05", time: "7:00 PM", partySize: 2 };

async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "booking-book-"));
  const storePath = path.join(dir, "bookings.json");
  try {
    await fn(storePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("book -> reset -> book runs twice in a row with no manual cleanup (stub mode)", async () => {
  await withTempStore(async (storePath) => {
    for (let i = 0; i < 2; i++) {
      const booking = await bookStep({
        provider: "opentable",
        params: PARAMS,
        getYes: async () => "yes",
        storePath,
        env: STUB_ENV,
      });
      assert.equal(booking.status, "booked");

      const { cancelled } = await resetAll({ storePath });
      assert.deepEqual(cancelled, [booking.confirmationRef]);
      assert.deepEqual(await listOpenBookings(storePath), []);
    }
  });
});

test("an aborted confirmation leaves no partial booking behind", async () => {
  await withTempStore(async (storePath) => {
    await assert.rejects(
      () => bookStep({ provider: "opentable", params: PARAMS, getYes: async () => "no", storePath, env: STUB_ENV }),
      ConfirmationAbortedError
    );
    assert.deepEqual(await listOpenBookings(storePath), []);

    await assert.rejects(
      () => bookStep({ provider: "opentable", params: PARAMS, getYes: async () => "", storePath, env: STUB_ENV }),
      ConfirmationAbortedError
    );
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("bookStep rejects incomplete params before ever prompting for confirmation", async () => {
  await withTempStore(async (storePath) => {
    let promptCalled = false;
    await assert.rejects(
      () =>
        bookStep({
          provider: "opentable",
          params: { restaurant: "Test Bistro" },
          getYes: async () => {
            promptCalled = true;
            return "yes";
          },
          storePath,
          env: STUB_ENV,
        }),
      /missing required param/
    );
    assert.equal(promptCalled, false);
  });
});

test("outside stub mode, bookStep requires a live page", async () => {
  await withTempStore(async (storePath) => {
    await assert.rejects(
      () =>
        bookStep({
          provider: "opentable",
          params: PARAMS,
          getYes: async () => "yes",
          storePath,
          env: {},
        }),
      /requires a live `page`/
    );
  });
});

test("bookStep fails loud on empty search results instead of guessing", async () => {
  registerProvider("fake-empty", {
    search: async () => [],
    selectSlot: () => null,
    book: async () => {
      throw new Error("should never be called");
    },
    cancel: async () => {},
  });

  await withTempStore(async (storePath) => {
    await assert.rejects(
      () =>
        bookStep({
          provider: "fake-empty",
          params: PARAMS,
          page: {},
          getYes: async () => "yes",
          storePath,
          env: GUEST_ENV,
        }),
      UnexpectedPageStateError
    );
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("bookStep fails loud when no result matches the requested slot", async () => {
  registerProvider("fake-no-match", {
    search: async () => [{ label: "9:00 PM" }],
    selectSlot: () => null,
    book: async () => {
      throw new Error("should never be called");
    },
    cancel: async () => {},
  });

  await withTempStore(async (storePath) => {
    await assert.rejects(
      () =>
        bookStep({
          provider: "fake-no-match",
          params: PARAMS,
          page: {},
          getYes: async () => "yes",
          storePath,
          env: GUEST_ENV,
        }),
      UnexpectedPageStateError
    );
  });
});

test("bookStep treats a missing confirmationRef as not booked", async () => {
  registerProvider("fake-no-ref", {
    search: async () => [{ label: "7:00 PM" }],
    selectSlot: (results) => results[0],
    book: async () => ({ confirmationRef: null, raw: {} }),
    cancel: async () => {},
  });

  await withTempStore(async (storePath) => {
    await assert.rejects(
      () =>
        bookStep({
          provider: "fake-no-ref",
          params: PARAMS,
          page: {},
          getYes: async () => "yes",
          storePath,
          env: GUEST_ENV,
        }),
      UnexpectedPageStateError
    );
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("bookStep refuses real mode without a complete guest profile, before touching the provider", async () => {
  registerProvider("fake-guest-check", {
    search: async () => {
      throw new Error("should never be called");
    },
    selectSlot: () => null,
    book: async () => {
      throw new Error("should never be called");
    },
    cancel: async () => {},
  });

  await withTempStore(async (storePath) => {
    await assert.rejects(
      () =>
        bookStep({
          provider: "fake-guest-check",
          params: PARAMS,
          page: {},
          getYes: async () => "yes",
          storePath,
          env: {},
        }),
      /Guest profile is missing required field/
    );
  });
});

test("a successful real booking records to the store, passes guestInfo through, and cancels via makeCancelFn", async () => {
  const cancelCalls = [];
  let receivedGuestInfo = null;
  registerProvider("fake-real", {
    search: async () => [{ label: "7:00 PM" }],
    selectSlot: (results) => results[0],
    book: async (page, slot, guestInfo) => {
      receivedGuestInfo = guestInfo;
      return { confirmationRef: "REAL-CONF-1", raw: { ok: true } };
    },
    cancel: async (page, record) => cancelCalls.push(record.confirmationRef),
  });

  await withTempStore(async (storePath) => {
    const fakePage = {};
    const booking = await bookStep({
      provider: "fake-real",
      params: PARAMS,
      page: fakePage,
      getYes: async () => "yes",
      storePath,
      env: GUEST_ENV,
    });
    assert.equal(booking.confirmationRef, "REAL-CONF-1");
    assert.equal(booking.stub, false);
    assert.deepEqual(receivedGuestInfo, {
      firstName: "Jamie",
      lastName: "Rivera",
      phone: "555-010-1234",
      email: "jamie.rivera@example.com",
    });

    const { cancelled } = await resetAll({ storePath, cancelFn: makeCancelFn(fakePage) });
    assert.deepEqual(cancelled, ["REAL-CONF-1"]);
    assert.deepEqual(cancelCalls, ["REAL-CONF-1"]);
  });
});
