/**
 * The output-style contract, consumed from its own package.
 *
 * https://github.com/ayghri/i-have-adhd is a skill that shapes output for a
 * reader with ADHD. It is *used*, not reimplemented: this module resolves the
 * package's own `SKILL.md` and hands the text to the reviewer verbatim. Its
 * rules are edited upstream, so a local paraphrase would drift and silently
 * start enforcing a spec nobody maintains.
 *
 * Resolution order, first hit wins:
 *   1. an explicit path or URL (`--style`)
 *   2. the skill as installed for the harness at `.omp/skills/<name>/SKILL.md`
 *   3. upstream, cached on disk so a run stays reproducible offline
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STYLE_SKILL_NAME = "i-have-adhd";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The skill as shipped in this package's `skills/` directory — the same path omp
 * discovers as the extension's sibling skill root, so the CLI and the harness
 * read one copy rather than two that can drift.
 */
export const INSTALLED_SKILL_PATH = join(
  PACKAGE_ROOT, "skills", STYLE_SKILL_NAME, "SKILL.md",
);

export const UPSTREAM_SKILL_URL =
  `https://raw.githubusercontent.com/ayghri/${STYLE_SKILL_NAME}/main/skills/${STYLE_SKILL_NAME}/SKILL.md`;

export type StyleContract = {
  name: string;
  /** The skill body, frontmatter stripped. Verbatim upstream text. */
  text: string;
  /** Where it came from, so a run's style rules are traceable. */
  source: string;
};

/** Drop YAML frontmatter; it configures the harness, it is not instruction. */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after < 0 ? "" : markdown.slice(after + 1).trim();
}

const isUrl = (s: string): boolean => s.startsWith("http://") || s.startsWith("https://");

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot fetch style contract from ${url}: HTTP ${res.status}`);
  return res.text();
}

export type StyleContractOptions = {
  /** Explicit path or URL to a SKILL.md. */
  path?: string;
  /** Where to cache an upstream fetch. Defaults to the decktective cache dir. */
  cacheDir?: string;
  /** Disable network entirely; fail if nothing is available locally. */
  offline?: boolean;
};

export async function loadStyleContract(
  opts: StyleContractOptions = {},
): Promise<StyleContract> {
  const cacheDir = opts.cacheDir ?? join(homedir(), ".cache", "decktective");
  const cache = join(cacheDir, "style", `${STYLE_SKILL_NAME}.SKILL.md`);

  if (opts.path !== undefined) {
    const raw = isUrl(opts.path) ? await fetchText(opts.path) : await readFile(opts.path, "utf8");
    return { name: STYLE_SKILL_NAME, text: stripFrontmatter(raw), source: opts.path };
  }

  const installed = await readFileOrNull(INSTALLED_SKILL_PATH);
  if (installed !== null) {
    return { name: STYLE_SKILL_NAME, text: stripFrontmatter(installed), source: INSTALLED_SKILL_PATH };
  }

  const cached = await readFileOrNull(cache);
  if (cached !== null) {
    return { name: STYLE_SKILL_NAME, text: stripFrontmatter(cached), source: `${cache} (cached)` };
  }
  if (opts.offline === true) {
    throw new Error(
      "no style contract available offline: install it with `node src/cli.ts --install-style`, " +
      "or pass --style <path>",
    );
  }

  const fetched = await fetchText(UPSTREAM_SKILL_URL);
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, fetched, "utf8");
  return { name: STYLE_SKILL_NAME, text: stripFrontmatter(fetched), source: UPSTREAM_SKILL_URL };
}

/** Fetch the package's skill into `.omp/skills/` so the harness discovers it. */
export async function installStyleSkill(): Promise<string> {
  const raw = await fetchText(UPSTREAM_SKILL_URL);
  await mkdir(dirname(INSTALLED_SKILL_PATH), { recursive: true });
  await writeFile(INSTALLED_SKILL_PATH, raw, "utf8");
  return INSTALLED_SKILL_PATH;
}
