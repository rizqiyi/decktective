export class TemplateError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "TemplateError";
        this.path = path;
    }
}
export const LAYOUT_IDS = [
    "title", "agenda", "metrics", "bullets", "timeline", "hero", "appendix",
];
const SLOT_ROLES = [
    "title", "heading", "body", "caption", "metrics", "evidence", "hero",
];
const BLOCK_KINDS = ["text", "bullets", "metrics", "evidence"];
const FILL_KINDS = [
    "text", "deck-title", "window-label", "summary", "agenda", "metrics",
    "per-day-breakdown", "day-heading", "day-items", "themes", "risks",
    "next-week", "evidence",
];
const STEP_WHEN = [
    "always", "has-themes", "has-risks", "has-next-week", "has-evidence",
];
/** Which block kind each fill produces, so slots can be checked against it. */
const FILL_PRODUCES = {
    "text": "text",
    "deck-title": "text",
    "window-label": "text",
    "summary": "text",
    "day-heading": "text",
    "agenda": "bullets",
    "metrics": "metrics",
    "per-day-breakdown": "bullets",
    "day-items": "bullets",
    "themes": "bullets",
    "risks": "bullets",
    "next-week": "bullets",
    "evidence": "evidence",
};
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function requireString(v, path) {
    if (typeof v !== "string" || v.length === 0) {
        throw new TemplateError(path, `expected a non-empty string, got ${JSON.stringify(v)}`);
    }
    return v;
}
function requireNumber(v, path) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TemplateError(path, `expected a finite number, got ${JSON.stringify(v)}`);
    }
    return v;
}
function requireNumberIn(v, path, min, max) {
    const n = requireNumber(v, path);
    if (n < min || n > max) {
        throw new TemplateError(path, `expected a number in [${min}, ${max}], got ${n}`);
    }
    return n;
}
function oneOf(v, path, allowed) {
    if (typeof v !== "string" || !allowed.includes(v)) {
        throw new TemplateError(path, `expected one of ${allowed.map((a) => JSON.stringify(a)).join(" | ")}, got ${JSON.stringify(v)}`);
    }
    return v;
}
const EMPHASES = ["normal", "muted", "accent"];
const REPEATS = ["per-day"];
function parseTheme(raw) {
    if (!isObject(raw))
        throw new TemplateError("theme", "expected an object");
    const colors = raw.colors;
    const fonts = raw.fonts;
    const type = raw.type;
    const grid = raw.grid;
    const canvas = raw.canvas;
    if (!isObject(colors))
        throw new TemplateError("theme.colors", "expected an object");
    if (!isObject(fonts))
        throw new TemplateError("theme.fonts", "expected an object");
    if (!isObject(type))
        throw new TemplateError("theme.type", "expected an object");
    if (!isObject(grid))
        throw new TemplateError("theme.grid", "expected an object");
    if (!isObject(canvas))
        throw new TemplateError("theme.canvas", "expected an object");
    const cols = requireNumberIn(grid.cols, "theme.grid.cols", 1, 48);
    const rows = requireNumberIn(grid.rows, "theme.grid.rows", 1, 48);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
        throw new TemplateError("theme.grid", "cols and rows must be integers");
    }
    if (requireNumber(canvas.widthIn, "theme.canvas.widthIn") <= 0) {
        throw new TemplateError("theme.canvas.widthIn", "must be positive");
    }
    if (requireNumber(canvas.heightIn, "theme.canvas.heightIn") <= 0) {
        throw new TemplateError("theme.canvas.heightIn", "must be positive");
    }
    const marginIn = requireNumber(grid.marginIn, "theme.grid.marginIn");
    const gutterIn = requireNumber(grid.gutterIn, "theme.grid.gutterIn");
    if (marginIn < 0 || gutterIn < 0) {
        throw new TemplateError("theme.grid", "marginIn and gutterIn must be >= 0");
    }
    return {
        colors: {
            bg: requireString(colors.bg, "theme.colors.bg"),
            fg: requireString(colors.fg, "theme.colors.fg"),
            muted: requireString(colors.muted, "theme.colors.muted"),
            accent: requireString(colors.accent, "theme.colors.accent"),
            rule: requireString(colors.rule, "theme.colors.rule"),
        },
        fonts: {
            family: requireString(fonts.family, "theme.fonts.family"),
            regular: requireString(fonts.regular, "theme.fonts.regular"),
            bold: requireString(fonts.bold, "theme.fonts.bold"),
        },
        type: {
            titlePt: requireNumber(type.titlePt, "theme.type.titlePt"),
            headingPt: requireNumber(type.headingPt, "theme.type.headingPt"),
            bodyPt: requireNumber(type.bodyPt, "theme.type.bodyPt"),
            captionPt: requireNumber(type.captionPt, "theme.type.captionPt"),
        },
        grid: { cols, rows, marginIn, gutterIn },
        canvas: {
            widthIn: requireNumber(canvas.widthIn, "theme.canvas.widthIn"),
            heightIn: requireNumber(canvas.heightIn, "theme.canvas.heightIn"),
        },
    };
}
function parseSlot(raw, path, cols, rows) {
    if (!isObject(raw))
        throw new TemplateError(path, "expected an object");
    const col = requireNumberIn(raw.col, `${path}.col`, 0, cols - 1);
    const row = requireNumberIn(raw.row, `${path}.row`, 0, rows - 1);
    const colSpan = requireNumberIn(raw.colSpan, `${path}.colSpan`, 1, cols);
    const rowSpan = requireNumberIn(raw.rowSpan, `${path}.rowSpan`, 1, rows);
    if (col + colSpan > cols) {
        throw new TemplateError(`${path}.colSpan`, `col ${col} + span ${colSpan} exceeds grid width ${cols}`);
    }
    if (row + rowSpan > rows) {
        throw new TemplateError(`${path}.rowSpan`, `row ${row} + span ${rowSpan} exceeds grid height ${rows}`);
    }
    const accepts = raw.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) {
        throw new TemplateError(`${path}.accepts`, "expected a non-empty array of block kinds");
    }
    return {
        key: requireString(raw.key, `${path}.key`),
        role: oneOf(raw.role, `${path}.role`, SLOT_ROLES),
        col, row, colSpan, rowSpan,
        accepts: accepts.map((a, i) => oneOf(a, `${path}.accepts[${i}]`, BLOCK_KINDS)),
    };
}
function parseLayout(raw, path, theme) {
    if (!isObject(raw))
        throw new TemplateError(path, "expected an object");
    const id = oneOf(raw.id, `${path}.id`, LAYOUT_IDS);
    if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
        throw new TemplateError(`${path}.slots`, "expected a non-empty array");
    }
    const slots = raw.slots.map((s, i) => parseSlot(s, `${path}.slots[${i}]`, theme.grid.cols, theme.grid.rows));
    const seen = new Set();
    for (const s of slots) {
        if (seen.has(s.key))
            throw new TemplateError(`${path}.slots`, `duplicate slot key ${JSON.stringify(s.key)}`);
        seen.add(s.key);
    }
    return { id, slots };
}
function parseFill(raw, path) {
    if (!isObject(raw))
        throw new TemplateError(path, "expected an object");
    const kind = oneOf(raw.kind, `${path}.kind`, FILL_KINDS);
    if (kind === "text") {
        const spec = { kind: "text", text: requireString(raw.text, `${path}.text`) };
        if (raw.emphasis !== undefined) {
            return { ...spec, emphasis: oneOf(raw.emphasis, `${path}.emphasis`, EMPHASES) };
        }
        return spec;
    }
    return { kind };
}
function parseStep(raw, path, layouts) {
    if (!isObject(raw))
        throw new TemplateError(path, "expected an object");
    const layout = oneOf(raw.layout, `${path}.layout`, LAYOUT_IDS);
    const spec = layouts.find((l) => l.id === layout);
    if (!spec) {
        throw new TemplateError(`${path}.layout`, `template does not define layout ${JSON.stringify(layout)} (defines: ${layouts.map((l) => l.id).join(", ")})`);
    }
    const step = {
        id: requireString(raw.id, `${path}.id`),
        layout,
        fill: {},
    };
    if (raw.title !== undefined)
        step.title = requireString(raw.title, `${path}.title`);
    if (raw.repeat !== undefined)
        step.repeat = oneOf(raw.repeat, `${path}.repeat`, REPEATS);
    if (raw.when !== undefined)
        step.when = oneOf(raw.when, `${path}.when`, STEP_WHEN);
    if (!isObject(raw.fill) || Object.keys(raw.fill).length === 0) {
        throw new TemplateError(`${path}.fill`, "expected a non-empty object of slotKey -> fill");
    }
    const slotByKey = new Map(spec.slots.map((s) => [s.key, s]));
    for (const [key, fillRaw] of Object.entries(raw.fill)) {
        const fillPath = `${path}.fill.${key}`;
        const slot = slotByKey.get(key);
        if (!slot) {
            const known = spec.slots.map((s) => s.key).join(", ");
            throw new TemplateError(fillPath, `layout ${JSON.stringify(layout)} has no slot ${JSON.stringify(key)} (has: ${known})`);
        }
        const fill = parseFill(fillRaw, fillPath);
        const produced = FILL_PRODUCES[fill.kind];
        if (!slot.accepts.includes(produced)) {
            throw new TemplateError(fillPath, `slot ${JSON.stringify(key)} accepts [${slot.accepts.join(", ")}] but fill ${JSON.stringify(fill.kind)} produces ${JSON.stringify(produced)}`);
        }
        step.fill[key] = fill;
    }
    // A slot that is never filled is legal (it stays empty), but a repeated step
    // without day-scoped content would emit identical slides for every day.
    if (step.repeat === "per-day") {
        const hasDayContent = Object.values(step.fill).some((f) => f.kind === "day-heading" || f.kind === "day-items");
        if (!hasDayContent) {
            throw new TemplateError(`${path}.repeat`, "a per-day step must fill at least one slot with \"day-heading\" or \"day-items\"");
        }
    }
    return step;
}
/** Parse untrusted JSON into a validated template. Throws `TemplateError`. */
export function parseTemplate(raw) {
    if (!isObject(raw))
        throw new TemplateError("template", "expected an object");
    const theme = parseTheme(raw.theme);
    if (!Array.isArray(raw.layouts) || raw.layouts.length === 0) {
        throw new TemplateError("layouts", "expected a non-empty array");
    }
    const layouts = raw.layouts.map((l, i) => parseLayout(l, `layouts[${i}]`, theme));
    const layoutIds = new Set(layouts.map((l) => l.id));
    if (layoutIds.size !== layouts.length) {
        throw new TemplateError("layouts", "duplicate layout ids");
    }
    if (!Array.isArray(raw.skeleton) || raw.skeleton.length === 0) {
        throw new TemplateError("skeleton", "expected a non-empty array");
    }
    const skeleton = raw.skeleton.map((s, i) => parseStep(s, `skeleton[${i}]`, layouts));
    const stepIds = new Set();
    for (const s of skeleton) {
        if (stepIds.has(s.id))
            throw new TemplateError("skeleton", `duplicate step id ${JSON.stringify(s.id)}`);
        stepIds.add(s.id);
    }
    return {
        id: requireString(raw.id, "id"),
        name: requireString(raw.name, "name"),
        version: requireNumber(raw.version, "version"),
        theme,
        layouts,
        skeleton,
    };
}
