import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordBooking, listOpenBookings, markCancelled } from "../store.js";

async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "booking-store-"));
  const storePath = path.join(dir, "bookings.json");
  try {
    await fn(storePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordBooking requires a confirmationRef", async () => {
  await withTempStore(async (storePath) => {
    await assert.rejects(() => recordBooking({ provider: "opentable" }, storePath));
  });
});

test("listOpenBookings is empty against a store file that doesn't exist yet", async () => {
  await withTempStore(async (storePath) => {
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("recordBooking -> listOpenBookings -> markCancelled round-trips", async () => {
  await withTempStore(async (storePath) => {
    await recordBooking({ confirmationRef: "ABC123", provider: "opentable" }, storePath);
    let open = await listOpenBookings(storePath);
    assert.equal(open.length, 1);
    assert.equal(open[0].status, "booked");

    const cancelled = await markCancelled("ABC123", storePath);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cancelledAt);

    open = await listOpenBookings(storePath);
    assert.equal(open.length, 0);
  });
});

test("markCancelled on an unknown ref returns null instead of throwing", async () => {
  await withTempStore(async (storePath) => {
    assert.equal(await markCancelled("NOPE", storePath), null);
  });
});
