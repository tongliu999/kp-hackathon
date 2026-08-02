import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One-command reset between rehearsals (TON-17): `npm run reset`.
//
// Delegates to the bridge rather than calling resetAll() directly, so it takes
// the same route every other caller does. That matters in real mode: the
// booking store and the browser both live inside the Sailbox, and a local
// resetAll() would read an empty local store and cheerfully report "nothing to
// cancel" while a real table stayed held.
const BRIDGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "booking_bridge.mjs"
);

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
child.stdin.end(JSON.stringify({ action: "booking.reset", arguments: {} }));

let out = "";
child.stdout.on("data", (chunk) => (out += chunk));
child.on("close", () => {
  const line = out.trim().split("\n").filter(Boolean).pop();
  if (!line) {
    console.error("[reset] bridge produced no output");
    process.exitCode = 1;
    return;
  }
  const payload = JSON.parse(line);
  if (!payload.ok) {
    console.error(payload.error);
    process.exitCode = 1;
    return;
  }
  const cancelled = payload.result.cancelled ?? [];
  console.log(
    cancelled.length
      ? `[reset] cancelled ${cancelled.length} booking(s): ${cancelled.join(", ")}`
      : "[reset] nothing to cancel."
  );
});
