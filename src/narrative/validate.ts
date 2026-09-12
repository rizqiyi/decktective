/**
 * Fact-lock validator (§2c, §7.3).
 *
 * The narrative may be written by a model, so it can invent a plausible number.
 * Every numeral in the narrative must be traceable to the facts or derivable
 * from them; anything else is rejected loudly. This is what stops a deck from
 * claiming "27% faster" when no such figure exists.
 */
import type { DayEntry, Narrative } from "../ir/types.ts";

export class InventedNumberError extends Error {
  found: string[];
  constructor(found: string[]) {
    super(
      `narrative contains ${found.length} number(s) not present in the facts: ` +
      `${found.map((n) => JSON.stringify(n)).join(", ")}`,
    );
    this.name = "InventedNumberError";
    this.found = found;
  }
}

/** Every numeric value the facts legitimately support. */
export function allowedNumbers(facts: DayEntry[]): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => {
    if (Number.isFinite(n)) out.add(n);
  };

  let cCommits = 0, cAdd = 0, cDel = 0, cGross = 0, cNet = 0, cFiles = 0, cDays = 0;
  for (const d of facts) {
    const m = d.metrics;
    add(m.commits); add(m.additions); add(m.deletions); add(m.filesTouched);
    add(m.grossChurn); add(Math.abs(m.netChurn));
    add(m.concentration); add(m.medianCommitSize); add(m.maxCommitShare);
    add(d.items.length);
    for (const item of d.items) {
      add(item.additions ?? 0); add(item.deletions ?? 0); add(item.files ?? 0);
      add((item.additions ?? 0) + (item.deletions ?? 0));
    }
    add(Number(d.date.slice(8, 10)));        // day of month
    add(Number(d.date.slice(5, 7)));         // month
    const yr = Number(d.date.slice(0, 4));   // year and its parts
    add(yr);
    cCommits += m.commits; cAdd += m.additions; cDel += m.deletions;
    cGross += m.grossChurn; cNet += m.netChurn; cFiles += m.filesTouched;
    if (m.commits > 0) cDays++;
  }
  add(cCommits); add(cAdd); add(cDel); add(cGross); add(Math.abs(cNet));
  add(cFiles); add(cDays); add(facts.length);

  // Ratios the deck legitimately derives.
  if (cGross > 0) add(Math.round((cAdd / cGross) * 100));
  if (facts.length > 0) add(Math.round(cCommits / facts.length));
  return out;
}

/**
 * ISO-8601 dates and timestamps are identity, not assertion: `2026-09-07` is a
 * date, not a claim about 2026 or 7 things. Masking them keeps the validator
 * from rejecting a narrative merely for naming the window it covers.
 */
const ISO_TOKEN = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const MASKED = "\u0000";

const NUMERAL = /\d[\d,_]*(?:\.\d+)?/g;

/** Extract every numeral in a string as a number, tolerating separators. */
export function extractNumbers(text: string): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  for (const m of text.matchAll(NUMERAL)) {
    const raw = m[0];
    const value = Number(raw.replace(/[,_]/g, ""));
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

function strings(node: unknown, into: string[]): void {
  if (typeof node === "string") into.push(node);
  else if (Array.isArray(node)) for (const v of node) strings(v, into);
  else if (node && typeof node === "object") {
    for (const v of Object.values(node)) strings(v, into);
  }
}

/**
 * Throw when the narrative asserts a number the facts do not support.
 * Dates are excepted: they are identity, not assertion.
 */
export function assertFactLocked(narrative: Narrative, facts: DayEntry[]): void {
  const allowed = allowedNumbers(facts);
  const texts: string[] = [];
  const found: string[] = [];
  strings(
    {
      summary: narrative.summary,
      risks: narrative.risks,
      nextWeek: narrative.nextWeek,
      themes: narrative.themes.map((t) => t.title),
      days: narrative.days.map((d) => ({
        headline: d.headline,
        items: d.items.map((i) => i.text),
      })),
    },
    texts,
  );

  for (const raw of texts) {
    const text = raw.replace(ISO_TOKEN, MASKED);
    for (const { raw: numeral, value } of extractNumbers(text)) {
      if (allowed.has(value)) continue;
      found.push(numeral);
    }
  }

  if (found.length > 0) throw new InventedNumberError([...new Set(found)]);
}
