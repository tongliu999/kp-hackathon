import { listOpenBookings, markCancelled } from "./store.js";

// cancelFn(record) makes the real provider cancellation call — injected once TON-11 lands.
// Until then, real (non-stub) open bookings make resetAll throw rather than silently
// leaving a live booking uncancelled between rehearsals.
export async function resetAll({ cancelFn, storePath } = {}) {
  const open = await listOpenBookings(storePath);

  if (open.length === 0) {
    console.log("[reset] nothing to cancel.");
    return { cancelled: [] };
  }

  const cancelled = [];
  for (const record of open) {
    if (record.stub) {
      console.log(`[reset] stub booking ${record.confirmationRef} — no provider call needed.`);
    } else if (cancelFn) {
      await cancelFn(record);
    } else {
      throw new Error(
        `[reset] ${record.confirmationRef} is a real booking but no cancelFn was provided — refusing to leave it uncancelled.`
      );
    }
    await markCancelled(record.confirmationRef, storePath);
    cancelled.push(record.confirmationRef);
  }

  console.log(`[reset] cancelled ${cancelled.length} booking(s): ${cancelled.join(", ")}`);
  return { cancelled };
}
