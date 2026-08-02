import { makeCancelFn } from "./booking/book.js";
import { resetAll } from "./booking/resetScript.js";
import { acquirePage, releaseBrowser } from "./booking/session.js";
import { isStubMode } from "./booking/stubMode.js";
import { listOpenBookings } from "./booking/store.js";

// One-command reset between rehearsals (TON-17): `npm run reset`.
//
// A real open booking needs a real cancelFn, or resetAll refuses -- correctly,
// since marking the store cancelled while the table stays held is worse than
// failing loudly. That session now exists (TON-8), so it is wired in here.
//
// The browser is attached ONLY when something real is actually open: stub-only
// runs and the common "nothing to cancel" case must not require a live Sailbox,
// or the reset between stub rehearsals starts depending on infrastructure it
// does not need.
async function main() {
  const storePath = process.env.BOOKING_STORE_PATH;
  const open = await listOpenBookings(storePath);
  const needsProvider = !isStubMode() && open.some((record) => !record.stub);

  if (!needsProvider) {
    await resetAll({ storePath });
    return;
  }

  const page = await acquirePage();
  try {
    await resetAll({ storePath, cancelFn: makeCancelFn(page) });
  } finally {
    await releaseBrowser();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
