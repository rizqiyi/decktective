/**
 * PPTX emitter: RenderPlan -> .pptx via pptxgenjs.
 *
 * pptxgenjs speaks inches (positions/sizes) and points (font/text sizes),
 * which is exactly the RenderPlan contract, so ops pass through untranslated.
 * Ops are drawn in array order (painter's order).
 */
import PptxGenJS from "pptxgenjs";
import type {
  RenderPlan,
  SlidePlan,
  DrawOp,
  TextOp,
  BulletsOp,
  LineOp,
  FontWeight,
} from "./types.ts";
import type { Rect } from "../theme.ts";
import type { Theme } from "../ir/types.ts";

type Box = { x: number; y: number; w: number; h: number };
type Slide = PptxGenJS.Slide;
type TextOptions = PptxGenJS.TextPropsOptions;

/** Our tokens carry a leading `#`; pptxgenjs wants bare hex (`111111`). */
const bareHex = (color: string): string =>
  color.charCodeAt(0) === 35 ? color.slice(1) : color;

const box = (r: Rect): Box => ({ x: r.xIn, y: r.yIn, w: r.wIn, h: r.hIn });

/** Avoids copying the PNG bytes when they are a view into a larger buffer. */
const base64Png = (png: Uint8Array): string =>
  Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");

const fontOptions = (
  theme: Theme,
  sizePt: number,
  weight: FontWeight,
  color: string,
): TextOptions => ({
  fontSize: sizePt,
  bold: weight === 700,
  fontFace: theme.fonts.family,
  color: bareHex(color),
  // A text rect is exact: no PowerPoint default insets.
  margin: 0,
});

const textOptions = (op: TextOp, theme: Theme): TextOptions => {
  const options: TextOptions = {
    ...box(op.rect),
    ...fontOptions(theme, op.sizePt, op.weight, op.color),
  };
  if (op.align) options.align = op.align;
  if (op.valign) options.valign = op.valign;
  return options;
};

const addText = (slide: Slide, op: TextOp, theme: Theme): void => {
  slide.addText(op.text, textOptions(op, theme));
};

const addBullets = (slide: Slide, op: BulletsOp, theme: Theme): void => {
  const outer: TextOptions = {
    ...box(op.rect),
    ...fontOptions(theme, op.sizePt, op.weight, op.color),
  };
  // Runs are split into paragraphs by `bullet`; each run needs its OWN options
  // object because the writer mutates per-run options while laying out lines.
  const runs: PptxGenJS.TextProps[] = op.items.map((item) => {
    const options: TextOptions = { ...outer, bullet: true, breakLine: true };
    if (op.gapPt !== undefined) options.paraSpaceAfter = op.gapPt;
    return { text: item, options };
  });
  slide.addText(runs, outer);
};

const addLine = (slide: Slide, pptx: PptxGenJS, op: LineOp): void => {
  const x = Math.min(op.x1In, op.x2In);
  const y = Math.min(op.y1In, op.y2In);
  const w = Math.abs(op.x2In - op.x1In);
  const h = Math.abs(op.y2In - op.y1In);
  // A `line` shape always runs corner-to-corner of its bounding box; flip when
  // the endpoints sit on opposite diagonals so the drawn slope matches.
  const flipH = (op.x2In - op.x1In) * (op.y2In - op.y1In) < 0;
  slide.addShape(pptx.ShapeType.line, {
    x,
    y,
    w,
    h,
    flipH,
    line: {
      color: bareHex(op.color),
      width: op.widthPt,
      type: "solid",
      beginArrowType: "none",
      endArrowType: "none",
    },
  });
};

const addOp = (slide: Slide, pptx: PptxGenJS, op: DrawOp, theme: Theme): void => {
  switch (op.op) {
    case "rect":
      slide.addShape(pptx.ShapeType.rect, {
        ...box(op.rect),
        fill: { color: bareHex(op.fill) },
        line: { type: "none" },
      });
      return;
    case "line":
      addLine(slide, pptx, op);
      return;
    case "text":
      addText(slide, op, theme);
      return;
    case "bullets":
      addBullets(slide, op, theme);
      return;
    case "image":
      slide.addImage({
        ...box(op.rect),
        data: `image/png;base64,${base64Png(op.png)}`,
      });
      return;
  }
};

const addSlide = (pptx: PptxGenJS, plan: SlidePlan, theme: Theme): void => {
  const slide = pptx.addSlide();
  for (const op of plan.ops) addOp(slide, pptx, op, theme);
  if (plan.notes !== undefined) slide.addNotes(plan.notes);
};

export async function writePptx(plan: RenderPlan, outPath: string): Promise<void> {
  const pptx = new PptxGenJS();
  // Define the canvas from the theme so slide size always matches the geometry
  // the layout produced (the built-in LAYOUT_WIDE is a near-miss at 13.33in).
  const layoutName = "DECKTECTIVE_CANVAS";
  pptx.defineLayout({
    name: layoutName,
    width: plan.theme.canvas.widthIn,
    height: plan.theme.canvas.heightIn,
  });
  pptx.layout = layoutName;
  for (const slidePlan of plan.slides) addSlide(pptx, slidePlan, plan.theme);
  await pptx.writeFile({ fileName: outPath });
}
