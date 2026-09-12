/**
 * Template loading.
 *
 * The shipped template is the default; `--template <file>` overrides it. Both
 * go through the same validator, so a generated template gets the same
 * treatment as a hand-written one and cannot reach the renderer unchecked.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findPackageRoot } from "../package-root.js";
import { parseTemplate } from "./validate.js";
/** Package root, derived from this module — not from the process cwd. */
const PACKAGE_ROOT = findPackageRoot();
export const DEFAULT_TEMPLATE_PATH = join(PACKAGE_ROOT, "templates", "weekly.template.json");
function isMissing(err) {
    return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
async function readTemplateFile(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (err) {
        if (isMissing(err))
            throw new Error(`template not found: ${path}`);
        throw err;
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (err) {
        throw new Error(`${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        return parseTemplate(raw);
    }
    catch (err) {
        throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
let cached;
/** The built-in template, parsed and validated once. */
export async function loadDefaultTemplate() {
    cached ??= await readTemplateFile(DEFAULT_TEMPLATE_PATH);
    return cached;
}
/** Load a template from an explicit path, or the default when omitted. */
export async function loadTemplate(path) {
    return path === undefined ? loadDefaultTemplate() : readTemplateFile(resolve(path));
}
