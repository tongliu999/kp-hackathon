import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetAll } from "../resetScript.js";
import { recordBooking, listOpenBookings } from "../store.js";
import { stubBooking } from "../stubMode.js";

async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "booking-reset-"));
  const storePath = path.join(dir, "bookings.json");
  try {
    await fn(storePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resetAll is safe to run when there's nothing to cancel", async () => {
  await withTempStore(async (storePath) => {
    const result = await resetAll({ storePath });
    assert.deepEqual(result.cancelled, []);
  });
});

test("resetAll cancels stub bookings without needing a cancelFn", async () => {
  await withTempStore(async (storePath) => {
    const booking = stubBooking({ provider: "opentable", params: { restaurant: "x" } });
    await recordBooking(booking, storePath);

    const result = await resetAll({ storePath });
    assert.deepEqual(result.cancelled, [booking.confirmationRef]);
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("resetAll refuses to silently drop a real booking when no cancelFn is provided", async () => {
  await withTempStore(async (storePath) => {
    await recordBooking({ confirmationRef: "REAL-1", provider: "opentable", stub: false }, storePath);
    await assert.rejects(() => resetAll({ storePath }));
    // still open — the throw happened before markCancelled, nothing silently lost
    assert.equal((await listOpenBookings(storePath)).length, 1);
  });
});

test("resetAll calls cancelFn for real bookings and marks them cancelled", async () => {
  await withTempStore(async (storePath) => {
    await recordBooking({ confirmationRef: "REAL-2", provider: "opentable", stub: false }, storePath);
    const calledWith = [];
    const cancelFn = async (record) => calledWith.push(record.confirmationRef);

    const result = await resetAll({ storePath, cancelFn });
    assert.deepEqual(calledWith, ["REAL-2"]);
    assert.deepEqual(result.cancelled, ["REAL-2"]);
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});
