/**
 * Profile calibration: show how the day classifier actually behaves on a repo.
 *
 * `PROFILE_THRESHOLDS` in `src/sources/profile.ts` decides which day profile a
 * deck reports (`burst`, `heavy`, `drop`, `rename`, `scattered`, `steady`). Those
 * numbers shipped as estimates, and a threshold that never fires is a profile
 * nobody will ever see — or a label that swallows everything and stops meaning
 * anything.
 *
 * Run this against real repositories before trusting the labels:
 *
 *   node scripts/calibrate-profiles.mjs <repo> [--since 2025-01-01] [--tz Asia/Jakarta]
 *
 * It is read-only and offline: no model, no writes.
 */
import { GitSource } from "../src/sources/git.ts";
import { classify, PROFILE_THRESHOLDS as T } from "../src/sources/profile.ts";

const argv = process.argv.slice(2);
const repo = argv.find((a) => !a.startsWith("--"));
if (!repo) {
  console.error("usage: node scripts/calibrate-profiles.mjs <repo> [--since YYYY-MM-DD] [--tz Zone]");
  process.exit(2);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const tz = flag("tz", "Asia/Jakarta");
const since = `${flag("since", "2015-01-01")}T00:00:00+07:00`;
const until = `${flag("until", new Date().toISOString().slice(0, 10))}T23:59:59+07:00`;

const source = new GitSource({ id: "calibration", path: repo });
const days = await source.collect({ start: since, end: until, tz }, { exclude: [] });

if (days.length === 0) {
  console.error(`no commits in ${repo} between ${since} and ${until}`);
  process.exit(1);
}

const tally = new Map();
const rows = [];
for (const d of days) {
  const profile = classify(d.metrics);
  tally.set(profile, (tally.get(profile) ?? 0) + 1);
  rows.push({ date: d.date, m: d.metrics, profile });
}

console.log(`\n${repo} — ${days.length} active days, ${since.slice(0, 10)}..${until.slice(0, 10)} (${tz})\n`);
console.log("date        commits  gross  conc  maxShare  median  profile");
for (const r of rows.slice(-40)) {
  const m = r.m;
  console.log(
    `${r.date}  ${String(m.commits).padStart(4)}  ${String(m.grossChurn).padStart(6)}  `
    + `${String(Math.round(m.concentration)).padStart(4)}  ${m.maxCommitShare.toFixed(2).padStart(7)}  `
    + `${String(Math.round(m.medianCommitSize)).padStart(6)}  ${r.profile}`,
  );
}
if (rows.length > 40) console.log(`… ${rows.length - 40} earlier days omitted`);

const ALL = ["burst", "heavy", "drop", "rename", "scattered", "steady"];
console.log("\ndistribution:");
for (const p of ALL) {
  const n = tally.get(p) ?? 0;
  const pct = ((n / days.length) * 100).toFixed(0);
  const bar = "\u2588".repeat(Math.round((n / days.length) * 40));
  console.log(`  ${p.padEnd(10)} ${String(n).padStart(4)}  ${pct.padStart(3)}%  ${bar}`);
}

const dead = ALL.filter((p) => (tally.get(p) ?? 0) === 0);
if (dead.length > 0) {
  console.log(`\nnever fired: ${dead.join(", ")}`);
  console.log("  A profile that never fires is unreachable for this project. Either the");
  console.log("  threshold is wrong, or the profile does not apply here — decide which,");
  console.log("  and change it in src/sources/profile.ts (PROFILE_THRESHOLDS).");
}
const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
if (dominant && dominant[1] / days.length > 0.5) {
  console.log(`\ndominant: ${dominant[0]} at ${((dominant[1] / days.length) * 100).toFixed(0)}% —`);
  console.log("  a label that covers most days carries little information; consider");
  console.log("  raising its threshold so the remaining days stay distinguishable.");
}

console.log("\ncurrent thresholds:", JSON.stringify(T, null, 2));
