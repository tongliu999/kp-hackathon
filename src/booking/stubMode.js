const STUB_ENV_VAR = "BOOKING_STUB_MODE";

export function isStubMode(env = process.env) {
  return env[STUB_ENV_VAR] === "1" || env[STUB_ENV_VAR] === "true";
}

// Same return shape as a real booking (see TON-11), so the voice layer can't tell the difference.
// The console line is the tell for us during rehearsal — a stub run must never look like a real one in the logs.
export function stubBooking({ provider, params }) {
  const confirmationRef = `STUB-${provider.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  console.log(`[STUB MODE] no provider contacted — fake booking ref=${confirmationRef}`);
  return {
    confirmationRef,
    provider,
    params,
    stub: true,
    createdAt: new Date().toISOString(),
    raw: null,
  };
}

export { STUB_ENV_VAR };
