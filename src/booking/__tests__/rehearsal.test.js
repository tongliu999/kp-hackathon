import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runStubRehearsals, verifyOfflineVideo } from "../rehearsal.js";
import { listOpenBookings } from "../store.js";

const PARAMS = {
  restaurant: "Italian restaurant in San Francisco",
  date: "tomorrow evening",
  time: "7:00 PM",
  partySize: 2,
};

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "booking-rehearsal-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("three consecutive stub rehearsals reset to a clean store", async () => {
  await withTempDir(async (dir) => {
    const storePath = path.join(dir, "bookings.json");
    let tick = 0;
    const result = await runStubRehearsals({
      runs: 3,
      request: "Book a table for two.",
      confirmationResponse: "yes",
      params: PARAMS,
      storePath,
      now: () => (tick += 10),
    });

    assert.equal(result.mode, "stub");
    assert.equal(result.runs.length, 3);
    assert.deepEqual(
      result.runs.map((run) => run.elapsedMs),
      [10, 10, 10]
    );
    assert.ok(result.runs.every((run) => run.cleanAfterReset));
    assert.deepEqual(await listOpenBookings(storePath), []);
  });
});

test("cold video check reads the complete local file and rejects an empty file", async () => {
  await withTempDir(async (dir) => {
    const videoPath = path.join(dir, "cold.mp4");
    await writeFile(videoPath, Buffer.from("offline-video"));
    assert.deepEqual(await verifyOfflineVideo(videoPath), {
      path: videoPath,
      bytes: 13,
    });

    const emptyPath = path.join(dir, "empty.mp4");
    await writeFile(emptyPath, Buffer.alloc(0));
    await assert.rejects(() => verifyOfflineVideo(emptyPath), /video is empty/);
  });
});

test("rehearsal validation fails before creating a booking", async () => {
  await assert.rejects(
    () =>
      runStubRehearsals({
        runs: 0,
        request: "Book dinner",
        confirmationResponse: "yes",
        params: PARAMS,
      }),
    /positive integer/
  );
});
