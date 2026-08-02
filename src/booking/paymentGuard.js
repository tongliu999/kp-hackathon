// Anything the agent must never fill in or click near, regardless of what
// upstream confirmation already happened. Entering financial credentials is a
// hard line, not a judgment call — see providers/resy.js's fillGuestInfo.
const PAYMENT_PATTERN =
  /card number|credit card|debit card|cvv|cvc|security code|expir(y|ation)|billing address/i;

export function isPaymentField(label) {
  return PAYMENT_PATTERN.test(String(label ?? ""));
}

export class PaymentFieldEncounteredError extends Error {
  constructor(label) {
    super(
      `Refusing to continue: encountered a payment-shaped field ("${label}"). ` +
        "The agent never enters financial credentials — this booking needs a human " +
        "to finish the payment step, same as the original TON-8 login did."
    );
    this.name = "PaymentFieldEncounteredError";
  }
}
