import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { bookStep } from "./book.js";
import { resetAll } from "./resetScript.js";
import { listOpenBookings } from "./store.js";

const STUB_ENV = Object.freeze({ BOOKING_STUB_MODE: "1" });

function requirePositiveRunCount(runs) {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("rehearsal runs must be a positive integer");
  }
}

async function assertClean(storePath) {
  const open = await listOpenBookings(storePath);
  if (open.length !== 0) {
    throw new Error(
      `rehearsal reset left ${open.length} open booking(s): ${open
        .map((record) => record.confirmationRef)
        .join(", ")}`
    );
  }
}

export async function verifyOfflineVideo(videoPath) {
  if (!videoPath) return null;
  const bytes = await readFile(videoPath);
  if (bytes.length === 0) {
    throw new Error(`cold-path video is empty: ${videoPath}`);
  }
  return { path: videoPath, bytes: bytes.length };
}

export async function runStubRehearsals({
  runs = 3,
  request,
  confirmationResponse,
  provider = "resy",
  params,
  storePath,
  coldVideoPath,
  now = () => performance.now(),
} = {}) {
  requirePositiveRunCount(runs);
  if (!request?.trim()) throw new Error("rehearsal request is required");
  if (!confirmationResponse?.trim()) {
    throw new Error("rehearsal confirmation response is required");
  }

  const video = await verifyOfflineVideo(coldVideoPath);
  await resetAll({ storePath });
  await assertClean(storePath);

  const results = [];
  try {
    for (let index = 0; index < runs; index += 1) {
      const startedAt = now();
      const booking = await bookStep({
        provider,
        params,
        getYes: async () => confirmationResponse,
        storePath,
        env: STUB_ENV,
      });

      const open = await listOpenBookings(storePath);
      if (open.length !== 1 || open[0].confirmationRef !== booking.confirmationRef) {
        throw new Error(`run ${index + 1} did not create exactly one tracked booking`);
      }

      const reset = await resetAll({ storePath });
      await assertClean(storePath);
      if (!reset.cancelled.includes(booking.confirmationRef)) {
        throw new Error(`run ${index + 1} reset did not cancel its booking`);
      }

      results.push({
        run: index + 1,
        request,
        confirmationRef: booking.confirmationRef,
        elapsedMs: Math.max(0, now() - startedAt),
        cleanAfterReset: true,
      });
    }
  } finally {
    await resetAll({ storePath });
  }
  await assertClean(storePath);

  return { mode: "stub", runs: results, video };
}
