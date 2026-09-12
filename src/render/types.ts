/**
 * Backend-agnostic draw plan.
 *
 * Layout is resolved ONCE into a RenderPlan (inches + points, no backend
 * concepts). Emitters are then dumb translators: pptx -> inches, pdfkit ->
 * points, satori -> px. This is what actually stops PPTX and PDF from drifting.
 */
import type { Rect } from "../theme.ts";
import type { Theme } from "../ir/types.ts";

export type FontWeight = 400 | 700;

export type TextOp = {
  op: "text";
  rect: Rect;
  text: string;
  sizePt: number;
  weight: FontWeight;
  color: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle";
};

export type BulletsOp = {
  op: "bullets";
  rect: Rect;
  items: string[];
  sizePt: number;
  weight: FontWeight;
  color: string;
  marker?: string;
  /** Vertical gap between bullets, in points. */
  gapPt?: number;
};

export type RectOp = {
  op: "rect";
  rect: Rect;
  fill: string;
};

export type LineOp = {
  op: "line";
  x1In: number;
  y1In: number;
  x2In: number;
  y2In: number;
  color: string;
  widthPt: number;
};

export type ImageOp = {
  op: "image";
  rect: Rect;
  /** PNG bytes; charts and hero art are rasterized so both backends match. */
  png: Uint8Array;
};

export type DrawOp = TextOp | BulletsOp | RectOp | LineOp | ImageOp;

export type SlidePlan = {
  ops: DrawOp[];
  notes?: string;
};

export type RenderPlan = {
  theme: Theme;
  slides: SlidePlan[];
};
