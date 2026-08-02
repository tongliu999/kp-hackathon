// OpenTable adapter — DEAD from this environment as of 2026-08-02: the domain is blocked
// at the network edge (Akamai "Access Denied") before any page loads. Selectors below were
// never verified live and can't be from here. Kept for interface parity / in case a future
// environment reaches the domain fine; use resy.js instead. See providers/index.js.

const BASE_URL = "https://www.opentable.com";

export async function search(page, { restaurant, date, time, partySize }) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  await page.getByPlaceholder(/location, restaurant, or cuisine/i).fill(restaurant);
  if (date) await page.getByLabel(/date/i).fill(date);
  if (time) await page.getByLabel(/time/i).selectOption({ label: time });
  if (partySize) await page.getByLabel(/party size|number of guests/i).selectOption(String(partySize));

  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");

  const cards = page.getByRole("link", { name: new RegExp(escapeRegExp(restaurant), "i") });
  const count = await cards.count();
  const results = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    results.push({ handle: card, label: await card.innerText() });
  }
  return results;
}

export function selectSlot(results, { time }) {
  if (!time) return results[0] ?? null;
  return results.find((r) => r.label.includes(time)) ?? null;
}

export async function book(page, slot, _guestInfo) {
  await slot.handle.click();
  const confirmButton = page.getByRole("button", { name: /confirm reservation|complete reservation/i });
  await confirmButton.waitFor({ state: "visible", timeout: 15_000 });
  await confirmButton.click();

  const refLocator = page.getByText(/confirmation (number|code)[:\s]/i);
  await refLocator.waitFor({ state: "visible", timeout: 15_000 });
  const text = await refLocator.innerText();
  const match = text.match(/([A-Z0-9]{5,})/);
  if (!match) {
    throw new Error(`OpenTable: confirmation text found but no ref could be parsed out of "${text}"`);
  }

  return { confirmationRef: match[1], raw: { text } };
}

export async function cancel(page, record) {
  await page.goto(`${BASE_URL}/dine/profile/reservations`, { waitUntil: "domcontentloaded" });
  const row = page.getByText(record.confirmationRef);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const cancelButton = page
    .locator("li,div", { has: row })
    .getByRole("button", { name: /cancel/i })
    .first();
  await cancelButton.click();
  const confirmCancel = page.getByRole("button", { name: /yes, cancel|confirm cancellation/i });
  await confirmCancel.waitFor({ state: "visible", timeout: 10_000 });
  await confirmCancel.click();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
