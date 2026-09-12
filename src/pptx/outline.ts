/**
 * Template outline: a compact, text-only description of a .pptx.
 *
 * A model cannot read a .pptx — it is a zip of drawing XML, mostly coordinates
 * and styling noise. So we send this instead: for each slide, every shape's id,
 * position, size and text. That is a few KB, and it is exactly what a mapping
 * decision needs ("which box should the work item title go in?").
 *
 * The shape ids in the outline are the same ids the filler uses, so a model's
 * answer is directly executable.
 */
import { PptxPackage } from "./package.ts";
import { readShapes, type ShapeInfo } from "./fill.ts";

export type OutlineShape = {
  id: string;
  /** Inches, rounded — coordinates only need to guide a mapping. */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Approximate font size in points, when the shape declares one. */
  pt?: number;
};

export type OutlineSlide = {
  /** 1-based position in presentation order. */
  slide: number;
  shapes: OutlineShape[];
};

export type TemplateOutline = {
  file: string;
  /** Canvas size in inches, so a model can reason about the layout. */
  canvas: { w: number; h: number };
  slides: OutlineSlide[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Font size for a shape, from its first run's `sz` (hundredths of a point). */
async function fontSizePt(pkg: PptxPackage, part: string, id: string): Promise<number | undefined> {
  const xml = await pkg.xml(part);
  const block = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [])
    .find((b) => new RegExp(`<p:cNvPr[^>]*\\bid="${id}"`).test(b));
  if (block === undefined) return undefined;
  const sz = /\bsz="(\d+)"/.exec(block)?.[1];
  return sz === undefined ? undefined : Number(sz) / 100;
}

export type OutlineOptions = {
  /** Include font sizes. Costs one extra parse per shape; off by default. */
  withFontSizes?: boolean;
};

/**
 * Read a template into an outline.
 *
 * Empty shapes are kept: a background panel is how a model recognises that two
 * text boxes belong to the same card, so dropping them would remove the very
 * structure the mapping depends on.
 */
export async function outlineTemplate(
  path: string,
  opts: OutlineOptions = {},
): Promise<TemplateOutline> {
  const pkg = await PptxPackage.load(path);
  const refs = pkg.slides();
  const slides: OutlineSlide[] = [];

  // Canvas comes from the first slide's shape space via the package's own
  // presentation part; fall back to a 16:9 default if it is unreadable.
  let canvas = { w: 10, h: 5.625 };
  const presXml = await pkg.xml("ppt/presentation.xml");
  const sz = /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presXml);
  if (sz) canvas = { w: round2(Number(sz[1]) / 914400), h: round2(Number(sz[2]) / 914400) };

  for (const [i, ref] of refs.entries()) {
    const shapes: ShapeInfo[] = readShapes(await pkg.xml(ref.part));
    const out: OutlineShape[] = [];
    for (const s of shapes) {
      const shape: OutlineShape = {
        id: s.id,
        x: round2(s.x),
        y: round2(s.y),
        w: round2(s.w),
        h: round2(s.h),
        text: s.text.replace(/\s+/g, " ").trim().slice(0, 120),
      };
      if (opts.withFontSizes === true) {
        const pt = await fontSizePt(pkg, ref.part, s.id);
        if (pt !== undefined) shape.pt = pt;
      }
      out.push(shape);
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    slides.push({ slide: i + 1, shapes: out });
  }

  return { file: path, canvas, slides };
}

/** Render an outline as compact text for a model prompt. */
export function outlineToPrompt(outline: TemplateOutline): string {
  const lines: string[] = [
    `Canvas: ${outline.canvas.w} x ${outline.canvas.h} in. ${outline.slides.length} slides.`,
  ];
  for (const s of outline.slides) {
    lines.push(`\nSlide ${s.slide}:`);
    for (const sh of s.shapes) {
      const text = sh.text === "" ? "(empty panel)" : JSON.stringify(sh.text);
      lines.push(
        `  id=${sh.id} x=${sh.x} y=${sh.y} w=${sh.w} h=${sh.h}`
        + (sh.pt === undefined ? "" : ` pt=${sh.pt}`)
        + ` ${text}`,
      );
    }
  }
  return lines.join("\n");
}
