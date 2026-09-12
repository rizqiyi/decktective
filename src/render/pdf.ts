/**
 * PDF emitter: RenderPlan -> one pdfkit page per slide.
 *
 * pdfkit measures and lays out in POINTS; the plan is authored in INCHES. Every
 * geometric value therefore crosses that boundary exactly once, through inToPt.
 *
 * pdfkit silently clips (and overflows) text past its box height. The design
 * requires overflow to fail loudly, so every text-bearing op is measured with
 * heightOfString BEFORE it is drawn and throws on mismatch. Measurement uses the
 * exact font/size/width the draw call will use, otherwise the guard is a lie.
 */
import fs from "node:fs";
import PDFDocument from "pdfkit";
import { inToPt, type Rect } from "../theme.ts";
import type { BulletsOp, DrawOp, FontWeight, ImageOp, LineOp, RectOp, RenderPlan, TextOp } from "./types.ts";

type Doc = PDFKit.PDFDocument;

const FONT_REGULAR = "inter";
const FONT_BOLD = "inter-bold";
const DEFAULT_BULLET_MARKER = "• ";
/** Points. Measurement is float; a box that fits exactly must not look like overflow. */
const FIT_EPSILON = 1e-6;

const fontName = (weight: FontWeight): string => (weight === 700 ? FONT_BOLD : FONT_REGULAR);

/** Sets the state pdfkit draws AND measures with, so both see the same font. */
const applyTextStyle = (doc: Doc, weight: FontWeight, sizePt: number, color: string): void => {
  doc.font(fontName(weight)).fontSize(sizePt).fillColor(color);
};

const overflowError = (
  kind: string,
  text: string,
  rect: Rect,
  neededPt: number,
  availablePt: number,
): Error =>
  new Error(
    `PDF ${kind} overflow: content needs ${neededPt.toFixed(2)}pt but its rect allows ` +
      `${availablePt.toFixed(2)}pt (x=${rect.xIn}in y=${rect.yIn}in w=${rect.wIn}in h=${rect.hIn}in) ` +
      `for text ${JSON.stringify(text)}`,
  );

const drawText = (doc: Doc, op: TextOp): void => {
  const widthPt = inToPt(op.rect.wIn);
  const heightPt = inToPt(op.rect.hIn);
  applyTextStyle(doc, op.weight, op.sizePt, op.color);
  const measuredPt = doc.heightOfString(op.text, { width: widthPt });
  if (measuredPt > heightPt + FIT_EPSILON) {
    throw overflowError("text", op.text, op.rect, measuredPt, heightPt);
  }
  const yPt = inToPt(op.rect.yIn) + (op.valign === "middle" ? (heightPt - measuredPt) / 2 : 0);
  doc.text(op.text, inToPt(op.rect.xIn), yPt, {
    width: widthPt,
    height: heightPt,
    align: op.align ?? "left",
  });
};

const drawBullets = (doc: Doc, op: BulletsOp): void => {
  const xPt = inToPt(op.rect.xIn);
  const topPt = inToPt(op.rect.yIn);
  const widthPt = inToPt(op.rect.wIn);
  const heightPt = inToPt(op.rect.hIn);
  const gapPt = op.gapPt ?? 0;
  const marker = op.marker ?? DEFAULT_BULLET_MARKER;
  applyTextStyle(doc, op.weight, op.sizePt, op.color);
  let yPt = topPt;
  for (const item of op.items) {
    const line = marker + item;
    const lineHeightPt = doc.heightOfString(line, { width: widthPt });
    const neededPt = yPt - topPt + lineHeightPt;
    if (neededPt > heightPt + FIT_EPSILON) {
      throw overflowError("bullets", line, op.rect, neededPt, heightPt);
    }
    doc.text(line, xPt, yPt, { width: widthPt });
    yPt += lineHeightPt + gapPt;
  }
};

const drawRect = (doc: Doc, op: RectOp): void => {
  doc
    .save()
    .rect(inToPt(op.rect.xIn), inToPt(op.rect.yIn), inToPt(op.rect.wIn), inToPt(op.rect.hIn))
    .fill(op.fill)
    .restore();
};

const drawLine = (doc: Doc, op: LineOp): void => {
  doc
    .save()
    .moveTo(inToPt(op.x1In), inToPt(op.y1In))
    .lineTo(inToPt(op.x2In), inToPt(op.y2In))
    .lineWidth(op.widthPt)
    .stroke(op.color)
    .restore();
};

const drawImage = (doc: Doc, op: ImageOp): void => {
  doc.image(Buffer.from(op.png), inToPt(op.rect.xIn), inToPt(op.rect.yIn), {
    width: inToPt(op.rect.wIn),
    height: inToPt(op.rect.hIn),
  });
};

const drawOp = (doc: Doc, op: DrawOp): void => {
  switch (op.op) {
    case "text":
      return drawText(doc, op);
    case "bullets":
      return drawBullets(doc, op);
    case "rect":
      return drawRect(doc, op);
    case "line":
      return drawLine(doc, op);
    case "image":
      return drawImage(doc, op);
    default:
      throw new Error(`unhandled draw op: ${JSON.stringify(op)}`);
  }
};

export async function writePdf(plan: RenderPlan, outPath: string): Promise<void> {
  const { widthIn, heightIn } = plan.theme.canvas;
  const doc = new PDFDocument({
    size: [inToPt(widthIn), inToPt(heightIn)],
    margin: 0,
    autoFirstPage: false,
  });
  // Registered once: pdfkit embeds each font on first use, then reuses the alias.
  doc.registerFont(FONT_REGULAR, plan.theme.fonts.regular);
  doc.registerFont(FONT_BOLD, plan.theme.fonts.bold);

  // Draw (and measure) every op BEFORE touching the filesystem: an overflow
  // must fail without leaving a truncated, 15-byte PDF behind.
  for (const slide of plan.slides) {
    doc.addPage();
    for (const op of slide.ops) drawOp(doc, op);
  }

  const written = new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    out.on("finish", () => resolve());
    out.on("error", (err: Error) => reject(err));
    doc.on("error", (err: Error) => reject(err));
    doc.pipe(out);
  });

  doc.end();
  await written;
}
