/**
 * Window selection (§7.2).
 *
 * ISO week Mon->Mon is the DEFAULT PRESET, not a rule. The window is always a
 * half-open interval `[start, end)` in one declared timezone, and the resolved
 * absolute range is echoed before collection so the user never selects blind.
 *
 * Timezone math is done with Intl (no Temporal in Node 26) so offsets are
 * computed correctly for the target zone, including DST.
 */
import type { IsoDate, TimeZone, Window } from "./ir/types.ts";

/** Offset of `tz` at the given instant, in milliseconds. */
function tzOffsetMs(tz: TimeZone, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(at);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"),
  );
  return asUtc - at.getTime();
}

/** Format an instant as an ISO string carrying the target zone's offset. */
export function isoInZone(tz: TimeZone, at: Date): string {
  const offMs = tzOffsetMs(tz, at);
  const local = new Date(at.getTime() + offMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = offMs < 0 ? "-" : "+";
  const abs = Math.abs(offMs);
  const oh = pad(Math.floor(abs / 3600000));
  const om = pad(Math.floor((abs % 3600000) / 60000));
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

/** Build an instant from a wall-clock time in `tz`, resolving the real offset. */
export function instantInZone(
  tz: TimeZone,
  y: number, m: number, d: number, h = 0, min = 0, s = 0,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  // Two passes: the first offset may shift the wall clock across a DST edge.
  let ms = guess - tzOffsetMs(tz, new Date(guess));
  ms = guess - tzOffsetMs(tz, new Date(ms));
  return new Date(ms);
}

/** `YYYY-MM-DD` for an instant in the target zone. */
export function dateInZone(tz: TimeZone, at: Date): IsoDate {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return dtf.format(at);
}

/** Monday 00:00 of the ISO week containing `at`, in `tz`; half-open `[Mon, next Mon)`. */
export function isoWeekWindow(tz: TimeZone, at: Date): Window {
  const local = dateInZone(tz, at);
  const [y, m, d] = local.split("-").map(Number) as [number, number, number];
  const noon = instantInZone(tz, y, m, d, 12);
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(noon);
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(dow);
  const start = instantInZone(tz, y, m, d - idx);
  const end = instantInZone(tz, y, m, d - idx + 7);
  return { start: isoInZone(tz, start), end: isoInZone(tz, end), tz };
}

/** The ISO week immediately before the one containing `at`. */
export function previousIsoWeek(tz: TimeZone, at: Date): Window {
  const cur = isoWeekWindow(tz, at);
  const shifted = new Date(new Date(cur.start).getTime() - 86400000);
  return isoWeekWindow(tz, shifted);
}

/** The `n` ISO weeks ending with the week containing `at`. */
export function lastNWeeks(tz: TimeZone, at: Date, n: number): Window {
  const cur = isoWeekWindow(tz, at);
  const start = new Date(new Date(cur.start).getTime() - (n - 1) * 7 * 86400000);
  const s = isoWeekWindow(tz, start);
  return { start: s.start, end: cur.end, tz };
}

export type Preset = { label: string; window: Window };

export function presets(tz: TimeZone, now = new Date()): Preset[] {
  return [
    { label: "This week", window: isoWeekWindow(tz, now) },
    { label: "Last week", window: previousIsoWeek(tz, now) },
    { label: "Last 4 weeks", window: lastNWeeks(tz, now, 4) },
  ];
}

/**
 * Render a density histogram so the user selects against real data rather
 * than typing dates blind. `counts` is date -> commit count.
 */
export function densityHistogram(
  counts: Map<IsoDate, number>,
  weeks: Window[],
  width = 28,
): string {
  // Sum each week BEFORE scaling. The map holds per-day counts, so scaling a
  // weekly total against a daily maximum would inflate every bar ~7x.
  const totals = weeks.map((w) => {
    const startDate = dateInZone(w.tz, new Date(w.start));
    const endDate = dateInZone(w.tz, new Date(w.end));
    let total = 0;
    for (const [date, n] of counts) {
      if (date >= startDate && date < endDate) total += n;
    }
    return { startDate, total };
  });
  const max = Math.max(1, ...totals.map((t) => t.total));
  return totals
    .map(({ startDate, total }) => {
      const filled = Math.round((total / max) * width);
      return `${startDate}  ${"\u2588".repeat(filled).padEnd(width)}  ${String(total).padStart(4)}`;
    })
    .join("\n");
}

/** Echo the resolved window in absolute terms before anything is collected. */
export function describeWindow(w: Window): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: w.tz, dateStyle: "medium", timeStyle: "short",
  });
  return (
    `${fmt.format(new Date(w.start))}  \u2013  ${fmt.format(new Date(w.end))}  ` +
    `(${w.tz}, half-open)`
  );
}
