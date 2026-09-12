/**
 * Text measurement against the bundled TTFs.
 *
 * Overflow must be MEASURED, not hoped. Measurement uses fontkit (the engine
 * inside pdfkit) because it parses these fonts correctly; advance widths are
 * font-intrinsic, so the numbers are valid for the PPTX backend too.
 */
import { openSync } from "fontkit";
const cache = new Map();
export function loadFont(path) {
    const hit = cache.get(path);
    if (hit)
        return hit;
    const font = openSync(path);
    cache.set(path, font);
    return font;
}
export function measureCtx(regularPath, boldPath) {
    return { regular: loadFont(regularPath), bold: loadFont(boldPath) };
}
/**
 * Advance width at 1pt, cached.
 *
 * Font shaping is the expensive step here, and advance width is exactly linear
 * in font size, so the width at any size is `unitWidth * sizePt`. The autofit
 * ladder re-measures the same words at ~20 sizes; caching the unit width turns
 * that from 20 shaping passes per word into one.
 */
const unitWidths = new Map();
function unitWidth(ctx, text, weight) {
    const key = `${weight}\u0000${text}`;
    const hit = unitWidths.get(key);
    if (hit !== undefined)
        return hit;
    const font = weight === 700 ? ctx.bold : ctx.regular;
    const w = font.layout(text).advanceWidth / font.unitsPerEm;
    unitWidths.set(key, w);
    return w;
}
/**
 * Characters in `text` that the font has no glyph for (id 0).
 *
 * A missing glyph renders as tofu in the PDF and as a blank box in the PNG
 * backend — a silent, visible defect. The bundled Inter subset does not cover
 * every symbol (U+2192 is a notable gap), so text is checked before layout and
 * uncovered characters fail the build.
 */
const coverage = new Map();
export function missingGlyphs(ctx, text, weight = 400) {
    const font = weight === 700 ? ctx.bold : ctx.regular;
    const tag = weight === 700 ? "b" : "r";
    const missing = [];
    const seen = new Set();
    for (const ch of text) {
        if (seen.has(ch))
            continue;
        seen.add(ch);
        // Control characters are laid out as breaks, not glyphs.
        if (ch === "\n" || ch === "\t" || ch === "\r")
            continue;
        const key = `${tag}\u0000${ch}`;
        let covered = coverage.get(key);
        if (covered === undefined) {
            const run = font.layout(ch);
            const first = run.glyphs[0];
            covered = first !== undefined && first.id !== 0;
            coverage.set(key, covered);
        }
        if (!covered)
            missing.push(ch);
    }
    return missing;
}
/** Natural line height for one line at this size, in points. */
export function lineHeightPt(ctx, sizePt, weight = 400) {
    const font = weight === 700 ? ctx.bold : ctx.regular;
    return ((font.ascent - font.descent) / font.unitsPerEm) * sizePt;
}
/**
 * Greedy word wrap, mirroring what the renderers do. Returns the wrapped
 * lines so callers can both measure and reason about overflow.
 */
export function wrapLines(ctx, text, widthPt, sizePt, weight = 400) {
    const out = [];
    for (const paragraph of text.split("\n")) {
        if (paragraph === "") {
            out.push("");
            continue;
        }
        let line = "";
        let lineWidth = 0;
        // Word widths are cached, so accumulating beats re-measuring the whole
        // candidate string for every word.
        for (const word of paragraph.split(/\s+/)) {
            const wordWidth = unitWidth(ctx, word, weight) * sizePt;
            const spaceWidth = line === "" ? 0 : unitWidth(ctx, " ", weight) * sizePt;
            if (line === "" || lineWidth + spaceWidth + wordWidth <= widthPt) {
                line = line === "" ? word : `${line} ${word}`;
                lineWidth += spaceWidth + wordWidth;
            }
            else {
                out.push(line);
                line = word;
                lineWidth = wordWidth;
            }
        }
        out.push(line);
    }
    return out;
}
/** Height of `text` wrapped to `widthPt`, in points. */
export function measureHeightPt(ctx, text, widthPt, sizePt, weight = 400) {
    const lines = wrapLines(ctx, text, widthPt, sizePt, weight);
    return lines.length * lineHeightPt(ctx, sizePt, weight);
}
/**
 * Autofit ladder. Returns the largest size at or below `startPt` that fits,
 * or null when even the floor does not fit (caller must then split or fail).
 * Never returns a size below `floorPt` — silently unreadable text is worse
 * than a loud failure.
 */
export function fitSizePt(ctx, text, widthPt, heightPt, startPt, opts = {}) {
    const weight = opts.weight ?? 400;
    const floor = opts.floorPt ?? 12;
    const step = opts.stepPt ?? 1;
    for (let size = startPt; size >= floor; size -= step) {
        if (measureHeightPt(ctx, text, widthPt, size, weight) <= heightPt)
            return size;
    }
    return null;
}
