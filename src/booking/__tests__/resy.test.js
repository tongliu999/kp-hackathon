// The pure half of the Resy adapter. These four functions sit between what the
// runbook says ("tomorrow", "7 pm", "San Francisco") and what the site needs
// ("2026-08-02", 19:00, "san-francisco-ca"), and every one of them fails
// SILENTLY when it is wrong -- a mismatch yields "no slots" or the wrong slot,
// never an exception. That is exactly the failure you discover on stage, so
// they are tested without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { citySlug, parseTime, resolveDate, selectSlot } from "../providers/resy.js";

test("parseTime accepts the spoken form, the rendered form, and 24-hour", () => {
  // The runbook says "7 pm"; Resy renders "7:00 PM". Both must land on 19:00,
  // which is the bug the old exact-substring slot match could never survive.
  assert.equal(parseTime("7 pm"), 19 * 60);
  assert.equal(parseTime("7:00 PM"), 19 * 60);
  assert.equal(parseTime("19:00"), 19 * 60);
  assert.equal(parseTime("7:30 pm"), 19 * 60 + 30);
});

test("parseTime handles the midnight/noon boundary", () => {
  assert.equal(parseTime("12 am"), 0);
  assert.equal(parseTime("12:30 am"), 30);
  assert.equal(parseTime("12 pm"), 12 * 60);
  assert.equal(parseTime("12:30 pm"), 12 * 60 + 30);
});

test("parseTime returns null rather than a wrong number for junk", () => {
  // null is load-bearing: selectSlot treats it as "no preference" and takes the
  // first slot, which is safe. A silently-wrong number would book a wrong time.
  for (const value of ["", null, undefined, "dinnertime", "25:00", "7:99"]) {
    assert.equal(parseTime(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("resolveDate turns the spoken date into the URL's date", () => {
  const now = new Date(2026, 7, 1, 12, 0, 0); // 1 Aug 2026, local
  assert.equal(resolveDate("tomorrow", now), "2026-08-02");
  assert.equal(resolveDate("today", now), "2026-08-01");
  assert.equal(resolveDate("tonight", now), "2026-08-01");
});

test("resolveDate rolls over month and year ends", () => {
  assert.equal(resolveDate("tomorrow", new Date(2026, 7, 31, 12, 0, 0)), "2026-09-01");
  assert.equal(resolveDate("tomorrow", new Date(2026, 11, 31, 12, 0, 0)), "2027-01-01");
});

test("resolveDate passes an ISO day through verbatim", () => {
  // Verbatim on purpose. new Date("2026-08-05") parses as UTC midnight, which
  // in any negative-offset timezone formats back as 2026-08-04 -- an
  // off-by-one-day booking. The short-circuit is what prevents that.
  assert.equal(resolveDate("2026-08-05", new Date(2026, 7, 1)), "2026-08-05");
});

test("resolveDate falls back to today rather than throwing on unknown wording", () => {
  const now = new Date(2026, 7, 1, 12, 0, 0);
  assert.equal(resolveDate("whenever", now), "2026-08-01");
  assert.equal(resolveDate("", now), "2026-08-01");
  assert.equal(resolveDate(undefined, now), "2026-08-01");
});

test("citySlug maps spoken city names onto Resy's slugs", () => {
  assert.equal(citySlug("San Francisco"), "san-francisco-ca");
  assert.equal(citySlug("san francisco"), "san-francisco-ca");
  assert.equal(citySlug("SF"), "san-francisco-ca");
  assert.equal(citySlug("New York"), "new-york-ny");
});

test("citySlug slugifies an unknown city instead of throwing", () => {
  // A wrong slug yields an empty result list, which book.js already refuses on.
  // Throwing here would turn a recoverable miss into a crashed step.
  assert.equal(citySlug("Ann Arbor"), "ann-arbor");
  assert.equal(citySlug(""), "san-francisco-ca");
  assert.equal(citySlug(undefined), "san-francisco-ca");
});

/** Slots as search() returns them, with `minutes` precomputed. */
function slots(...times) {
  return times.map((time) => ({
    label: `Test Bistro · ${time}`,
    venue: "Test Bistro",
    time,
    minutes: parseTime(time),
  }));
}

test("selectSlot matches the spoken time against the rendered time", () => {
  const found = selectSlot(slots("6:00 PM", "7:00 PM", "8:00 PM"), { time: "7 pm" });
  assert.equal(found.time, "7:00 PM");
});

test("selectSlot takes the next slot after the requested time", () => {
  // Exact-match-only would refuse a 7:15 table for a "7 pm" request and abort a
  // booking the caller would plainly have accepted.
  const found = selectSlot(slots("6:30 PM", "7:15 PM", "8:00 PM"), { time: "7 pm" });
  assert.equal(found.time, "7:15 PM");
});

test("selectSlot never returns a slot earlier than asked when a later one exists", () => {
  const found = selectSlot(slots("5:00 PM", "9:45 PM"), { time: "7 pm" });
  assert.equal(found.time, "9:45 PM");
});

test("selectSlot falls back to the closest earlier slot when nothing is later", () => {
  const found = selectSlot(slots("5:00 PM", "6:30 PM"), { time: "7 pm" });
  assert.equal(found.time, "6:30 PM");
});

test("selectSlot takes the first slot when no time was requested", () => {
  assert.equal(selectSlot(slots("6:00 PM", "7:00 PM"), {}).time, "6:00 PM");
  assert.equal(selectSlot(slots("6:00 PM", "7:00 PM")).time, "6:00 PM");
  assert.equal(selectSlot(slots("6:00 PM"), { time: "nonsense" }).time, "6:00 PM");
});

test("selectSlot returns null on no results so book.js can refuse", () => {
  assert.equal(selectSlot([], { time: "7 pm" }), null);
  assert.equal(selectSlot(undefined, { time: "7 pm" }), null);
});
