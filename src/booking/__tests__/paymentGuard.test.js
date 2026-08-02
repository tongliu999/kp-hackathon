import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaymentField, PaymentFieldEncounteredError } from "../paymentGuard.js";

test("isPaymentField recognizes common payment field labels", () => {
  for (const label of [
    "Card number",
    "Credit Card",
    "CVV",
    "CVC",
    "Security code",
    "Expiration date",
    "Expiry",
    "Billing address",
  ]) {
    assert.equal(isPaymentField(label), true, `expected "${label}" to be flagged`);
  }
});

test("isPaymentField does not flag ordinary contact fields", () => {
  for (const label of ["First name", "Last name", "Phone", "Email", "Special requests"]) {
    assert.equal(isPaymentField(label), false, `expected "${label}" not to be flagged`);
  }
});

test("PaymentFieldEncounteredError names the offending field", () => {
  const err = new PaymentFieldEncounteredError("Card number");
  assert.match(err.message, /Card number/);
  assert.equal(err.name, "PaymentFieldEncounteredError");
});
