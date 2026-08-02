import { readFile } from "node:fs/promises";
import path from "node:path";

import { runStubRehearsals } from "../src/booking/rehearsal.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseRuns(value) {
  if (value === undefined) return 3;
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return runs;
}

const configPath = path.join(process.cwd(), "demo", "demo_config.json");
const storePath = option("--store") ?? path.join(process.cwd(), "data", "rehearsal-bookings.json");
const coldVideoPath = option("--cold-video");

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const summary = await runStubRehearsals({
    runs: parseRuns(option("--runs")),
    request: config.exact_spoken_request,
    confirmationResponse: config.confirmation_response,
    params: {
      restaurant: "Italian restaurant in San Francisco",
      date: "tomorrow evening",
      time: "7:00 PM",
      partySize: 2,
    },
    storePath,
    coldVideoPath,
  });

  console.log(`\n[rehearsal] exact request: ${config.exact_spoken_request}`);
  for (const result of summary.runs) {
    console.log(
      `[rehearsal] PASS ${result.run}/${summary.runs.length} ${result.elapsedMs.toFixed(1)} ms; reset clean`
    );
  }
  if (summary.video) {
    console.log(
      `[rehearsal] PASS cold video readable offline: ${summary.video.path} (${summary.video.bytes} bytes)`
    );
  } else {
    console.log("[rehearsal] NOT CHECKED cold video (pass --cold-video <local-file>)");
  }
  console.log(`[rehearsal] PASS ${summary.runs.length} consecutive stub runs; zero open bookings`);
}

main().catch((error) => {
  console.error(`[rehearsal] FAIL ${error.message}`);
  process.exitCode = 1;
});
