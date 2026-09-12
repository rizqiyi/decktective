/**
 * TemplateNarrative: the deterministic, offline NarrativeEngine.
 *
 * Every number it emits is computed from the facts it was handed. It never
 * invents prose facts, never calls a model, and is byte-reproducible — which
 * is why tests and CI use it. The LLM engine is an optimization, not a
 * requirement.
 */
import type {
  DayEntry, DayItem, DayNarrative, Narrative,
  NarrativeEngine, ThemeCluster, Window,
} from "../ir/types.ts";

const KIND_LABEL: Record<string, string> = {
  feat: "Features",
  fix: "Fixes",
  refactor: "Refactors",
  chore: "Chores",
  docs: "Docs",
  test: "Tests",
  perf: "Performance",
  build: "Build",
  ci: "CI",
  style: "Style",
  revert: "Reverts",
  other: "Other",
};

const KIND_ORDER: string[] = [
  "feat", "fix", "perf", "refactor", "test", "docs", "build", "ci", "chore", "style", "revert", "other",
];

/**
 * `1 commit` / `3 commits`. Exported so the deck builder and the narrative
 * agree — "1 commits" in a shipped deck is a visible defect.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function dedupe(items: DayItem[]): DayItem[] {
  const seen = new Set<string>();
  const out: DayItem[] = [];
  for (const it of items) {
    const key = it.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function headlineFor(day: DayEntry): string {
  if (day.items.length === 0) return "No recorded activity";
  const top = [...day.items].sort(
    (a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)),
  )[0];
  const n = day.metrics.commits;
  const kinds = new Set(day.items.map((i) => i.kind));
  const shape = kinds.size === 1 ? [...kinds][0] : "mixed";
  const base = top ? top.text : "Work in progress";
  return n === 1 ? `${base}` : `${n} commits, ${shape} work — ${base}`;
}

function clusterThemes(days: DayEntry[]): ThemeCluster[] {
  const byKind = new Map<string, Set<string>>();
  for (const day of days) {
    for (const item of day.items) {
      const set = byKind.get(item.kind) ?? new Set<string>();
      for (const ref of item.refs ?? []) set.add(ref);
      byKind.set(item.kind, set);
    }
  }
  return KIND_ORDER
    .filter((k) => (byKind.get(k)?.size ?? 0) > 0)
    .map((k) => ({ title: KIND_LABEL[k] ?? k, refs: [...(byKind.get(k) ?? [])] }));
}

function risksFor(days: DayEntry[]): string[] {
  const out: string[] = [];
  const warned = days.filter((d) => (d.warnings?.length ?? 0) > 0);
  if (warned.length > 0) {
    out.push(`Attribution may be unreliable on ${plural(warned.length, "day")} — see per-day warnings.`);
  }
  const dominated = days.filter((d) => (d.profile ?? "steady") === "drop");
  if (dominated.length > 0) {
    out.push(`${plural(dominated.length, "day")} dominated by a single commit; detail may be hidden.`);
  }
  const other = days.flatMap((d) => d.items).filter((i) => i.kind === "other");
  if (other.length > 0) {
    out.push(`${plural(other.length, "commit")} did not follow a conventional-commit prefix.`);
  }
  const quiet = days.filter((d) => (d.profile ?? "steady") === "quiet");
  if (quiet.length > 0) out.push(`${plural(quiet.length, "day")} with no recorded activity.`);
  return out;
}

function summaryFor(days: DayEntry[], window: Window): string {
  const commits = days.reduce((a, d) => a + d.metrics.commits, 0);
  const gross = days.reduce((a, d) => a + d.metrics.grossChurn, 0);
  const added = days.reduce((a, d) => a + d.metrics.additions, 0);
  const removed = days.reduce((a, d) => a + d.metrics.deletions, 0);
  const active = days.filter((d) => d.metrics.commits > 0).length;
  if (commits === 0) {
    return `No commits recorded between ${window.start} and ${window.end} (${window.tz}).`;
  }
  const removedLabel = removed === 0 ? "0" : `-${removed.toLocaleString("en-US")}`;
  return (
    `${commits.toLocaleString("en-US")} commits across ${active} active day(s): ` +
    `+${added.toLocaleString("en-US")} / ${removedLabel} (gross churn ${gross.toLocaleString("en-US")}).`
  );
}

/** Honest next-week candidates: unfinished-looking work only. */
function nextWeekFor(days: DayEntry[]): string[] {
  const out: string[] = [];
  const reverts = days.flatMap((d) => d.items).filter((i) => i.kind === "revert");
  if (reverts.length > 0) out.push(`Revisit ${reverts.length} reverted change(s).`);
  const chores = days.flatMap((d) => d.items).filter((i) => i.kind === "chore");
  if (chores.length > 0) out.push(`Follow up on ${chores.length} chore commit(s).`);
  return out;
}

export class TemplateNarrative implements NarrativeEngine {
  async narrate(facts: DayEntry[], window: Window): Promise<Narrative> {
    const sorted = [...facts].sort((a, b) => a.date.localeCompare(b.date));
    // Drop days with no activity from the narrated set: the deck shows work, not calendar padding.
    const active = sorted.filter((d) => d.metrics.commits > 0 || d.items.length > 0);

    const days: DayNarrative[] = active.map((d) => ({
      date: d.date,
      headline: headlineFor(d),
      items: dedupe(d.items),
      profile: d.profile ?? "steady",
      metrics: d.metrics,
    }));

    return {
      days,
      themes: clusterThemes(active),
      summary: summaryFor(active, window),
      risks: risksFor(active),
      nextWeek: nextWeekFor(active),
    };
  }
}


