/**
 * Layout resolution: DeckIR -> RenderPlan.
 *
 * This is the ONLY place that decides geometry, wrapping, and overflow. It
 * imports no backend, so pptx and pdf cannot diverge: they translate an
 * already-resolved plan. Overflow is measured and either autofit or fatal.
 */
import { inToPt } from "../theme.ts";
import {
  measureCtx, fitSizePt, wrapLines, lineHeightPt, missingGlyphs, type MeasureCtx,
} from "../measure.ts";
import { cellRect, roleSizePt } from "../theme.ts";
import type {
  Block, DeckIR, LayoutSpec, Slide, SlotRole, Theme,
} from "../ir/types.ts";
import type {
  BulletsOp, DrawOp, RenderPlan, SlidePlan, TextOp,
} from "../render/types.ts";

export class OverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverflowError";
  }
}

/** A character the bundled font cannot draw would render as tofu, not as text. */
export class MissingGlyphError extends Error {
  readonly characters: string[];

  constructor(characters: string[], where: string, text: string) {
    const list = characters
      .map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(", ");
    super(`${where}: bundled font has no glyph for ${list}. Text: ${JSON.stringify(text.slice(0, 80))}`);
    this.name = "MissingGlyphError";
    this.characters = characters;
  }
}

/** Fail before layout if any character would render as tofu. */
function assertDrawable(ctx: MeasureCtx, text: string, where: string): void {
  const missing = missingGlyphs(ctx, text);
  if (missing.length > 0) throw new MissingGlyphError(missing, where, text);
}

/** Resolve one text block into a fitted TextOp. */
function textOps(
  ctx: MeasureCtx,
  rectIn: { xIn: number; yIn: number; wIn: number; hIn: number },
  text: string,
  role: SlotRole,
  t: Theme,
  where: string,
): TextOp[] {
  assertDrawable(ctx, text, where);
  const start = roleSizePt(role, t);
  const weight = 400 as const;
  const widthPt = inToPt(rectIn.wIn);
  const heightPt = inToPt(rectIn.hIn);

  const fit = fitSizePt(ctx, text, widthPt, heightPt, start, { weight });
  if (fit === null) {
    // Autofit ladder exhausted: fail loudly rather than clip or ship unreadable text.
    throw new OverflowError(
      `${where}: text does not fit its slot even at the minimum size.\n` +
      `  rect: ${rectIn.wIn.toFixed(2)}x${rectIn.hIn.toFixed(2)}in (${widthPt.toFixed(0)}x${heightPt.toFixed(0)}pt)\n` +
      `  start: ${start}pt\n  text: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }

  return [{
    op: "text",
    rect: rectIn,
    text,
    sizePt: fit,
    weight,
    color: t.colors.fg,
    align: "left",
    valign: "top",
  }];
}

/** Total height of a bullet list at a given size, in points. */
function bulletsHeightPt(
  ctx: MeasureCtx,
  items: string[],
  widthPt: number,
  sizePt: number,
  gapPt: number,
): number {
  let total = 0;
  for (const item of items) {
    total += wrapLines(ctx, item, widthPt, sizePt).length * lineHeightPt(ctx, sizePt) + gapPt;
  }
  return total;
}

function bulletOps(
  ctx: MeasureCtx,
  rectIn: { xIn: number; yIn: number; wIn: number; hIn: number },
  items: string[],
  role: SlotRole,
  t: Theme,
  where: string,
): BulletsOp[] {
  for (const item of items) assertDrawable(ctx, item, where);
  const widthPt = inToPt(rectIn.wIn) - 18; // marker indent
  const heightPt = inToPt(rectIn.hIn);
  const gapPt = 6;
  const start = roleSizePt(role, t);
  const floor = Math.min(start, t.type.captionPt);

  // Same autofit ladder as text: shrink one step at a time, never below the floor.
  let size = start;
  for (; size > floor; size -= 1) {
    if (bulletsHeightPt(ctx, items, widthPt, size, gapPt) <= heightPt) break;
  }
  const total = bulletsHeightPt(ctx, items, widthPt, size, gapPt);
  if (total > heightPt) {
    throw new OverflowError(
      `${where}: bullets overflow their slot even at ${size}pt (${total.toFixed(0)}pt > ${heightPt.toFixed(0)}pt). ` +
      `Split the slide or move items to the appendix. items=${items.length}`,
    );
  }

  return [{
    op: "bullets",
    rect: rectIn,
    items,
    sizePt: size,
    weight: 400,
    color: t.colors.fg,
    marker: "\u2022 ",// space included: the PDF backend draws this marker as text
    gapPt,
  }];
}

function blockOps(
  ctx: MeasureCtx,
  block: Block,
  rectIn: { xIn: number; yIn: number; wIn: number; hIn: number },
  role: SlotRole,
  t: Theme,
  where: string,
): DrawOp[] {
  switch (block.kind) {
    case "text":
      return textOps(ctx, rectIn, block.text, role, t, where);

    case "bullets":
      return bulletOps(ctx, rectIn, block.items.map((i) => i.text), role, t, where);

    case "metrics": {
      // Metrics render as a 2-row label/value stack per column.
      const cols = block.items.length;
      if (cols === 0) return [];
      const gap = t.grid.gutterIn;
      const colW = (rectIn.wIn - gap * (cols - 1)) / cols;
      const ops: DrawOp[] = [];
      block.items.forEach((m, i) => {
        const x = rectIn.xIn + i * (colW + gap);
        const valueSize = t.type.headingPt * 1.4;
        const valueRect = { xIn: x, yIn: rectIn.yIn, wIn: colW, hIn: rectIn.hIn * 0.6 };
        const valueFit = fitSizePt(
          ctx, m.value, inToPt(colW), inToPt(valueRect.hIn), valueSize,
          { weight: 700, floorPt: 14 },
        );
        if (valueFit === null) {
          throw new OverflowError(`${where}: metric value ${JSON.stringify(m.value)} does not fit ${colW.toFixed(2)}in`);
        }
        ops.push({
          op: "text", rect: valueRect, text: m.value, sizePt: valueFit,
          weight: 700, color: t.colors.accent, align: "left", valign: "top",
        });
        const labelRect = { xIn: x, yIn: rectIn.yIn + rectIn.hIn * 0.62, wIn: colW, hIn: rectIn.hIn * 0.38 };
        ops.push({
          op: "text", rect: labelRect, text: m.label, sizePt: t.type.captionPt,
          weight: 400, color: t.colors.muted, align: "left", valign: "top",
        });
      });
      return ops;
    }

    case "evidence": {
      const rows = block.rows.slice(0, 24);
      const lines = rows.map((r) => (r.ref ? `${r.label}  ${r.ref}` : r.label));
      const size = t.type.captionPt;
      const ops: DrawOp[] = [];
      const lineH = lineHeightPt(ctx, size);
      lines.forEach((line, i) => {
        const y = rectIn.yIn + (i * (lineH + 3)) / 72;
        if (y + lineH / 72 > rectIn.yIn + rectIn.hIn) return;
        ops.push({
          op: "text",
          rect: { xIn: rectIn.xIn, yIn: y, wIn: rectIn.wIn, hIn: lineH / 72 },
          text: line, sizePt: size, weight: 400, color: t.colors.muted,
          align: "left", valign: "top",
        });
      });
      return ops;
    }
  }
}

function slidePlan(
  ctx: MeasureCtx,
  slide: Slide,
  spec: LayoutSpec,
  t: Theme,
  index: number,
): SlidePlan {
  const ops: DrawOp[] = [];

  // Full-bleed background first so every later op paints on top.
  ops.push({
    op: "rect",
    rect: { xIn: 0, yIn: 0, wIn: t.canvas.widthIn, hIn: t.canvas.heightIn },
    fill: t.colors.bg,
  });

  for (const slot of spec.slots) {
    const block = slide.slots[slot.key];
    if (!block) continue;
    const where = `slide ${index + 1} (${slide.layout}) slot "${slot.key}"`;
    if (!slot.accepts.includes(block.kind)) {
      throw new OverflowError(
        `${where}: layout does not accept block kind "${block.kind}" (accepts: ${slot.accepts.join(", ")})`,
      );
    }
    const rect = cellRect(t, slot.col, slot.row, slot.colSpan, slot.rowSpan);
    ops.push(...blockOps(ctx, block, rect, slot.role, t, where));
  }

  // Title rule, drawn after background but before nothing else depends on it.
  if (slide.layout !== "title") {
    const y = t.grid.marginIn - 0.12;
    ops.push({
      op: "line",
      x1In: t.grid.marginIn, y1In: y,
      x2In: t.canvas.widthIn - t.grid.marginIn, y2In: y,
      color: t.colors.rule, widthPt: 1,
    });
  }

  // Slide title from `slide.title` when the layout has no heading slot.
  return { ops, notes: slide.notes };
}

export function resolvePlan(ir: DeckIR): RenderPlan {
  const t = ir.template.theme;
  const ctx = measureCtx(t.fonts.regular, t.fonts.bold);
  const byId = new Map(ir.template.layouts.map((l) => [l.id, l]));

  return {
    theme: t,
    slides: ir.slides.map((s, i) => {
      const spec = byId.get(s.layout);
      if (!spec) {
        throw new OverflowError(
          `slide ${i + 1}: template has no layout "${s.layout}" (has: ${[...byId.keys()].join(", ")})`,
        );
      }
      return slidePlan(ctx, s, spec, t, i);
    }),
  };
}
