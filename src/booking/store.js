import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "bookings.json");

async function readStore(storePath) {
  try {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeStore(records, storePath) {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(records, null, 2));
}

export async function recordBooking(booking, storePath = DEFAULT_STORE_PATH) {
  if (!booking.confirmationRef) {
    throw new Error("recordBooking requires a confirmationRef — that's the whole point of the store.");
  }
  const records = await readStore(storePath);
  const record = {
    confirmationRef: booking.confirmationRef,
    provider: booking.provider,
    status: "booked",
    stub: Boolean(booking.stub),
    createdAt: booking.createdAt ?? new Date().toISOString(),
    cancelledAt: null,
    raw: booking.raw ?? null,
  };
  records.push(record);
  await writeStore(records, storePath);
  return record;
}

export async function listOpenBookings(storePath = DEFAULT_STORE_PATH) {
  const records = await readStore(storePath);
  return records.filter((r) => r.status === "booked");
}

export async function markCancelled(confirmationRef, storePath = DEFAULT_STORE_PATH) {
  const records = await readStore(storePath);
  const record = records.find((r) => r.confirmationRef === confirmationRef);
  if (!record) return null;
  record.status = "cancelled";
  record.cancelledAt = new Date().toISOString();
  await writeStore(records, storePath);
  return record;
}

export { DEFAULT_STORE_PATH };
