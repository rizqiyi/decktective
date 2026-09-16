/**
 * Git source adapter: a real repository becomes `DayEntry[]`.
 *
 * Two `git log` passes share one window/flags: names+dates, then churn via
 * `--numstat`. Both run with the deck's TZ pinned into the child env, so
 * `iso-strict-local` dates mean the deck's calendar, not the machine's.
 * Attribution buckets by AUTHOR date; a divergence from the committer date is
 * reported because it makes the bucket unreliable.
 *
 * `execFile` with an argv array (never a shell string) keeps dates, refs and
 * paths out of a shell's reach.
 */
import { classify } from "./profile.ts";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CollectOpts,
  DayEntry,
  DayItem,
  DayMetrics,
  IsoDate,
  ItemKind,
  SourceAdapter,
  Window,
} from "../ir/types.ts";

/** `CollectOpts` plus the revision this report covers. */
export type GitCollectOpts = CollectOpts & {
  /** Branch, tag or ref to walk. Defaults to the repository's HEAD. */
  branch?: string;
};

const FIELD_SEP = "\x1f";
/** Byte emitted by `%x1e` in the churn pass; never legal in a path or SHA. */
const RECORD_LEAD = 0x1e;
const RECORD_LEAD_CHAR = String.fromCharCode(RECORD_LEAD);
/**
 * Records are delimited by `%x1e` rather than newlines: `%b` is multi-line, so
 * a line-oriented parse would shred any commit that has a body.
 */
const NAME_FORMAT = "--pretty=format:%x1e%H%x1f%ad%x1f%cd%x1f%an%x1f%s%x1f%b";
const CHURN_FORMAT = "--pretty=format:%x1e%H";
const SUBJECT_PREFIX = /^([a-z]+)(?:\([^()]*\))?!?:\s+/;

const KIND_BY_PREFIX: Record<string, ItemKind> = {
  feat: "feat",
  fix: "fix",
  refactor: "refactor",
  chore: "chore",
  docs: "docs",
  test: "test",
  perf: "perf",
  build: "build",
  ci: "ci",
  style: "style",
  revert: "revert",
};

type RawCommit = {
  sha: string;
  author: string;
  /** Author date in the window TZ, `iso-strict-local`. */
  authorDate: string;
  /** Committer date in the window TZ, `iso-strict-local`. */
  committerDate: string;
  subject: string;
  /** Commit message body; often the only record of *why* a change happened. */
  body: string;
};

type Churn = {
  additions: number;
  deletions: number;
  /** Distinct post-exclusion paths touched by this commit. */
  paths: Set<string>;
  /** Exclude prefixes that removed a path from this commit. */
  excludedPrefixes: Set<string>;
};

type DayAgg = {
  date: IsoDate;
  commits: RawCommit[];
  additions: number;
  deletions: number;
  files: Set<string>;
  /** Gross churn per commit, for median and max. */
  commitSizes: number[];
  maxCommitSize: number;
  excludedPrefixes: Set<string>;
  warnings: string[];
};

export class GitSource implements SourceAdapter {
  readonly id: string;
  readonly kind: "git" = "git";
  readonly path: string;

  constructor(config: { id: string; path: string }) {
    this.id = config.id;
    this.path = config.path;
  }

  async collect(window: Window, opts?: GitCollectOpts): Promise<DayEntry[]> {
    const exclude = opts?.exclude ?? [];
    const branch = opts?.branch;
    if (branch !== undefined) await this.assertRef(branch);
    // Density probes only count commits; the churn pass is the expensive half.
    const commitsOnly = opts?.commitsOnly === true;

    const flags = [`--since=${window.start}`, `--until=${window.end}`];
    if (opts?.includeMerges !== true) flags.push("--no-merges");
    const all = opts?.all === true;
    if (all) {
      // --first-parent is meaningless across many refs, and with --no-merges it
      // would hide exactly the merge-only work --all exists to surface.
      flags.push("--all");
    } else {
      // A weekly report covers one line of history, not everything merged in.
      flags.push("--first-parent");
    }
    const revision = all || branch === undefined ? [] : [branch];

    const churnFlags = [...flags];
    if (opts?.detectRenames === true) churnFlags.push("-M");
    if (opts?.ignoreWhitespace === true) churnFlags.push("-w");

    const [nameOut, churnOut] = await Promise.all([
      this.git(
        ["log", ...flags, "--date=iso-strict-local", NAME_FORMAT, ...revision],
        window.tz,
      ),
      commitsOnly
        ? Promise.resolve<string | undefined>(undefined)
        : this.git(
            ["log", ...churnFlags, "--numstat", CHURN_FORMAT, ...revision],
            window.tz,
          ),
    ]);

    const commits = parseCommits(nameOut);
    const churnBySha =
      churnOut === undefined ? undefined : parseChurn(churnOut, exclude);

    const days = new Map<IsoDate, DayAgg>();
    for (const commit of commits) {
      const date = commit.authorDate.slice(0, 10);
      let agg = days.get(date);
      if (agg === undefined) {
        agg = {
          date,
          commits: [],
          additions: 0,
          deletions: 0,
          files: new Set(),
          commitSizes: [],
          maxCommitSize: 0,
          excludedPrefixes: new Set(),
          warnings: [],
        };
        days.set(date, agg);
      }
      agg.commits.push(commit);

      const churn = churnBySha?.get(commit.sha);
      const size = churn === undefined ? 0 : churn.additions + churn.deletions;
      agg.commitSizes.push(size);
      if (size > agg.maxCommitSize) agg.maxCommitSize = size;
      if (churn !== undefined) {
        agg.additions += churn.additions;
        agg.deletions += churn.deletions;
        for (const path of churn.paths) agg.files.add(path);
        for (const prefix of churn.excludedPrefixes) agg.excludedPrefixes.add(prefix);
      }

      if (commit.authorDate.slice(0, 10) !== commit.committerDate.slice(0, 10)) {
        agg.warnings.push(
          `commit ${commit.sha.slice(0, 7)} by ${commit.author}: author date ${commit.authorDate} and committer date ${commit.committerDate} fall on different days`,
        );
      }
    }

    const entries: DayEntry[] = [];
    for (const agg of days.values()) {
      const grossChurn = agg.additions + agg.deletions;
      const filesTouched = agg.files.size;
      const metrics: DayMetrics = {
        commits: agg.commits.length,
        additions: agg.additions,
        deletions: agg.deletions,
        filesTouched,
        grossChurn,
        netChurn: agg.additions - agg.deletions,
        concentration: grossChurn / Math.max(filesTouched, 1),
        medianCommitSize: median(agg.commitSizes),
        maxCommitShare: grossChurn === 0 ? 0 : agg.maxCommitSize / grossChurn,
      };

      const warnings = [...agg.warnings];
      if (agg.excludedPrefixes.size > 0) {
        warnings.push(
          `excluded paths matching: ${[...agg.excludedPrefixes].sort().join(", ")}`,
        );
      }

      const items: DayItem[] = agg.commits.map((commit) => {
        const churn = churnBySha?.get(commit.sha);
        const parsed = parseSubject(commit.subject);
        const item: DayItem = {
          text: parsed.text,
          kind: parsed.kind,
          refs: [commit.sha],
        };
        // Absent churn fields mean "not measured", not "measured zero".
        if (churn !== undefined) {
          item.additions = churn.additions;
          item.deletions = churn.deletions;
          item.files = churn.paths.size;
        }
        // Bodies can be long trailers ("Signed-off-by", "Co-authored-by");
        // keep the prose, drop the bookkeeping, and cap what we carry.
        if (commit.body !== "") item.body = cleanBody(commit.body);
        return item;
      });

      const entry: DayEntry = {
        date: agg.date,
        sourceId: this.id,
        source: "git",
        items,
        metrics,
      };
      // Only classify when churn was actually measured: under `commitsOnly` the
      // churn fields are "not measured", and a profile derived from zeros would
      // be a lie (every churnless day would read as `burst`).
      if (churnBySha !== undefined) entry.profile = classify(metrics);
      if (warnings.length > 0) entry.warnings = warnings;
      entries.push(entry);
    }

    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return entries;
  }

  private async git(args: string[], tz: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.path,
          env: { ...process.env, TZ: tz },
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new Error(
                `git ${args[0] ?? "log"} failed in ${this.path}: ${stderr.trim() || error.message}`,
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /**
   * Repo-level warnings, independent of any window. Cheap: no history walk.
   */
  async diagnostics(opts?: CollectOpts): Promise<string[]> {
    const out: string[] = [];
    if (await this.isShallow()) {
      out.push("shallow clone: history before the graft point is unavailable");
    }
    // Nothing was suppressed if the churn pass never ran.
    if (!opts?.commitsOnly && opts?.ignoreWhitespace === true) {
      out.push("whitespace-only changes suppressed (-w)");
    }
    return out;
  }

  /**
   * Fail early with the available refs.
   *
   * `git log <typo>` reports "unknown revision or path not in the working tree",
   * which reads like a missing checkout rather than a bad branch name.
   */
  private async assertRef(ref: string): Promise<void> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], "UTC");
      return;
    } catch {
      // fall through to the listing below
    }
    let available = "";
    try {
      const out = await this.git(["branch", "-a", "--format=%(refname:short)"], "UTC");
      available = out.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(0, 20).join(", ");
    } catch {
      available = "(could not list branches)";
    }
    throw new Error(
      `--branch ${JSON.stringify(ref)} is not a branch, tag or ref in this repository` +
      (available === "" ? "" : `\n  available: ${available}`),
    );
  }

  private async isShallow(): Promise<boolean> {
    try {
      return (await stat(join(this.path, ".git", "shallow"))).isFile();
    } catch {
      return false;
    }
  }
}

function parseCommits(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  // Split records first; only then split fields, so a multi-line body survives.
  for (const record of out.split(RECORD_LEAD_CHAR)) {
    const trimmed = record.replace(/^\n/, "");
    if (trimmed.trim() === "") continue;
    const fields = trimmed.split(FIELD_SEP);
    const sha = fields[0];
    const authorDate = fields[1];
    const committerDate = fields[2];
    if (!sha || !authorDate || !committerDate) continue;
    commits.push({
      sha,
      author: fields[3] ?? "",
      authorDate,
      committerDate,
      subject: fields[4] ?? "",
      // The body is last: rejoin so a separator inside it is preserved.
      body: fields.slice(5).join(FIELD_SEP).trim(),
    });
  }
  return commits;
}

/**
 * Parse `--numstat` output into per-SHA churn. Binary entries (`-`) are
 * dropped; paths matching an `exclude` prefix are dropped and their prefix
 * remembered so the day can report the suppression.
 */
function parseChurn(out: string, exclude: readonly string[]): Map<string, Churn> {
  const bySha = new Map<string, Churn>();
  let current: Churn | undefined;
  for (const raw of out.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    const tab1 = line.indexOf("\t");
    if (tab1 === -1) {
      // Header line: the SHA, optionally led by the record separator.
      const sha = line.charCodeAt(0) === RECORD_LEAD ? line.slice(1) : line;
      current = {
        additions: 0,
        deletions: 0,
        paths: new Set(),
        excludedPrefixes: new Set(),
      };
      bySha.set(sha, current);
      continue;
    }
    if (current === undefined) continue;
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;
    const added = line.slice(0, tab1);
    const deleted = line.slice(tab1 + 1, tab2);
    if (added === "-" || deleted === "-") continue;
    const additions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(deleted, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;

    const variants = numstatPaths(line.slice(tab2 + 1));
    const excludedPrefix = matchingPrefix(variants, exclude);
    if (excludedPrefix !== undefined) {
      current.excludedPrefixes.add(excludedPrefix);
      continue;
    }
    current.additions += additions;
    current.deletions += deletions;
    current.paths.add(variants[variants.length - 1] ?? "");
  }
  return bySha;
}

/** Literal paths a numstat entry names; renames (`a => b`, `d/{a => b}/f`) yield both sides. */
function numstatPaths(path: string): string[] {
  if (!path.includes(" => ")) return [path];
  const open = path.indexOf("{");
  const close = path.lastIndexOf("}");
  if (open !== -1 && close > open) {
    const before = path.slice(0, open);
    const after = path.slice(close + 1);
    const [oldName = "", newName = ""] = path.slice(open + 1, close).split(" => ");
    return [
      before + oldName.trim() + after,
      before + newName.trim() + after,
    ];
  }
  const [oldName = "", newName = ""] = path.split(" => ");
  return [oldName, newName];
}

function matchingPrefix(
  paths: readonly string[],
  prefixes: readonly string[],
): string | undefined {
  for (const prefix of prefixes) {
    for (const path of paths) {
      if (path.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}

/** Drop trailer lines and cap length; a body is evidence, not an essay. */
function cleanBody(body: string): string {
  const kept = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[A-Za-z-]+:\s/.test(l));
  return kept.join(" ").slice(0, 1200);
}

function parseSubject(subject: string): { kind: ItemKind; text: string } {
  const match = SUBJECT_PREFIX.exec(subject);
  const kind = match === null ? undefined : KIND_BY_PREFIX[match[1] ?? ""];
  if (match === null || kind === undefined) {
    return { kind: "other", text: capitalize(subject) };
  }
  const body = subject.slice(match[0].length);
  return { kind, text: capitalize(body.length > 0 ? body : subject) };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
