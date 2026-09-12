/**
 * PPTX emitter: RenderPlan -> .pptx via pptxgenjs.
 *
 * pptxgenjs speaks inches (positions/sizes) and points (font/text sizes),
 * which is exactly the RenderPlan contract, so ops pass through untranslated.
 * Ops are drawn in array order (painter's order).
 */
import PptxGenJS from "pptxgenjs";
/** Our tokens carry a leading `#`; pptxgenjs wants bare hex (`111111`). */
const bareHex = (color) => color.charCodeAt(0) === 35 ? color.slice(1) : color;
const box = (r) => ({ x: r.xIn, y: r.yIn, w: r.wIn, h: r.hIn });
/** Avoids copying the PNG bytes when they are a view into a larger buffer. */
const base64Png = (png) => Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");
const fontOptions = (theme, sizePt, weight, color) => ({
    fontSize: sizePt,
    bold: weight === 700,
    fontFace: theme.fonts.family,
    color: bareHex(color),
    // A text rect is exact: no PowerPoint default insets.
    margin: 0,
});
const textOptions = (op, theme) => {
    const options = {
        ...box(op.rect),
        ...fontOptions(theme, op.sizePt, op.weight, op.color),
    };
    if (op.align)
        options.align = op.align;
    if (op.valign)
        options.valign = op.valign;
    return options;
};
const addText = (slide, op, theme) => {
    slide.addText(op.text, textOptions(op, theme));
};
const addBullets = (slide, op, theme) => {
    const outer = {
        ...box(op.rect),
        ...fontOptions(theme, op.sizePt, op.weight, op.color),
    };
    // Runs are split into paragraphs by `bullet`; each run needs its OWN options
    // object because the writer mutates per-run options while laying out lines.
    const runs = op.items.map((item) => {
        const options = { ...outer, bullet: true, breakLine: true };
        if (op.gapPt !== undefined)
            options.paraSpaceAfter = op.gapPt;
        return { text: item, options };
    });
    slide.addText(runs, outer);
};
const addLine = (slide, pptx, op) => {
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
const addOp = (slide, pptx, op, theme) => {
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
const addSlide = (pptx, plan, theme) => {
    const slide = pptx.addSlide();
    for (const op of plan.ops)
        addOp(slide, pptx, op, theme);
    if (plan.notes !== undefined)
        slide.addNotes(plan.notes);
};
export async function writePptx(plan, outPath) {
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
    for (const slidePlan of plan.slides)
        addSlide(pptx, slidePlan, plan.theme);
    await pptx.writeFile({ fileName: outPath });
}
