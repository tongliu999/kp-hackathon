export class ConfirmationAbortedError extends Error {
  constructor(reason) {
    super(`Booking aborted: ${reason}`);
    this.name = "ConfirmationAbortedError";
  }
}

// getYes(promptText) resolves to whatever the caller heard back — CLI stdin for now,
// swapped for a Cartesia transcript once the voice layer exists. Anything short of an
// explicit "yes" aborts: wrong word, silence, empty string, all treated the same.
export async function confirmGate(description, getYes) {
  const readback = `About to: ${description}. Confirm?`;
  const response = await getYes(readback);
  const normalized = String(response ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");

  if (normalized !== "yes" && normalized !== "y" && normalized !== "yes book it") {
    const reason = normalized ? `heard "${normalized}", not an affirmative yes` : "no response (silence aborts)";
    throw new ConfirmationAbortedError(reason);
  }

  return true;
}

export async function cliGetYes(promptText) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${promptText} `);
  } finally {
    rl.close();
  }
}
