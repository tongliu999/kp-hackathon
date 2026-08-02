// Resy adapter.
//
// Selectors here were read off the live site through the Sailbox browser
// (TON-8), not guessed. What that changed, versus the first pass:
//
//  * Search is a URL, not a typing flow. The old version loaded the homepage
//    and typed into a placeholder. Navigating straight to the search URL with
//    date/seats/query is fewer moving parts and skips the homepage entirely.
//  * Slots live ON the search page. Every result card carries its own
//    availability buttons, so there is no navigate-into-venue step.
//  * Booking happens in a CROSS-ORIGIN IFRAME. Clicking a slot opens a
//    widgets.resy.com frame ("Complete Your Reservation"); the Reserve Now
//    button is inside it and is invisible to page-level locators. This is the
//    one that would have failed on stage -- a page.getByRole("button") search
//    never sees into another origin's frame.
//  * Resy ships stable data-test-id hooks, so we use those rather than
//    role+text guesses that break when copy changes.
//
// Cancellation policy, quoted from the widget itself: "While you won't be
// charged if you need to cancel, we ask that you do so at least 24 hours in
// advance." That is the free-instant-cancellation property TON-8 selected on.

import { isPaymentField, PaymentFieldEncounteredError } from "../paymentGuard.js";

const BASE_URL = "https://resy.com";

// Resy's city slugs. The runbook says "San Francisco"; the URL needs
// "san-francisco-ca". Unknown cities fall through to a slugified guess rather
// than throwing -- a wrong slug yields an empty result list, which book.js
// already refuses on, and that is a better failure than crashing here.
const CITY_SLUGS = {
  "san francisco": "san-francisco-ca",
  sf: "san-francisco-ca",
  "new york": "new-york-ny",
  nyc: "new-york-ny",
  "los angeles": "los-angeles-ca",
  la: "los-angeles-ca",
  chicago: "chicago-il",
  austin: "austin-tx",
  seattle: "seattle-wa",
  boston: "boston-ma",
  miami: "miami-fl",
  "washington dc": "washington-dc",
  london: "london-ldn",
};

export function citySlug(city) {
  const key = String(city ?? "").trim().toLowerCase();
  if (!key) return "san-francisco-ca";
  if (CITY_SLUGS[key]) return CITY_SLUGS[key];
  return key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Resolve the runbook's date wording to YYYY-MM-DD.
 *
 * The runbook says "tomorrow", the URL needs a date. `now` is injectable so
 * this stays testable without freezing the clock.
 */
export function resolveDate(date, now = new Date()) {
  const raw = String(date ?? "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const day = new Date(now);
  if (raw === "" || raw === "today" || raw === "tonight") {
    // fall through with no offset
  } else if (raw === "tomorrow") {
    day.setDate(day.getDate() + 1);
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return toIsoDay(parsed);
    // Unrecognised wording: today is the least surprising default, and an
    // unavailable date simply yields no slots rather than a wrong booking.
  }
  return toIsoDay(day);
}

function toIsoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Minutes since midnight for any of "7 pm", "7:00 PM", "19:00".
 *
 * Slot labels render as "7:00 PM" while the runbook says "7 pm", so the old
 * `label.includes(time)` match could never fire. Comparing numbers instead of
 * strings makes the two spellings equivalent.
 */
export function parseTime(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export async function search(page, { restaurant, date, time, partySize, city }) {
  const params = new URLSearchParams({
    date: resolveDate(date),
    seats: String(partySize ?? 2),
    query: String(restaurant ?? ""),
  });
  const url = `${BASE_URL}/cities/${citySlug(city)}/search?${params}`;
  await gotoWithRetry(page, url);

  // Results stream in after hydration. Waiting on the first slot button is the
  // real readiness signal; networkidle never settles here because the page
  // keeps polling availability.
  await page
    .locator("button.ReservationButton")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 })
    .catch(() => {});

  const buttons = page.locator("button.ReservationButton");
  const meta = await buttons.evaluateAll((els) =>
    els.map((el, index) => {
      const card = el.closest('[class*="SearchResult"]') ?? el.parentElement;
      const link = card?.querySelector('[data-test-id="search-result-link-details"]');
      return {
        index,
        time: el.querySelector(".ReservationButton__time")?.innerText?.trim() ?? "",
        type: el.querySelector(".ReservationButton__type")?.innerText?.trim() ?? "",
        venue: link?.innerText?.trim() ?? "",
        token: el.getAttribute("data-testid") ?? "",
      };
    })
  );

  // "View more availability" shares the button class but carries no time.
  return meta
    .filter((m) => m.time)
    .map((m) => ({
      handle: buttons.nth(m.index),
      label: [m.venue, m.time, m.type].filter(Boolean).join(" · "),
      venue: m.venue,
      time: m.time,
      type: m.type,
      minutes: parseTime(m.time),
      token: m.token,
    }));
}

/**
 * Closest slot at or after the requested time, else the closest before it.
 *
 * Exact-match-only would refuse a 7:15 table for a "7 pm" request and abort a
 * booking the caller would plainly have accepted. Preferring later keeps the
 * reservation no earlier than asked.
 */
export function selectSlot(results, { time } = {}) {
  if (!results || results.length === 0) return null;
  const wanted = parseTime(time);
  if (wanted == null) return results[0];

  const timed = results.filter((r) => r.minutes != null);
  if (timed.length === 0) return results[0];

  const after = timed
    .filter((r) => r.minutes >= wanted)
    .sort((a, b) => a.minutes - b.minutes);
  if (after.length > 0) return after[0];

  return timed.sort((a, b) => b.minutes - a.minutes)[0];
}

/**
 * Navigate, retrying transient failures.
 *
 * Observed live: one Resy navigation returned ERR_TIMED_OUT and the identical
 * URL loaded in ~5s immediately after. A single flake on the first step would
 * abort a whole replay, so navigation gets a couple of attempts.
 *
 * ONLY for navigation. A GET is idempotent; the booking click is not, and
 * retrying it could produce two reservations. Nothing in book() past the slot
 * click may be wrapped in this.
 */
async function gotoWithRetry(page, url, { attempts = 3, timeout = 60_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await page.waitForTimeout(2000 * attempt);
    }
  }
  throw new Error(`Resy: ${url} failed after ${attempts} attempts — ${lastError?.message ?? lastError}`);
}

/** The booking widget is a separate origin; everything below lives inside it. */
function widget(page) {
  return page.frameLocator('iframe[src*="widgets.resy.com"]');
}

export async function book(page, slot) {
  await slot.handle.click();

  const frame = widget(page);
  const reserve = frame.locator('[data-test-id="order_summary_page-button-book"]');
  await reserve.waitFor({ state: "visible", timeout: 30_000 });

  // A logged-out widget still renders Reserve Now, then bounces to a login
  // wall. Failing here names the real problem instead of timing out later on a
  // confirmation that was never going to appear.
  const loginPrompt = frame.locator('[data-test-id="profile_menu-button-login"]');
  if ((await loginPrompt.count()) > 0) {
    throw new Error(
      "Resy booking widget is not logged in — the Sailbox profile has no live " +
        "Resy session. Log in at the VNC session before booking."
    );
  }

  // Entering financial credentials is a hard line, not a judgment call. This
  // account books against a card already on file, so a payment-shaped field
  // appearing here means the flow is not the one that was verified -- stop
  // rather than improvise next to a checkout form.
  const labels = await frame.locator("input, label").evaluateAll((els) =>
    els.map((el) => el.getAttribute("name") ?? el.getAttribute("placeholder") ?? el.textContent ?? "")
  );
  const payment = labels.find((label) => isPaymentField(label));
  if (payment) throw new PaymentFieldEncounteredError(payment.trim().slice(0, 60));

  // The button is visible, enabled and stable, and still un-clickable: the
  // widget iframe is taller than the 900px window, so Reserve Now sits below
  // the fold and Playwright retries "element is outside of the viewport" until
  // it times out. Scroll the iframe into the page's viewport first, then the
  // button within the iframe.
  await page
    .locator('iframe[src*="widgets.resy.com"]')
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await reserve.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await reserve.click({ timeout: 20_000 });
  } catch (cause) {
    // Dispatch directly as a last resort. Safe specifically because the login
    // guard above already ran and waitFor proved the button visible+enabled --
    // this bypasses Playwright's viewport check, not the confirmation gate.
    await reserve.evaluate((el) => el.click()).catch(() => {
      throw cause;
    });
  }

  // CONFIRM AGAINST THE ACCOUNT, NOT A BANNER.
  //
  // The first version waited for confirmation text inside the widget. On the
  // live site that text never matched, so book() threw -- AFTER Resy had
  // actually taken the reservation. book.js then recorded nothing, which left a
  // real table held at a real restaurant that `npm run reset` did not know
  // existed. That is the worst failure this component can produce, and it is
  // invisible: every log said the booking had failed.
  //
  // So success is now defined by the reservation appearing in the account,
  // which is the same source of truth a human would check. A banner that
  // changes wording cannot cause a silent orphan.
  const record = await waitForReservation(page, slot);
  if (!record) {
    throw new Error(
      `Resy: clicked Reserve Now for ${slot.venue} but no matching reservation ` +
        `appeared in the account within 60s. Check ${BASE_URL}/account/reservations ` +
        `by hand before retrying — do not assume it failed.`
    );
  }

  return { confirmationRef: record.ref, raw: { ...record, slotToken: slot.token } };
}

/**
 * Poll the account until the reservation shows up.
 *
 * Runs in a sibling page so the booking page is left alone. Resy issues no
 * short confirmation code on this screen, so the reference is composed from
 * what the account actually displays -- venue plus the reservation line. It is
 * derived, never invented, and it is what cancel() matches on.
 */
async function waitForReservation(page, slot, { timeout = 60_000 } = {}) {
  const probe = await page.context().newPage();
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await gotoWithRetry(probe, `${BASE_URL}/account/reservations`, { attempts: 2, timeout: 45_000 });
      await probe.waitForTimeout(4000);
      const text = await probe.evaluate(() => document.body.innerText);
      const venue = String(slot.venue ?? "").trim();
      if (venue && text.includes(venue)) {
        const line = text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /\d{4}\s+\d{1,2}:\d{2}\s*(AM|PM)/i.test(l));
        return {
          ref: [venue, line].filter(Boolean).join(" — "),
          venue,
          when: line ?? null,
          time: slot.time,
          type: slot.type,
        };
      }
      await probe.waitForTimeout(3000);
    }
    return null;
  } finally {
    await probe.close().catch(() => {});
  }
}

/**
 * Cancel a reservation. Selectors verified by cancelling a real one by hand.
 *
 * Three things the first pass got wrong, each of which left the booking
 * standing:
 *
 *  - the cancel control is hidden behind the card's overflow menu, so it exists
 *    in the DOM but is never visible until the menu is opened;
 *  - the dialog's confirming button is labelled exactly "Cancel" -- not
 *    "Yes, cancel" or "Confirm" -- so a name regex looking for those never
 *    fires and the dialog just sits there;
 *  - "Cancel" also matches the card button that OPENED the dialog, so the
 *    confirm has to be the last match, not the first.
 *
 * Retried deliberately: this runs unattended between rehearsals, and a flake
 * here leaves a real table held.
 */
export async function cancel(page, record) {
  await gotoWithRetry(page, `${BASE_URL}/account/reservations`);
  await page.waitForTimeout(5000);

  const venue = record?.raw?.venue ?? record?.params?.restaurant ?? "";
  if (venue) {
    await page
      .getByText(new RegExp(escapeRegExp(venue), "i"))
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  }

  const menu = page.locator('[data-test-id="account_reservation_card-menu"]').first();
  if (await menu.count()) {
    await menu.scrollIntoViewIfNeeded().catch(() => {});
    await menu.click();
    await page.waitForTimeout(2500);
  }

  const cancelButton = page
    .locator('[data-test-id="account_reservation_card-button-cancel"]')
    .first();
  await cancelButton.waitFor({ state: "visible", timeout: 20_000 });
  await cancelButton.click();
  await page.waitForTimeout(3000);

  const confirmCancel = page.getByRole("button", { name: /^cancel$/i }).last();
  await confirmCancel.waitFor({ state: "visible", timeout: 20_000 });
  await confirmCancel.scrollIntoViewIfNeeded().catch(() => {});
  await confirmCancel.click();
  await page.waitForTimeout(6000);

  // Verify rather than assume. A cancel that silently failed is the same
  // problem as a booking that silently succeeded.
  await gotoWithRetry(page, `${BASE_URL}/account/reservations`, { attempts: 2 });
  await page.waitForTimeout(5000);
  const stillThere =
    venue &&
    (await page.evaluate((v) => document.body.innerText.includes(v), venue).catch(() => false));
  if (stillThere) {
    throw new Error(
      `Resy: cancellation of "${venue}" did not take — it is still listed in the ` +
        `account. Cancel it by hand at ${BASE_URL}/account/reservations.`
    );
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
