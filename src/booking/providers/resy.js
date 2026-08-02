// Resy adapter — see providers/index.js for the contract and the caveat about
// selectors being unverified against a live session (blocked on TON-8's human login).

const BASE_URL = "https://resy.com";

export async function search(page, { restaurant, date, time, partySize }) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  await page.getByPlaceholder(/search restaurants/i).fill(restaurant);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");

  const cards = page.getByRole("link", { name: new RegExp(escapeRegExp(restaurant), "i") });
  const count = await cards.count();
  const results = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    results.push({ handle: card, label: await card.innerText() });
  }

  if (results.length > 0 && (date || time || partySize)) {
    await results[0].handle.click();
    await page.waitForLoadState("networkidle");
    if (date) await page.getByLabel(/date/i).fill(date);
    if (partySize) await page.getByRole("button", { name: /party size|seats/i }).click();
    if (partySize) await page.getByRole("option", { name: String(partySize) }).click();
  }

  const slotButtons = page.getByRole("button", { name: /\d{1,2}:\d{2}\s?(am|pm)/i });
  const slotCount = await slotButtons.count();
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    const btn = slotButtons.nth(i);
    slots.push({ handle: btn, label: (await btn.innerText()).trim() });
  }
  return slots;
}

export function selectSlot(results, { time }) {
  if (!time) return results[0] ?? null;
  return results.find((r) => r.label.includes(time)) ?? null;
}

export async function book(page, slot) {
  await slot.handle.click();
  const reserveButton = page.getByRole("button", { name: /reserve|book now/i });
  await reserveButton.waitFor({ state: "visible", timeout: 15_000 });
  await reserveButton.click();

  const confirmButton = page.getByRole("button", { name: /confirm( reservation)?/i });
  await confirmButton.waitFor({ state: "visible", timeout: 15_000 });
  await confirmButton.click();

  const refLocator = page.getByText(/reservation (confirmed|number)[:\s]/i);
  await refLocator.waitFor({ state: "visible", timeout: 15_000 });
  const text = await refLocator.innerText();
  const match = text.match(/([A-Z0-9]{5,})/);
  if (!match) {
    throw new Error(`Resy: confirmation text found but no ref could be parsed out of "${text}"`);
  }

  return { confirmationRef: match[1], raw: { text } };
}

export async function cancel(page, record) {
  await page.goto(`${BASE_URL}/account/reservations`, { waitUntil: "domcontentloaded" });
  const row = page.getByText(record.confirmationRef);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const cancelButton = page
    .locator("li,div", { has: row })
    .getByRole("button", { name: /cancel/i })
    .first();
  await cancelButton.click();
  const confirmCancel = page.getByRole("button", { name: /yes, cancel|confirm/i });
  await confirmCancel.waitFor({ state: "visible", timeout: 10_000 });
  await confirmCancel.click();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
