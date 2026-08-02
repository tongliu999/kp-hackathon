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
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

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

  await reserve.click();

  const confirmed = frame.getByText(/reservation confirmed|you're all set|confirmed/i).first();
  await confirmed.waitFor({ state: "visible", timeout: 45_000 });

  const text = await frame.locator("body").innerText();
  const explicit = text.match(/(?:confirmation|reservation)\s*(?:#|number|code)[:\s]*([A-Z0-9-]{4,})/i);

  // Resy does not always surface a short code. The slot token uniquely
  // identifies venue/date/time/party, so it is a stable fallback identity for
  // the store and for cancel() to match on -- never a fabricated code.
  const fallback = slot.token?.replace(/^reservation-button-/, "") || null;
  const confirmationRef = explicit ? explicit[1] : fallback;

  return {
    confirmationRef,
    raw: { text: text.slice(0, 2000), venue: slot.venue, time: slot.time, type: slot.type, token: slot.token },
  };
}

export async function cancel(page, record) {
  await page.goto(`${BASE_URL}/account/reservations`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Match on what the user would recognise -- venue and time -- because the
  // stored ref may be the slot token rather than anything Resy prints.
  const venue = record?.raw?.venue ?? record?.params?.restaurant ?? "";
  const row = venue
    ? page.getByText(new RegExp(escapeRegExp(venue), "i")).first()
    : page.getByText(String(record.confirmationRef)).first();

  await row.waitFor({ state: "visible", timeout: 20_000 });

  const cancelButton = page.getByRole("button", { name: /cancel/i }).first();
  await cancelButton.waitFor({ state: "visible", timeout: 20_000 });
  await cancelButton.click();

  const confirmCancel = page.getByRole("button", { name: /yes, cancel|confirm|cancel reservation/i }).first();
  await confirmCancel.waitFor({ state: "visible", timeout: 20_000 });
  await confirmCancel.click();
  await page.waitForTimeout(3000);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
