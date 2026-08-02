import { resetAll } from "./booking/resetScript.js";

// One-command reset for TON-17: `node src/index.js`. Clears stub bookings unattended and
// clears real ones too once a live cancelFn is wired in below — that needs a Playwright
// page attached to the authenticated Sailbox session, which doesn't exist yet (blocked on
// the human login in TON-8). Until then a real open booking makes this exit non-zero rather
// than silently leaving it live, which is the safe failure mode between rehearsals.
async function main() {
  await resetAll({});
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
