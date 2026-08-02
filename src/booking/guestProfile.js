const REQUIRED_FIELDS = ["firstName", "lastName", "phone", "email"];

// Guest-checkout identity, set once (env), never spoken or re-collected per
// booking — matches the project's "auth handled upfront" intent without
// needing an actual provider account. Real mode only; stub mode never reads
// this.
export function loadGuestProfile(env = process.env) {
  const profile = {
    firstName: env.BOOKING_GUEST_FIRST_NAME,
    lastName: env.BOOKING_GUEST_LAST_NAME,
    phone: env.BOOKING_GUEST_PHONE,
    email: env.BOOKING_GUEST_EMAIL,
  };
  const missing = REQUIRED_FIELDS.filter((key) => !profile[key]);
  if (missing.length > 0) {
    throw new Error(
      `Guest profile is missing required field(s): ${missing.join(", ")}. Set ` +
        "BOOKING_GUEST_FIRST_NAME, BOOKING_GUEST_LAST_NAME, BOOKING_GUEST_PHONE, " +
        "BOOKING_GUEST_EMAIL before booking in real mode."
    );
  }
  return profile;
}

export { REQUIRED_FIELDS };
