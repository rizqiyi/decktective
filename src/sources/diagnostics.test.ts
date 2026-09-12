/**
 * Repo-level diagnostics.
 *
 * These are the warnings that used to vanish: they were attached to day
 * entries, so an empty window produced a silent "0 commits" — the exact case
 * a truncated clone creates. Fast and offline; no git binary involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitSource } from "./git.ts";

async function tempDir(withShallow: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "decktective-diag-"));
  if (withShallow) {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "shallow"), "0000000000000000000000000000000000000000\n");
  }
  return dir;
}

test("a shallow clone is reported even when the window has no commits", async () => {
  const dir = await tempDir(true);
  try {
    const warnings = await new GitSource({ id: "t", path: dir }).diagnostics();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /shallow clone/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a complete clone reports nothing", async () => {
  const dir = await tempDir(false);
  try {
    assert.deepEqual(await new GitSource({ id: "t", path: dir }).diagnostics(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("whitespace suppression is reported only when the churn pass runs", async () => {
  const dir = await tempDir(false);
  try {
    const src = new GitSource({ id: "t", path: dir });
    // commitsOnly skips the numstat pass, so nothing was suppressed.
    assert.deepEqual(await src.diagnostics({ ignoreWhitespace: true, commitsOnly: true }), []);
    assert.deepEqual(await src.diagnostics({ ignoreWhitespace: true }), [
      "whitespace-only changes suppressed (-w)",
    ]);
    assert.deepEqual(await src.diagnostics(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing repository path is not reported as a shallow clone", async () => {
  const warnings = await new GitSource({ id: "t", path: "/nonexistent/decktective" }).diagnostics();
  assert.deepEqual(warnings, []);
});
