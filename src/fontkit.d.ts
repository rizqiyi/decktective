/**
 * Minimal typing for the subset of fontkit used here.
 * fontkit ships no types; pdfkit depends on it, and it parses TTF correctly
 * where opentype.js throws on Inter's GSUB lookupType 6 / substFormat 2.
 */
declare module "fontkit" {
  export type Font = {
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    lineHeight: number;
    layout(text: string): {
      advanceWidth: number;
      /** Glyph id 0 is `.notdef` — the font has no glyph for that character. */
      glyphs: Array<{ id: number }>;
    };
  };
  export function openSync(path: string): Font;
}
