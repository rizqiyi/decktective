/**
 * Fact-lock and overflow: the two gates that stop a deck from lying.
 *
 * These defend observable contracts, not internals:
 *  - a number the facts do not support must never reach a slide
 *  - text that does not fit must fail loudly instead of clipping
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TemplateNarrative } from "./narrative/template.ts";
import { assertFactLocked, allowedNumbers, extractNumbers, InventedNumberError } from "./narrative/validate.ts";
import { buildDeck } from "./deck/build.ts";
import { resolvePlan, OverflowError, MissingGlyphError } from "./layout/resolve.ts";
import { DEFAULT_THEME } from "./theme.ts";
import { measureCtx, missingGlyphs } from "./measure.ts";
import type { DayEntry, Narrative, Window } from "./ir/types.ts";

const WINDOW: Window = {
  start: "2026-09-07T00:00:00+07:00",
  end: "2026-09-14T00:00:00+07:00",
  tz: "Asia/Jakarta",
};

function day(over: Partial<DayEntry> = {}): DayEntry {
  return {
    date: "2026-09-08",
    sourceId: "repo",
    source: "git",
    items: [
      { text: "Add generator core", kind: "feat", refs: ["abc1234"], additions: 40, deletions: 2, files: 3 },
      { text: "Fix boundary", kind: "fix", refs: ["def5678"], additions: 5, deletions: 5, files: 2 },
    ],
    metrics: {
      commits: 2, additions: 45, deletions: 7, filesTouched: 5,
      grossChurn: 52, netChurn: 38, concentration: 10.4,
      medianCommitSize: 26, maxCommitShare: 0.807,
    },
    profile: "heavy",
    ...over,
  };
}

const facts = (): DayEntry[] => [
  day(),
  day({
    date: "2026-09-09",
    items: [{ text: "Write docs", kind: "docs", refs: ["9999999"], additions: 11, deletions: 0, files: 1 }],
    metrics: {
      commits: 1, additions: 11, deletions: 0, filesTouched: 1,
      grossChurn: 11, netChurn: 11, concentration: 11,
      medianCommitSize: 11, maxCommitShare: 1,
    },
  }),
];

test("extractNumbers reads plain, separated, and decimal numerals", () => {
  const got = extractNumbers("14 commits, +4,013 lines, 27.5 percent, 0 errors");
  assert.deepEqual(got.map((n) => n.value), [14, 4013, 27.5, 0]);
});

test("allowedNumbers covers totals, per-day metrics, and per-item churn", () => {
  const allowed = allowedNumbers(facts());
  assert.ok(allowed.has(3), "total commits");          // 2 + 1
  assert.ok(allowed.has(56), "total additions");       // 45 + 11
  assert.ok(allowed.has(45), "day additions");
  assert.ok(allowed.has(11), "item additions");
  assert.ok(allowed.has(7), "day deletions");
  assert.ok(allowed.has(2), "day count / commits");
});

test("a narrative built from the facts passes its own fact-lock", async () => {
  const f = facts();
  const n = await new TemplateNarrative().narrate(f, WINDOW);
  assert.doesNotThrow(() => assertFactLocked(n, f));
});

test("an invented number is rejected", async () => {
  const f = facts();
  const n = await new TemplateNarrative().narrate(f, WINDOW);
  const bad: Narrative = { ...n, summary: "Shipped 27% faster across the team." };
  assert.throws(() => assertFactLocked(bad, f), InventedNumberError);
});

test("the rejection names the offending number", async () => {
  const f = facts();
  const n = await new TemplateNarrative().narrate(f, WINDOW);
  const bad: Narrative = { ...n, summary: "We closed 999 issues." };
  try {
    assertFactLocked(bad, f);
    assert.fail("expected InventedNumberError");
  } catch (err) {
    assert.ok(err instanceof InventedNumberError);
    assert.deepEqual(err.found, ["999"]);
    assert.match(err.message, /999/);
  }
});

test("a number present in the facts is accepted", async () => {
  const f = facts();
  const n = await new TemplateNarrative().narrate(f, WINDOW);
  const ok: Narrative = { ...n, summary: "3 commits and 56 added lines." };
  assert.doesNotThrow(() => assertFactLocked(ok, f));
});

test("the template engine never invents numbers across varied input", async () => {
  const engine = new TemplateNarrative();
  for (const f of [facts(), [day({ metrics: { ...day().metrics, commits: 0, additions: 0, deletions: 0, grossChurn: 0, netChurn: 0, maxCommitShare: 0 } })], []]) {
    const n = await engine.narrate(f, WINDOW);
    assert.doesNotThrow(() => assertFactLocked(n, f), "template output must be fact-locked by construction");
  }
});

// ---------------------------------------------------------------------------
// Overflow
// ---------------------------------------------------------------------------

test("a deck built from real facts resolves to a plan", () => {
  const f = facts();
  const n = { days: [], themes: [], summary: "", risks: [], nextWeek: [] };
  const ir = buildDeck(f, n, WINDOW);
  const plan = resolvePlan(ir);
  assert.ok(plan.slides.length >= 3);
  assert.ok(plan.slides.every((s) => s.ops.length > 0), "every slide draws something");
});

test("text that cannot fit its slot throws instead of clipping", () => {
  const huge = "word ".repeat(4000);
  const ir = {
    meta: { title: "T", week: "2026-W37", tz: WINDOW.tz, generatedAt: "2026-09-11T00:00:00+07:00" },
    theme: DEFAULT_THEME,
    slides: [{
      layout: "bullets" as const,
      title: "Overflow",
      slots: {
        heading: { kind: "text" as const, text: "Overflow" },
        bullets: { kind: "bullets" as const, items: [{ text: huge }] },
      },
    }],
  };
  assert.throws(() => resolvePlan(ir), OverflowError);
});

test("a block placed in an incompatible slot is rejected", () => {
  const ir = {
    meta: { title: "T", week: "2026-W37", tz: WINDOW.tz, generatedAt: "2026-09-11T00:00:00+07:00" },
    theme: DEFAULT_THEME,
    slides: [{
      layout: "metrics" as const,
      title: "Bad",
      slots: { heading: { kind: "bullets" as const, items: [{ text: "nope" }] } },
    }],
  };
  assert.throws(() => resolvePlan(ir), /does not accept block kind/);
});

test("bullets autofit rather than overflow when they nearly fit", () => {
  const items = Array.from({ length: 7 }, (_, i) => `Item number ${i + 1} with a few words`);
  const ir = {
    meta: { title: "T", week: "2026-W37", tz: WINDOW.tz, generatedAt: "2026-09-11T00:00:00+07:00" },
    theme: DEFAULT_THEME,
    slides: [{
      layout: "bullets" as const,
      title: "Fit",
      slots: {
        heading: { kind: "text" as const, text: "Fit" },
        bullets: { kind: "bullets" as const, items: items.map((text) => ({ text })) },
      },
    }],
  };
  const plan = resolvePlan(ir);
  const op = plan.slides[0]?.ops.find((o) => o.op === "bullets");
  assert.ok(op, "bullets op present");
  if (op.op === "bullets") assert.ok(op.sizePt <= DEFAULT_THEME.type.bodyPt);
});

test("a character the font cannot draw fails the build as tofu, not text", () => {
  // U+2192 is absent from the bundled Inter latin subset (glyph id 0).
  assert.ok(missingGlyphs(measureCtx(DEFAULT_THEME.fonts.regular, DEFAULT_THEME.fonts.bold), "a \u2192 b").length > 0);
  const ir = {
    meta: { title: "T", week: "2026-W37", tz: WINDOW.tz, generatedAt: "2026-09-11T00:00:00+07:00" },
    theme: DEFAULT_THEME,
    slides: [{
      layout: "title" as const,
      title: "Tofu",
      slots: { title: { kind: "text" as const, text: "before \u2192 after" } },
    }],
  };
  try {
    resolvePlan(ir);
    assert.fail("expected MissingGlyphError");
  } catch (err) {
    assert.ok(err instanceof MissingGlyphError);
    assert.deepEqual(err.characters, ["\u2192"]);
    assert.match(err.message, /U\+2192/);
  }
});

test("every character the deck actually emits is drawable", () => {
  // Guards the shipped string constants: dashes, middots, ellipsis, bullets.
  const f = facts();
  const n = { days: [], themes: [], summary: "", risks: [], nextWeek: [] };
  const plan = resolvePlan(buildDeck(f, n, WINDOW));
  const ctx = measureCtx(DEFAULT_THEME.fonts.regular, DEFAULT_THEME.fonts.bold);
  for (const slide of plan.slides) {
    for (const op of slide.ops) {
      if (op.op === "text") assert.deepEqual(missingGlyphs(ctx, op.text), [], `text op: ${op.text}`);
      if (op.op === "bullets") {
        for (const item of op.items) assert.deepEqual(missingGlyphs(ctx, item), [], `bullet: ${item}`);
      }
    }
  }
});

test("the plan carries one background rect per slide", () => {
  const f = facts();
  const n = { days: [], themes: [], summary: "", risks: [], nextWeek: [] };
  const plan = resolvePlan(buildDeck(f, n, WINDOW));
  for (const s of plan.slides) {
    const first = s.ops[0];
    assert.ok(first && first.op === "rect", "background painted first");
    if (first.op === "rect") {
      assert.equal(first.rect.xIn, 0);
      assert.equal(first.rect.wIn, DEFAULT_THEME.canvas.widthIn);
    }
  }
});
