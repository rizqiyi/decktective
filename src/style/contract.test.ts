/**
 * Style contract resolution.
 *
 * The contract is consumed from its own package, so the loader must be
 * predictable about where it reads from and honest when it cannot read at all —
 * a silently missing contract would mean the review gate stops enforcing
 * anything while still reporting success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStyleContract, stripFrontmatter, INSTALLED_SKILL_PATH, STYLE_SKILL_NAME,
} from "./contract.ts";

test("frontmatter is stripped, body is kept verbatim", () => {
  const md = "---\nname: x\ndescription: y\n---\n\n# Body\n\nRule one.\n";
  const body = stripFrontmatter(md);
  assert.ok(!body.includes("description: y"));
  assert.ok(body.startsWith("# Body"));
  assert.ok(body.includes("Rule one."));
});

test("markdown without frontmatter is returned unchanged", () => {
  assert.equal(stripFrontmatter("# Just a heading\n"), "# Just a heading\n");
});

test("frontmatter-only input yields an empty body rather than a stray header", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\n").trim(), "");
});

test("an explicit path wins over the installed skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decktective-style-"));
  try {
    const path = join(dir, "custom.SKILL.md");
    await writeFile(path, "---\nname: custom\n---\n\nCUSTOM CONTRACT BODY\n");
    const contract = await loadStyleContract({ path });
    assert.equal(contract.source, path);
    assert.match(contract.text, /CUSTOM CONTRACT BODY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the installed skill is used when no explicit path is given", async () => {
  // Present in this repo by design; the CLI installs it via --install-style.
  const contract = await loadStyleContract();
  assert.equal(contract.name, STYLE_SKILL_NAME);
  assert.ok(contract.text.length > 500, "contract body should be substantial");
  assert.ok(contract.source === INSTALLED_SKILL_PATH || contract.source.includes("cached"),
    `unexpected source: ${contract.source}`);
});

test("offline with only a cache present still resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decktective-style-cache-"));
  try {
    const cacheFile = join(dir, "style", `${STYLE_SKILL_NAME}.SKILL.md`);
    await mkdir(join(dir, "style"), { recursive: true });
    await writeFile(cacheFile, "CACHED BODY\n");
    const contract = await loadStyleContract({ path: cacheFile, offline: true });
    assert.match(contract.text, /CACHED BODY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing explicit path fails loudly instead of silently passing", async () => {
  await assert.rejects(
    () => loadStyleContract({ path: "/nonexistent/SKILL.md" }),
    /ENOENT|no such file/i,
  );
});
