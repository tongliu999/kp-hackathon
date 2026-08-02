// Resy adapter — guest checkout, no account/login required (verified live
// 2026-08-02 against a real venue page: "Reserve Now" sits behind no auth
// wall). This replaces the earlier login-dependent design from TON-8 — Resy
// never actually persisted a logged-in session across a fresh connection, so
// the guest-checkout path sidesteps that problem entirely rather than fixing
// it.
//
// Verified live, this session: venue page -> click a time slot -> "Complete
// Your Reservation" modal -> "Reserve Now" button, no login gate in the way.
// NOT verified live: the guest contact-info screen and the true final submit
// button, past that point — clicking further on a real venue would have
// created a real reservation, which needs a human's go-ahead, not an
// assistant's exploration. fillGuestInfo() below is written defensively
// (label-pattern matching, refuses anything payment-shaped, throws loud if it
// can't find what it expects) specifically because that screen is unverified.
// Smoke-test this against a real venue, watching, before trusting it on stage.

import { isPaymentField, PaymentFieldEncounteredError } from "../paymentGuard.js";

const BASE_URL = "https://resy.com";

export async function search(page, { restaurant, date, partySize }) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder(/search restaurants/i).fill(restaurant);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  const links = await page.getByRole("link").all();
  const seen = new Set();
  const results = [];
  for (const link of links) {
    const href = await link.getAttribute("href").catch(() => null);
    if (!href || !href.includes("/venues/") || seen.has(href)) continue;
    seen.add(href);
    const label = (await link.innerText().catch(() => "")).trim();
    const url = new URL(href, BASE_URL);
    if (date) url.searchParams.set("date", date);
    if (partySize) url.searchParams.set("seats", String(partySize));
    results.push({ url: url.toString(), label });
    if (results.length >= 5) break;
  }
  return results;
}

export function selectSlot(results, { time }) {
  const top = results[0];
  return top ? { url: top.url, requestedTime: time ?? null } : null;
}

export async function book(page, slot, guestInfo) {
  await page.goto(slot.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const reservationButtons = page.locator('[data-testid*="reservation-button"]');
  const count = await reservationButtons.count();
  if (count === 0) {
    throw new Error(`Resy: no bookable time slots found at ${slot.url}.`);
  }

  const chosen = await pickTimeButton(reservationButtons, count, slot.requestedTime);
  await clickViaBoundingBox(page, chosen);
  await page.waitForTimeout(1500);

  const reserveNow = page.getByRole("button", { name: /reserve now/i });
  await reserveNow.waitFor({ state: "visible", timeout: 10_000 });
  await reserveNow.click({ force: true });
  await page.waitForTimeout(2000);

  await fillGuestInfo(page, guestInfo);

  const submit = page.getByRole("button", {
    name: /^(confirm|complete reservation|book now|submit reservation)$/i,
  });
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  await submit.click({ force: true });
  await page.waitForTimeout(2500);

  const refLocator = page.getByText(/confirmation (number|code)[:\s]/i);
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

async function pickTimeButton(reservationButtons, count, requestedTime) {
  if (!requestedTime) return reservationButtons.first();
  const normalized = requestedTime.replace(/\s+/g, "").toLowerCase();
  for (let i = 0; i < count; i++) {
    const btn = reservationButtons.nth(i);
    const label = (await btn.innerText().catch(() => "")).replace(/\s+/g, "").toLowerCase();
    if (label.includes(normalized)) return btn;
  }
  return reservationButtons.first();
}

async function clickViaBoundingBox(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Resy: reservation button located but not visible/clickable.");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// Unverified surface (see module header). Scans for payment fields FIRST,
// before filling anything — a form that mixes contact and payment fields on
// one screen must never get partial input from the agent.
async function fillGuestInfo(page, guestInfo) {
  const labeledInputs = page.locator("label");
  const labelCount = await labeledInputs.count();
  for (let i = 0; i < labelCount; i++) {
    const text = await labeledInputs.nth(i).innerText().catch(() => "");
    if (isPaymentField(text)) throw new PaymentFieldEncounteredError(text.trim());
  }

  const fields = [
    { pattern: /first name/i, value: guestInfo.firstName },
    { pattern: /last name/i, value: guestInfo.lastName },
    { pattern: /phone/i, value: guestInfo.phone },
    { pattern: /email/i, value: guestInfo.email },
  ];

  let filled = 0;
  for (const { pattern, value } of fields) {
    const input = page.getByLabel(pattern).or(page.getByPlaceholder(pattern)).first();
    try {
      await input.waitFor({ state: "visible", timeout: 3000 });
      await input.fill(value);
      filled++;
    } catch {
      // Field not found under this pattern — tried the rest, checked below.
    }
  }

  if (filled === 0) {
    throw new Error(
      "Resy: could not find any guest contact fields (first name/last name/phone/email) " +
        "on this screen — the guest-checkout form layout may not match what this adapter " +
        "expects. Refusing to submit blind."
    );
  }
}

export { fillGuestInfo };
