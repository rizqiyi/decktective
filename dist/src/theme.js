/** Font size for a slot role, from theme tokens. */
export function roleSizePt(role, t) {
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
export const IN_TO_PT = 72;
export const inToPt = (inches) => inches * IN_TO_PT;
export const contentWidthIn = (t) => t.canvas.widthIn - 2 * t.grid.marginIn;
export const contentHeightIn = (t) => t.canvas.heightIn - 2 * t.grid.marginIn;
/** Width of one grid column, gutters excluded. */
export const colWidthIn = (t) => (contentWidthIn(t) - (t.grid.cols - 1) * t.grid.gutterIn) / t.grid.cols;
/** Height of one grid row, gutters excluded. */
export const rowHeightIn = (t) => (contentHeightIn(t) - (t.grid.rows - 1) * t.grid.gutterIn) / t.grid.rows;
/**
 * Rect for a grid cell spanning `colSpan` columns and `rowSpan` rows.
 * Columns and rows are 0-indexed and span the content box (margin applied).
 */
export function cellRect(t, col, row, colSpan = 1, rowSpan = 1) {
    const cw = colWidthIn(t);
    const rh = rowHeightIn(t);
    return {
        xIn: t.grid.marginIn + col * (cw + t.grid.gutterIn),
        yIn: t.grid.marginIn + row * (rh + t.grid.gutterIn),
        wIn: colSpan * cw + (colSpan - 1) * t.grid.gutterIn,
        hIn: rowSpan * rh + (rowSpan - 1) * t.grid.gutterIn,
    };
}
