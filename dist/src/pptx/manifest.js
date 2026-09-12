/**
 * Template manifests: the LLM-derived fill plan for an UNKNOWN template.
 *
 * The served template ships a hand-written plan (`weekly.ts`), so it needs no
 * model. An uploaded template does not, and that is the whole problem: the
 * mapping from "our data" to "that template's boxes" is a judgement about
 * layout, which a model can make from an outline and code cannot guess.
 *
 * The model never touches XML. It returns this JSON, which is:
 *   1. validated structurally (unknown fill kinds, bad slides, empty steps), and
 *   2. validated against the real outline (every shape id must exist),
 * and only then executed by the same deterministic filler the served template
 * uses. So a bad manifest is a small fixable JSON error, never a corrupt deck.
 *
 * Manifests are cached next to being generated, so an uploaded template is
 * learned once and every later run is offline, deterministic and free.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { completeJson } from "../llm/json.js";
import { outlineToPrompt } from "./outline.js";
export const FILL_KIND_LIST = [
    "deck-title", "window-label", "summary", "metrics", "per-day-breakdown",
    "agenda", "themes", "risks", "next-week", "evidence", "day-heading", "day-summary",
];
export class ManifestError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "ManifestError";
        this.path = path;
    }
}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** Parse untrusted JSON into a manifest, without checking it against a template. */
export function parseManifest(raw) {
    if (!isObject(raw))
        throw new ManifestError("manifest", "expected an object");
    const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "Deck";
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
        throw new ManifestError("steps", "expected a non-empty array");
    }
    const steps = [];
    raw.steps.forEach((entry, i) => {
        const at = `steps[${i}]`;
        if (!isObject(entry))
            throw new ManifestError(at, "expected an object");
        const slide = entry.slide;
        if (typeof slide !== "number" || !Number.isInteger(slide) || slide < 1) {
            throw new ManifestError(`${at}.slide`, `expected a positive integer, got ${JSON.stringify(slide)}`);
        }
        if (!isObject(entry.slots) || Object.keys(entry.slots).length === 0) {
            throw new ManifestError(`${at}.slots`, "expected a non-empty map of slotKey -> fillKind");
        }
        const slots = {};
        for (const [slot, kind] of Object.entries(entry.slots)) {
            if (typeof kind !== "string" || !FILL_KIND_LIST.includes(kind)) {
                throw new ManifestError(`${at}.slots.${slot}`, `unknown fill kind ${JSON.stringify(kind)}; known: ${FILL_KIND_LIST.join(", ")}`);
            }
            slots[slot] = kind;
        }
        const step = { slide, slots };
        if (entry.repeat !== undefined) {
            if (entry.repeat !== "per-day") {
                throw new ManifestError(`${at}.repeat`, `expected "per-day", got ${JSON.stringify(entry.repeat)}`);
            }
            step.repeat = "per-day";
        }
        if (entry.title !== undefined) {
            if (typeof entry.title !== "string")
                throw new ManifestError(`${at}.title`, "expected a string");
            step.title = entry.title;
        }
        steps.push(step);
    });
    return {
        name,
        source: typeof raw.source === "string" ? raw.source : "unknown",
        notes: Array.isArray(raw.notes)
            ? raw.notes.filter((n) => typeof n === "string" && n.trim() !== "").slice(0, 20)
            : [],
        omit: Array.isArray(raw.omit)
            ? raw.omit.filter((n) => Number.isInteger(n) && n >= 1)
            : [],
        steps,
    };
}
/**
 * Check a manifest against the template it claims to describe.
 *
 * This is the boundary that makes a model's answer safe to execute: shape ids
 * must exist, and a step must not point past the end of the deck. Anything that
 * fails here is reported with a path a model can act on.
 */
export function validateManifest(manifest, outline) {
    const issues = [];
    const shapeIds = new Set(outline.slides.flatMap((s) => s.shapes.map((sh) => sh.id)));
    const slideNumbers = new Set(outline.slides.map((s) => s.slide));
    const perDay = manifest.steps.filter((s) => s.repeat === "per-day");
    for (let i = 0; i < manifest.steps.length; i++) {
        const step = manifest.steps[i];
        const at = `steps[${i}]`;
        if (!slideNumbers.has(step.slide)) {
            issues.push({
                path: `${at}.slide`,
                message: `slide ${step.slide} does not exist (template has ${outline.slides.length})`,
            });
            continue;
        }
        // A per-day step must carry day-scoped content, or every repetition is identical.
        if (step.repeat === "per-day") {
            const kinds = Object.values(step.slots);
            if (!kinds.includes("day-heading") && !kinds.includes("day-summary")) {
                issues.push({
                    path: `${at}.repeat`,
                    message: 'a per-day step must use "day-heading" or "day-summary"',
                });
            }
        }
        for (const [slot, kind] of Object.entries(step.slots)) {
            if (!shapeIds.has(slot)) {
                issues.push({
                    path: `${at}.slots.${slot}`,
                    message: `no shape with that id on slide ${step.slide}`,
                });
            }
            void kind;
        }
    }
    if (perDay.length > 1) {
        issues.push({
            path: "steps",
            message: `${perDay.length} per-day steps; expected at most one`,
        });
    }
    return issues;
}
/** Where a learned manifest is cached for this template. */
export function manifestCachePath(templatePath, cacheDir) {
    const base = templatePath.split("/").pop() ?? "template";
    return join(cacheDir, "manifests", `${base.replace(/\.pptx$/i, "")}.manifest.json`);
}
export async function saveManifest(path, manifest) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
export async function loadManifest(path) {
    try {
        return parseManifest(JSON.parse(await readFile(path, "utf8")));
    }
    catch (err) {
        if (err instanceof ManifestError)
            throw err;
        throw new ManifestError(path, err instanceof Error ? err.message : String(err));
    }
}
export const MANIFEST_SYSTEM = "You map a slide template to a weekly-engineering-report pipeline. You are " +
    "given the template's shapes with their ids, positions, sizes and any placeholder " +
    "text. Decide which slide and which SHAPE IDs should receive which data.\n\n" +
    "Rules:\n" +
    "- Every slot key MUST be a shape id that exists on that slide.\n" +
    "- Use ONLY these fill kinds, which is all the pipeline can produce: " +
    `${FILL_KIND_LIST.join(", ")}.\n` +
    "- Pick ONE slide for `day-heading`/`day-summary` and mark it repeat: \"per-day\". " +
    "That slide is duplicated once per active day, so put day-scoped content only there.\n" +
    "- Any OTHER slide that is a duplicate of the per-day layout MUST be listed in `omit`, " +
    "or it survives as an unfilled placeholder slide. Use `omit` only for duplicates of a " +
    "slide you already mapped; never for slides you simply chose not to map.\n" +
    "- Place a fill on the shape whose EXISTING text matches its purpose (a placeholder " +
    "like [Work item name], or a label like GITHUB EVIDENCE). Match by meaning and position.\n" +
    "- Respect size: put long content (summary, evidence) in the biggest suitable box.\n" +
    "- Prefer to under-fill rather than guess. If a slide has no sensible slot, omit it, " +
    "and list what you could not map in `notes`.\n" +
    "- Do not invent data sources. If the template asks for something the pipeline cannot " +
    "produce (pull-request numbers, assignees), omit it and note it.";
export function manifestPrompt(outline) {
    return (`${outlineToPrompt(outline)}\n\n` +
        `Return JSON: {"name":string,"source":string,"notes":[string],` +
        `"omit":[number],"steps":[{"slide":number,"repeat"?:"per-day","title"?:string,"slots":{<shapeId>:<fillKind>}}]}\n` +
        `"slots" maps a shape id to the fill kind that should be written into it. ` +
        `Order "steps" by slide number. Keep "notes" to what you could not map.`);
}
/** Ask a model to derive a manifest for a template it has only seen as an outline. */
export async function learnManifest(provider, outline, templatePath) {
    const manifest = await completeJson(provider, manifestPrompt(outline), {
        label: "learn-template",
        system: MANIFEST_SYSTEM,
        parse: parseManifest,
        maxTokens: 6000,
    });
    const withSource = { ...manifest, source: templatePath };
    return { manifest: withSource, issues: validateManifest(withSource, outline) };
}
