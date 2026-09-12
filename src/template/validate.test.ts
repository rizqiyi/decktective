/**
 * Template contract.
 *
 * A template may be model-generated, so validation is a security boundary as
 * much as a convenience: an invalid template must fail with a path-addressed
 * message before it can reach the renderer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTemplate, TemplateError } from "./validate.ts";
import { loadDefaultTemplate, DEFAULT_TEMPLATE_PATH } from "./load.ts";

const valid = (): Record<string, unknown> =>
  JSON.parse(readFileSync(DEFAULT_TEMPLATE_PATH, "utf8")) as Record<string, unknown>;

/** Deep-clone so each test mutates its own copy. */
const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;

function expectError(mutate: (t: Record<string, unknown>) => void, re: RegExp): void {
  const t = clone();
  mutate(t);
  try {
    parseTemplate(t);
    assert.fail("expected TemplateError");
  } catch (err) {
    assert.ok(err instanceof TemplateError, `expected TemplateError, got ${String(err)}`);
    assert.match(err.message, re);
  }
}

const skeleton = (t: Record<string, unknown>): Array<Record<string, unknown>> =>
  t.skeleton as Array<Record<string, unknown>>;

test("the shipped template is valid", async () => {
  const t = await loadDefaultTemplate();
  assert.equal(t.id, "weekly");
  assert.equal(t.version, 1);
  assert.ok(t.layouts.length >= 7);
  assert.ok(t.skeleton.length >= 8);
});

test("the shipped template covers the documented skeleton in order", async () => {
  const t = await loadDefaultTemplate();
  assert.deepEqual(
    t.skeleton.map((s) => s.id),
    ["cover", "agenda", "metrics", "day", "themes", "risks", "next-week", "appendix"],
  );
  assert.equal(t.skeleton.find((s) => s.id === "day")?.repeat, "per-day");
});

test("parsing is stable: parse(dump) round-trips", async () => {
  const t = await loadDefaultTemplate();
  const again = parseTemplate(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(again, t);
});

test("a step referencing an undefined layout is rejected", () => {
  expectError((t) => {
    skeleton(t)[0]!.layout = "nonexistent";
  }, /skeleton\[0\]\.layout: expected one of/);
});

test("a fill targeting a slot the layout lacks is rejected, naming the slot", () => {
  expectError((t) => {
    (skeleton(t)[0]!.fill as Record<string, unknown>).nope = { kind: "text", text: "x" };
  }, /skeleton\[0\]\.fill\.nope: layout "title" has no slot "nope"/);
});

test("a fill whose block kind the slot rejects is rejected", () => {
  expectError((t) => {
    (skeleton(t)[3]!.fill as Record<string, unknown>).heading = { kind: "evidence" };
  }, /skeleton\[3\]\.fill\.heading: slot "heading" accepts \[text\] but fill "evidence" produces "evidence"/);
});

test("an unknown fill kind is rejected", () => {
  expectError((t) => {
    (skeleton(t)[0]!.fill as Record<string, unknown>).title = { kind: "magic" };
  }, /fill\.title\.kind: expected one of/);
});

test("a colSpan beyond the grid width is rejected", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots[0]!.colSpan = 99;
  }, /colSpan: expected a number in \[1, 12\]/);
});

test("a slot that starts inside the grid but extends past it is rejected", () => {
  // col 8 + colSpan 5 = 13, past the 12-column grid, though each is in range.
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots[0]!.col = 8;
    slots[0]!.colSpan = 5;
  }, /col 8 \+ span 5 exceeds grid width 12/);
});

test("a slot that extends past the grid height is rejected", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots[0]!.row = 5;
    slots[0]!.rowSpan = 4;
  }, /row 5 \+ span 4 exceeds grid height 7/);
});

test("a slot row beyond the grid is rejected", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots[0]!.row = 99;
  }, /row: expected a number in/);
});

test("duplicate slot keys within a layout are rejected", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots.push({ ...(slots[0] as object) });
  }, /duplicate slot key/);
});

test("duplicate step ids are rejected", () => {
  expectError((t) => {
    const s = skeleton(t);
    s.push({ ...(s[0] as object) });
  }, /duplicate step id/);
});

test("duplicate layout ids are rejected", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    layouts.push(JSON.parse(JSON.stringify(layouts[0])));
  }, /duplicate layout ids/);
});

test("a per-day step with no day-scoped fill is rejected", () => {
  expectError((t) => {
    skeleton(t)[3]!.fill = { heading: { kind: "text", text: "same every day" } };
  }, /per-day step must fill at least one slot with "day-heading" or "day-items"/);
});

test("a slot accepts-block list cannot be empty", () => {
  expectError((t) => {
    const layouts = t.layouts as Array<Record<string, unknown>>;
    const slots = layouts[0]!.slots as Array<Record<string, unknown>>;
    slots[0]!.accepts = [];
  }, /accepts: expected a non-empty array/);
});

test("a non-integer grid is rejected", () => {
  expectError((t) => {
    ((t.theme as Record<string, unknown>).grid as Record<string, unknown>).cols = 12.5;
  }, /cols and rows must be integers/);
});

test("a missing theme colour is rejected, naming the colour", () => {
  expectError((t) => {
    delete (((t.theme as Record<string, unknown>).colors) as Record<string, unknown>).accent;
  }, /theme\.colors\.accent: expected a non-empty string/);
});

test("a non-object template is rejected", () => {
  assert.throws(() => parseTemplate("not a template"), TemplateError);
  assert.throws(() => parseTemplate(null), TemplateError);
  assert.throws(() => parseTemplate({}), TemplateError);
});
