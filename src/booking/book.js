import { confirmGate } from "./confirmGate.js";
import { recordBooking } from "./store.js";
import { isStubMode, stubBooking } from "./stubMode.js";
import { getProvider } from "./providers/index.js";

const REQUIRED_PARAMS = ["restaurant", "date", "time", "partySize"];

export class UnexpectedPageStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnexpectedPageStateError";
  }
}

function requireParams(params) {
  const missing = REQUIRED_PARAMS.filter((key) => !params?.[key]);
  if (missing.length > 0) {
    throw new Error(`bookStep is missing required param(s): ${missing.join(", ")}`);
  }
}

function describeBooking(provider, { restaurant, date, time, partySize }) {
  return `book ${restaurant} on ${provider} for ${partySize} at ${time} on ${date}`;
}

// The executor's irreversible-step type for Track C. Called by the orchestrator with
// concrete params; nothing else should call this directly (TON-11).
//
// Order matters for TON-12's invariant: confirmGate is awaited before anything else touches
// the store or a real page, so an abort (no / silence / ambiguous) leaves zero trace — not a
// half-written record, not a page mid-click.
export async function bookStep({ provider, params, page, getYes, storePath, env = process.env }) {
  requireParams(params);
  const description = describeBooking(provider, params);
  await confirmGate(description, getYes);

  if (isStubMode(env)) {
    const booking = stubBooking({ provider, params });
    return recordBooking(booking, storePath);
  }

  if (!page) {
    throw new Error(
      "bookStep requires a live `page` (a Playwright Page attached to the authenticated Sailbox session) outside stub mode."
    );
  }

  const adapter = getProvider(provider);

  const results = await adapter.search(page, params);
  if (!results || results.length === 0) {
    throw new UnexpectedPageStateError(
      `${provider}: search for "${params.restaurant}" returned no results — refusing to guess.`
    );
  }

  const slot = adapter.selectSlot(results, params);
  if (!slot) {
    throw new UnexpectedPageStateError(
      `${provider}: no slot matched time=${params.time} party=${params.partySize} among ${results.length} result(s) — refusing to click blind.`
    );
  }

  const { confirmationRef, raw } = await adapter.book(page, slot);
  if (!confirmationRef) {
    throw new UnexpectedPageStateError(
      `${provider}: book() returned without a confirmation ref — treating as not booked.`
    );
  }

  return recordBooking(
    { confirmationRef, provider, params, raw, createdAt: new Date().toISOString() },
    storePath
  );
}

// Bridges a real booking record to resetScript.js's cancelFn hook (TON-17). `page` is the
// same live Playwright Page the booking was made on.
export function makeCancelFn(page) {
  return async function cancelFn(record) {
    const adapter = getProvider(record.provider);
    await adapter.cancel(page, record);
  };
}
