/**
 * Classifier contract: every profile reachable, precedence total, arithmetic
 * safe at zero. Pure — no repository, no git, no I/O.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classify, PROFILE_THRESHOLDS } from "./profile.ts";
import type { DayMetrics, DayProfile } from "../ir/types.ts";

const day = (input: {
  commits: number;
  additions?: number;
  deletions?: number;
  filesTouched?: number;
  medianCommitSize?: number;
  maxCommitShare?: number;
}): DayMetrics => {
  const additions = input.additions ?? 0;
  const deletions = input.deletions ?? 0;
  const filesTouched = input.filesTouched ?? 0;
  const grossChurn = additions + deletions;
  return {
    commits: input.commits,
    additions,
    deletions,
    filesTouched,
    grossChurn,
    netChurn: additions - deletions,
    concentration: grossChurn / Math.max(filesTouched, 1),
    medianCommitSize: input.medianCommitSize ?? 0,
    maxCommitShare: input.maxCommitShare ?? 0,
  };
};

const cases: Array<{ profile: DayProfile; metrics: DayMetrics }> = [
  { profile: "quiet", metrics: day({ commits: 0 }) },
  {
    profile: "heavy",
    metrics: day({
      commits: 2,
      additions: 700,
      deletions: 200,
      filesTouched: 6,
      medianCommitSize: 450,
      maxCommitShare: 0.5,
    }),
  },
  {
    profile: "drop",
    metrics: day({
      commits: 5,
      additions: 400,
      deletions: 200,
      filesTouched: 6,
      medianCommitSize: 120,
      maxCommitShare: 0.7,
    }),
  },
  {
    profile: "rename",
    metrics: day({
      commits: 5,
      additions: 150,
      deletions: 150,
      filesTouched: 6,
      medianCommitSize: 60,
      maxCommitShare: 0.3,
    }),
  },
  {
    profile: "burst",
    metrics: day({
      commits: 10,
      additions: 300,
      deletions: 100,
      filesTouched: 20,
      medianCommitSize: 40,
      maxCommitShare: 0.25,
    }),
  },
  {
    profile: "scattered",
    metrics: day({
      commits: 6,
      additions: 700,
      deletions: 200,
      filesTouched: 30,
      medianCommitSize: 150,
      maxCommitShare: 0.4,
    }),
  },
  {
    profile: "steady",
    metrics: day({
      commits: 4,
      additions: 60,
      deletions: 40,
      filesTouched: 3,
      medianCommitSize: 25,
      maxCommitShare: 0.5,
    }),
  },
];

for (const { profile, metrics } of cases) {
  test(`classify: ${profile}`, () => {
    assert.equal(classify(metrics), profile);
  });
}

test("precedence: heavy beats drop on an overlapping day", () => {
  const metrics = day({
    commits: 2,
    additions: 600,
    deletions: 300,
    filesTouched: 6,
    medianCommitSize: 450,
    maxCommitShare: 0.7,
  });
  // The fixture genuinely satisfies `drop` too; only order decides.
  assert.ok(metrics.maxCommitShare >= PROFILE_THRESHOLDS.dropMinShare);
  assert.ok(metrics.grossChurn > PROFILE_THRESHOLDS.dropMinGrossChurn);
  assert.equal(classify(metrics), "heavy");
});

test("zero inputs never divide by zero or throw", () => {
  const empty = day({ commits: 0 });
  assert.equal(empty.concentration, 0);
  assert.equal(empty.maxCommitShare, 0);
  assert.equal(classify(empty), "quiet");

  // Commits that touched nothing: grossChurn and filesTouched are both 0.
  const churnless = day({ commits: 4 });
  assert.equal(classify(churnless), "steady");

  for (const metrics of [empty, churnless]) {
    assert.ok(!Number.isNaN(metrics.concentration));
    assert.ok(!Number.isNaN(metrics.maxCommitShare));
    assert.ok(!Number.isNaN(metrics.grossChurn));
  }
});
