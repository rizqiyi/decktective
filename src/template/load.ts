/**
 * Template loading.
 *
 * The shipped template is the default; `--template <file>` overrides it. Both
 * go through the same validator, so a generated template gets the same
 * treatment as a hand-written one and cannot reach the renderer unchecked.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTemplate } from "./validate.ts";
import type { DeckTemplate } from "../ir/types.ts";

/** Repo root, derived from this module — not from the process cwd. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_TEMPLATE_PATH = join(PACKAGE_ROOT, "templates", "weekly.template.json");

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

async function readTemplateFile(path: string): Promise<DeckTemplate> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) throw new Error(`template not found: ${path}`);
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseTemplate(raw);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let cached: DeckTemplate | undefined;

/** The built-in template, parsed and validated once. */
export async function loadDefaultTemplate(): Promise<DeckTemplate> {
  cached ??= await readTemplateFile(DEFAULT_TEMPLATE_PATH);
  return cached;
}

/** Load a template from an explicit path, or the default when omitted. */
export async function loadTemplate(path?: string): Promise<DeckTemplate> {
  return path === undefined ? loadDefaultTemplate() : readTemplateFile(resolve(path));
}
