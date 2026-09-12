/**
 * Rough slide preview for a generated PPTX.
 *
 * There is no Office or LibreOffice on this machine, so a filled deck cannot be
 * rendered by the usual route. This draws each shape's box and text into an SVG
 * and rasterizes it, which is enough to catch what text extraction cannot:
 * overlap, overflow, gaps, and misplaced cards.
 *
 * It is NOT a faithful renderer — fonts and wrapping are approximate. Treat it
 * as a layout check, not a proof.
 *
 * Usage: node scripts/preview-pptx.mjs <deck.pptx> [slideNumber] [out.png]
 */
import { readFileSync, writeFileSync } from "node:fs";
import JSZip from "jszip";
import { Resvg } from "@resvg/resvg-js";

const EMU = 914400;

const [deckPath, slideArg = "1", outPath = "/tmp/slide.png"] = process.argv.slice(2);
if (!deckPath) {
  console.error("usage: node scripts/preview-pptx.mjs <deck.pptx> [slideNumber] [out.png]");
  process.exit(2);
}

const zip = await JSZip.loadAsync(readFileSync(deckPath));

async function readPart(name) {
  const f = zip.file(name);
  if (!f) throw new Error(`missing part in package: ${name}`);
  return f.async("string");
}

const pres = await readPart("ppt/presentation.xml");
const rels = await readPart("ppt/_rels/presentation.xml.rels");

const relTarget = new Map();
for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
  const tag = m[0];
  const id = /\bId="([^"]+)"/.exec(tag)?.[1];
  const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
  if (id && target) relTarget.set(id, target);
}

/** Slides in presentation order (the package's file names are not ordered). */
const order = [];
for (const m of pres.matchAll(/<p:sldId\b[^>]*\/>/g)) {
  const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
  const target = rid ? relTarget.get(rid) : undefined;
  if (target) order.push(`ppt/${target.replace(/^\.\.\//, "")}`);
}
if (order.length === 0) throw new Error("could not resolve any slides from presentation.xml");

const size = /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(pres);
const W = size ? Number(size[1]) / EMU : 10;
const H = size ? Number(size[2]) / EMU : 5.625;

const slideNo = Math.min(Math.max(1, Number(slideArg)), order.length);
const raw = await readPart(order[slideNo - 1]);

const unescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const shapes = [];
for (const block of raw.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(block);
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(block);
  if (!off || !ext) continue;
  const text = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescape(m[1])).join("\n");
  shapes.push({
    x: Number(off[1]) / EMU,
    y: Number(off[2]) / EMU,
    w: Number(ext[1]) / EMU,
    h: Number(ext[2]) / EMU,
    text,
    pt: Number(/ sz="(\d+)"/.exec(block)?.[1] ?? 1200) / 100,
    bold: / b="1"/.test(block),
    fill: /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(block)?.[1],
  });
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const parts = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];

// Boxes first, then text, so text is never hidden behind a panel.
for (const s of shapes) {
  const fill = s.fill ? `#${s.fill}` : "#0000ff";
  parts.push(
    `<rect x="${s.x.toFixed(3)}" y="${s.y.toFixed(3)}" width="${s.w.toFixed(3)}" height="${s.h.toFixed(3)}" `
    + `fill="${fill}" opacity="${s.fill ? 0.45 : 0.06}" stroke="#8fa3b0" stroke-width="0.008"/>`,
  );
}

for (const s of shapes) {
  if (s.text.trim() === "") continue;
  const fontIn = s.pt / 72;
  const perLine = Math.max(1, Math.floor((s.w * 72) / (s.pt * 0.52)));
  const lines = s.text.split("\n").flatMap((line) => {
    if (line === "") return [""];
    const wrapped = [];
    for (let i = 0; i < line.length; i += perLine) wrapped.push(line.slice(i, i + perLine));
    return wrapped;
  });
  lines.forEach((line, i) => {
    parts.push(
      `<text x="${(s.x + 0.03).toFixed(3)}" y="${(s.y + 0.03 + (i + 0.8) * fontIn * 1.22).toFixed(3)}" `
      + `font-family="Helvetica,sans-serif" font-size="${fontIn.toFixed(4)}" `
      + `font-weight="${s.bold ? 700 : 400}" fill="#111111">${esc(line)}</text>`,
    );
  });
}

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 96}" height="${H * 96}" `
  + `viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1400 } }).render().asPng();
writeFileSync(outPath, png);
console.log(`slide ${slideNo} of ${order.length} (${order[slideNo - 1]}) -> ${outPath}`);
