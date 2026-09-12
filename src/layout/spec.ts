/**
 * Layout specs: the grid geometry each LayoutId exposes as named slots.
 *
 * This is the contract between the IR and the layout resolver. Emitters never
 * see it — they consume the resolved RenderPlan — so PPTX and PDF cannot drift.
 * All rects derive from the theme grid, so geometry has one source of truth.
 */
import type { Block, LayoutId, Theme } from "../ir/types.ts";
import { cellRect, type Rect } from "../theme.ts";

export type SlotRole =
  | "title" | "heading" | "body" | "caption" | "metrics" | "evidence" | "hero";

export type SlotSpec = {
  key: string;
  role: SlotRole;
  rect: Rect;
  accepts: Array<Block["kind"]>;
};

export type LayoutSpec = {
  id: LayoutId;
  slots: SlotSpec[];
};

const FULL = 12;

/** Grid rect helpers relative to the content box. */
const at = (
  t: Theme,
  row: number,
  rowSpan: number,
  col = 0,
  colSpan = FULL,
): Rect => cellRect(t, col, row, colSpan, rowSpan);

export function layoutSpec(id: LayoutId, t: Theme): LayoutSpec {
  switch (id) {
    case "title":
      return {
        id,
        slots: [
          { key: "title", role: "title", rect: at(t, 1, 2), accepts: ["text"] },
          { key: "subtitle", role: "caption", rect: at(t, 3, 1), accepts: ["text"] },
        ],
      };

    case "agenda":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "bullets", role: "body", rect: at(t, 1, 6), accepts: ["bullets"] },
        ],
      };

    case "metrics":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "metrics", role: "metrics", rect: at(t, 1, 2), accepts: ["metrics"] },
          // Per-day rows: commit count and churn side by side, so the mismatch
          // between the two axes stays visible instead of being averaged away.
          { key: "breakdown", role: "body", rect: at(t, 3, 3), accepts: ["bullets"] },
          { key: "note", role: "caption", rect: at(t, 6, 1), accepts: ["text"] },
        ],
      };

    case "bullets":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "bullets", role: "body", rect: at(t, 1, 6), accepts: ["bullets"] },
        ],
      };

    case "timeline":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "bullets", role: "body", rect: at(t, 1, 6), accepts: ["bullets"] },
        ],
      };

    case "hero":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "hero", role: "hero", rect: at(t, 2, 2), accepts: ["text"] },
          { key: "note", role: "caption", rect: at(t, 5, 1), accepts: ["text"] },
        ],
      };

    case "appendix":
      return {
        id,
        slots: [
          { key: "heading", role: "heading", rect: at(t, 0, 1), accepts: ["text"] },
          { key: "evidence", role: "evidence", rect: at(t, 1, 6), accepts: ["evidence"] },
        ],
      };
  }
}

/** Font size for a slot role, from theme tokens. */
export function roleSizePt(role: SlotRole, t: Theme): number {
  switch (role) {
    case "title": return t.type.titlePt;
    case "heading": return t.type.headingPt;
    case "hero": return t.type.titlePt * 2;
    case "metrics": return t.type.headingPt;
    case "caption": return t.type.captionPt;
    case "evidence": return t.type.captionPt;
    case "body": return t.type.bodyPt;
  }
}
