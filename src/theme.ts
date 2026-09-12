/**
 * Design tokens and grid geometry.
 *
 * Geometry is authored in INCHES. Each emitter converts once:
 *   pptxgenjs -> inches
 *   pdfkit    -> inches * 72 (points)
 *   satori    -> inches * 96 (px, at 1280x720 for a 13.333x7.5in canvas)
 */
import type { Theme } from "./ir/types.ts";

export const IN_TO_PT = 72;
export const IN_TO_PX = 96;

export const inToPt = (inches: number): number => inches * IN_TO_PT;
export const inToPx = (inches: number): number => inches * IN_TO_PX;
export const ptToIn = (pt: number): number => pt / 72;

export const DEFAULT_THEME: Theme = {
  colors: {
    bg: "#FFFFFF",
    fg: "#111111",
    muted: "#555555",
    accent: "#1F6FEB",
    rule: "#DDDDDD",
  },
  fonts: {
    family: "Inter",
    regular: "assets/fonts/inter-400.ttf",
    bold: "assets/fonts/inter-700.ttf",
  },
  type: {
    titlePt: 32,
    headingPt: 24,
    bodyPt: 18,
    captionPt: 12,
  },
  grid: {
    cols: 12,
    rows: 7,
    marginIn: 0.6,
    gutterIn: 0.2,
  },
  canvas: {
    widthIn: 13.333,
    heightIn: 7.5,
  },
};

/** A rectangle in inches. Converted per emitter at the boundary. */
export type Rect = { xIn: number; yIn: number; wIn: number; hIn: number };

export const contentWidthIn = (t: Theme): number =>
  t.canvas.widthIn - 2 * t.grid.marginIn;

export const contentHeightIn = (t: Theme): number =>
  t.canvas.heightIn - 2 * t.grid.marginIn;

/** Width of one grid column, gutters excluded. */
export const colWidthIn = (t: Theme): number =>
  (contentWidthIn(t) - (t.grid.cols - 1) * t.grid.gutterIn) / t.grid.cols;

/** Height of one grid row, gutters excluded. */
export const rowHeightIn = (t: Theme): number =>
  (contentHeightIn(t) - (t.grid.rows - 1) * t.grid.gutterIn) / t.grid.rows;

/**
 * Rect for a grid cell spanning `colSpan` columns and `rowSpan` rows.
 * Columns and rows are 0-indexed and span the content box (margin applied).
 */
export function cellRect(
  t: Theme,
  col: number,
  row: number,
  colSpan = 1,
  rowSpan = 1,
): Rect {
  const cw = colWidthIn(t);
  const rh = rowHeightIn(t);
  return {
    xIn: t.grid.marginIn + col * (cw + t.grid.gutterIn),
    yIn: t.grid.marginIn + row * (rh + t.grid.gutterIn),
    wIn: colSpan * cw + (colSpan - 1) * t.grid.gutterIn,
    hIn: rowSpan * rh + (rowSpan - 1) * t.grid.gutterIn,
  };
}
