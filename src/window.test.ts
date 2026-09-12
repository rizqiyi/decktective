/**
 * Window math. Timezone handling is where "Monday" silently becomes Sunday,
 * so these assert the half-open boundary and DST behaviour explicitly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isoWeekWindow, previousIsoWeek, lastNWeeks, dateInZone, isoInZone,
  instantInZone, describeWindow, densityHistogram, presets,
} from "./window.ts";

const JKT = "Asia/Jakarta";

test("isoWeekWindow snaps to Monday 00:00 and is half-open", () => {
  // Wednesday 2026-09-09 in Jakarta.
  const w = isoWeekWindow(JKT, new Date("2026-09-09T05:00:00Z"));
  assert.equal(w.tz, JKT);
  // Mon 2026-09-07 00:00 +07:00 == Sun 2026-09-06 17:00Z
  assert.equal(w.start, "2026-09-07T00:00:00+07:00");
  assert.equal(w.end, "2026-09-14T00:00:00+07:00");
});

test("Monday itself belongs to its own week, not the previous one", () => {
  const w = isoWeekWindow(JKT, new Date("2026-09-07T00:00:00+07:00"));
  assert.equal(w.start, "2026-09-07T00:00:00+07:00");
});

test("one second before Monday 00:00 is still the previous week", () => {
  const w = isoWeekWindow(JKT, new Date("2026-09-06T23:59:59+07:00"));
  assert.equal(w.start, "2026-08-31T00:00:00+07:00");
  assert.equal(w.end, "2026-09-07T00:00:00+07:00");
});

test("previousIsoWeek steps back exactly seven days", () => {
  const cur = isoWeekWindow(JKT, new Date("2026-09-09T05:00:00Z"));
  const prev = previousIsoWeek(JKT, new Date("2026-09-09T05:00:00Z"));
  assert.equal(prev.start, "2026-08-31T00:00:00+07:00");
  assert.equal(prev.end, cur.start);
});

test("lastNWeeks spans N weeks and ends where this week ends", () => {
  const now = new Date("2026-09-09T05:00:00Z");
  const w = lastNWeeks(JKT, now, 4);
  assert.equal(w.start, "2026-08-17T00:00:00+07:00");
  assert.equal(w.end, isoWeekWindow(JKT, now).end);
});

test("a non-Jakarta zone produces that zone's offset, not the host's", () => {
  // 2026-09-07 00:00 in Tokyo is +09:00; the date must not shift.
  const w = isoWeekWindow("Asia/Tokyo", new Date("2026-09-09T05:00:00Z"));
  assert.equal(w.start, "2026-09-07T00:00:00+09:00");
  assert.equal(w.end, "2026-09-14T00:00:00+09:00");
});

test("a zone behind UTC keeps the local date", () => {
  // 2026-09-07 00:00 in New York is -04:00 (EDT in September).
  const w = isoWeekWindow("America/New_York", new Date("2026-09-09T12:00:00Z"));
  assert.equal(w.start, "2026-09-07T00:00:00-04:00");
});

test("dateInZone reports the calendar date in the target zone", () => {
  // 2026-09-06T20:00Z is already 2026-09-07 in Jakarta (+07) but not in UTC.
  assert.equal(dateInZone(JKT, new Date("2026-09-06T20:00:00Z")), "2026-09-07");
  assert.equal(dateInZone("UTC", new Date("2026-09-06T20:00:00Z")), "2026-09-06");
});

test("instantInZone round-trips through isoInZone", () => {
  const d = instantInZone(JKT, 2026, 9, 7, 0, 0, 0);
  assert.equal(isoInZone(JKT, d), "2026-09-07T00:00:00+07:00");
});

test("describeWindow states the resolved absolute range and zone", () => {
  const w = isoWeekWindow(JKT, new Date("2026-09-09T05:00:00Z"));
  const s = describeWindow(w);
  assert.match(s, /Asia\/Jakarta/);
  assert.match(s, /half-open/);
});

test("densityHistogram counts only dates inside each window", () => {
  const counts = new Map([
    ["2026-09-07", 3],
    ["2026-09-08", 4],
    ["2026-09-14", 9], // outside: belongs to the next week
  ]);
  const now = new Date("2026-09-09T05:00:00Z");
  const out = densityHistogram(counts, [isoWeekWindow(JKT, now)]);
  assert.match(out, /2026-09-07/);
  assert.match(out, /7/);
  assert.doesNotMatch(out, /16/);
});

test("bars are scaled against the largest WEEK, not the largest day", () => {
  // Many small days in one week must produce a full bar: scaling a weekly sum
  // against a daily maximum would overflow the requested width.
  const counts = new Map([
    ["2026-09-07", 1],
    ["2026-09-08", 1],
    ["2026-09-09", 1],
    ["2026-09-10", 1],
    ["2026-09-11", 1],
  ]);
  const now = new Date("2026-09-09T05:00:00Z");
  const width = 28;
  const out = densityHistogram(counts, [isoWeekWindow(JKT, now)], width);
  const line = out.split("\n")[0] ?? "";
  const blocks = (line.match(/\u2588/g) ?? []).length;
  assert.equal(blocks, width, `bar must fill the requested width, got ${blocks}`);
  assert.match(out, /\b5\b/);
});

test("bars never exceed the requested width", () => {
  const counts = new Map([
    ["2026-08-31", 2], ["2026-09-01", 3], ["2026-09-02", 4], ["2026-09-03", 5],
    ["2026-09-07", 9], ["2026-09-08", 2], ["2026-09-09", 3],
  ]);
  const now = new Date("2026-09-09T05:00:00Z");
  const width = 20;
  const weeks = [previousIsoWeek(JKT, now), isoWeekWindow(JKT, now)];
  for (const line of densityHistogram(counts, weeks, width).split("\n")) {
    const blocks = (line.match(/\u2588/g) ?? []).length;
    assert.ok(blocks <= width, `bar of ${blocks} exceeds width ${width}: ${line}`);
  }
});

test("a week with no commits renders an empty bar", () => {
  const counts = new Map([["2026-09-08", 4]]);
  const now = new Date("2026-09-09T05:00:00Z");
  const out = densityHistogram(counts, [previousIsoWeek(JKT, now), isoWeekWindow(JKT, now)], 20);
  const [first, second] = out.split("\n");
  assert.equal((first?.match(/\u2588/g) ?? []).length, 0, "quiet week has an empty bar");
  assert.ok((second?.match(/\u2588/g) ?? []).length > 0, "active week has a bar");
});

test("presets offer this week, last week, and a 4-week span", () => {
  const p = presets(JKT, new Date("2026-09-09T05:00:00Z"));
  assert.equal(p.length, 3);
  assert.equal(p[0]?.window.start, "2026-09-07T00:00:00+07:00");
  assert.equal(p[1]?.window.start, "2026-08-31T00:00:00+07:00");
  assert.equal(p[2]?.window.start, "2026-08-17T00:00:00+07:00");
});
