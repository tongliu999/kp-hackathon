import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmGate, ConfirmationAbortedError } from "../confirmGate.js";

test("confirmGate resolves on 'yes'", async () => {
  await assert.doesNotReject(() => confirmGate("book it", async () => "yes"));
});

test("confirmGate resolves on 'y' (case/whitespace insensitive)", async () => {
  await assert.doesNotReject(() => confirmGate("book it", async () => "  Y \n"));
});

test("confirmGate aborts on an explicit no", async () => {
  await assert.rejects(() => confirmGate("book it", async () => "no"), ConfirmationAbortedError);
});

test("confirmGate aborts on silence (empty string)", async () => {
  await assert.rejects(() => confirmGate("book it", async () => ""), ConfirmationAbortedError);
});

test("confirmGate aborts on silence (null/undefined)", async () => {
  await assert.rejects(() => confirmGate("book it", async () => null), ConfirmationAbortedError);
  await assert.rejects(() => confirmGate("book it", async () => undefined), ConfirmationAbortedError);
});

test("confirmGate aborts on ambiguous responses", async () => {
  for (const response of ["yeah", "sure", "yes please", "maybe", "yup"]) {
    await assert.rejects(
      () => confirmGate("book it", async () => response),
      ConfirmationAbortedError,
      `expected "${response}" to abort`
    );
  }
});
