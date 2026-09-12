/**
 * Grouping commits into work items.
 *
 * The semantic step — "these four commits are all the sidebar redesign" — is
 * where a model earns its place, because commit subjects alone do not reveal
 * it. But the model is only allowed to decide GROUPING and NAMING. Every
 * aggregate (churn, files, days, repos, impact) is computed here from the
 * referenced commits, so a model cannot inflate or invent a number, and a
 * fabricated SHA is dropped rather than rendered.
 */
import type {
  DayEntry, DayItem, IsoDate, ItemKind, WorkItem, WorkItemDraft,
  WorkItemImpact, WorkItemStatus,
} from "../ir/types.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { completeJson } from "../llm/json.ts";

const KINDS: ItemKind[] = [
  "feat", "fix", "refactor", "chore", "docs", "test", "perf",
  "build", "ci", "style", "revert", "other",
];

const STATUSES: WorkItemStatus[] = ["Done", "In progress", "Blocked"];

/** A commit as the grouping stage sees it. */
type Fact = {
  sha: string;
  date: IsoDate;
  sourceId: string;
  text: string;
  /** Commit message body — the raw material for an articulated summary. */
  body: string;
  kind: ItemKind;
  additions: number;
  deletions: number;
  files: number;
};

/** Flatten days into per-commit facts, keeping only commits that carry a SHA. */
export function factsOf(days: DayEntry[]): Fact[] {
  const out: Fact[] = [];
  for (const day of days) {
    for (const item of day.items) {
      for (const sha of item.refs ?? []) {
        out.push({
          sha,
          date: day.date,
          sourceId: day.sourceId,
          text: item.text,
          body: item.body ?? "",
          kind: item.kind,
          additions: item.additions ?? 0,
          deletions: item.deletions ?? 0,
          files: item.files ?? 0,
        });
      }
    }
  }
  return out;
}

/** Magnitude class, computed from churn so the badge is earned. */
function impactOf(additions: number, deletions: number): WorkItemImpact {
  const churn = additions + deletions;
  if (churn >= 800) return "Major";
  if (churn >= 150) return "Medium";
  return "Small";
}

function firstWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ");
}

/**
 * Deterministic fallback: group a day's commits by kind.
 *
 * Crude, but honest and reproducible — and it keeps the tool usable with no
 * model configured, which matters for CI and for anyone who does not want
 * their source leaving the machine.
 */
export function groupDeterministic(days: DayEntry[]): WorkItemDraft[] {
  const drafts: WorkItemDraft[] = [];
  for (const day of days) {
    const byKind = new Map<ItemKind, DayItem[]>();
    for (const item of day.items) {
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
    }
    for (const [kind, items] of byKind) {
      const heaviest = [...items].sort(
        (a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)),
      )[0];
      if (!heaviest) continue;
      const refs = items.flatMap((i) => i.refs ?? []);
      if (refs.length === 0) continue;
      drafts.push({
        title: items.length === 1 ? heaviest.text : `${firstWords(heaviest.text, 7)} (+${items.length - 1} more)`,
        type: kind,
        refs,
      });
    }
  }
  return drafts;
}

const GROUP_SYSTEM =
  "You group a week of git commits into coherent WORK ITEMS — the pieces of work " +
  "a person would describe in a standup (\"the sidebar redesign\", \"fix canvas saving\"). " +
  "Commits that are part of one effort belong together even if their messages differ; " +
  "commits with similar messages may still be separate efforts. Prefer 1-2 items per day, " +
  "and never more than 12 items for a week.\n\n" +
  "For each item, write a `summary`: one or two sentences saying what actually changed " +
  "and why it mattered, in plain language a non-author understands. Base it ONLY on the " +
  "commit subjects and bodies given. Where a body explains the motivation, use it; where " +
  "it does not, describe the change without inventing a rationale. Never state a number, " +
  "date, duration or percentage.\n\n" +
  "You choose grouping, titles, types and summaries only. Every count is computed for you.";

/**
 * Bodies are trimmed for the prompt. They carry the rationale we want, but a
 * full body per commit multiplies the reasoning budget for little extra signal —
 * the opening lines say what changed and why; the tail is usually detail.
 */
const BODY_PROMPT_MAX = 400;

function groupPrompt(facts: Fact[], window: { start: string; end: string }): string {
  const lines = facts.map((f) => {
    const head = `${f.sha.slice(0, 10)} | ${f.date} | ${f.sourceId} | ${f.kind} | +${f.additions}/-${f.deletions} | ${f.text}`;
    if (f.body === "") return head;
    const body = f.body.length > BODY_PROMPT_MAX
      ? `${f.body.slice(0, BODY_PROMPT_MAX)}\u2026`
      : f.body;
    return `${head}\n    body: ${body}`;
  });
  return (
    `Window: ${window.start} .. ${window.end}\n` +
    `Commits (sha | date | repo | kind | churn | subject):\n${lines.join("\n")}\n\n` +
    `Return JSON: {"items":[{"title":string,"type":"${KINDS.join("|")}",` +
    `"refs":[string],"summary":string,"status":"${STATUSES.join("|")}"}]}\n` +
    `Rules: every "refs" entry MUST be a sha from the list above. Every commit above must ` +
    `appear in exactly one item. "title" is at most 60 characters. "summary" is one short ` +
    `sentence describing what changed. Do not state any number in title or summary.`
  );
}

type RawDraft = { title?: unknown; type?: unknown; refs?: unknown; summary?: unknown; status?: unknown };

/** Validate one draft against the facts it claims to describe. */
export function parseDrafts(raw: unknown): WorkItemDraft[] {
  if (typeof raw !== "object" || raw === null || !("items" in raw)) {
    throw new Error('expected an object with an "items" array');
  }
  const items = raw.items;
  if (!Array.isArray(items)) throw new Error('"items" must be an array');

  const out: WorkItemDraft[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const d = entry as RawDraft;
    if (typeof d.title !== "string" || d.title.trim() === "") continue;
    if (!Array.isArray(d.refs) || d.refs.length === 0) continue;
    const refs = d.refs.filter((r): r is string => typeof r === "string" && r !== "");
    if (refs.length === 0) continue;
    const type = typeof d.type === "string" && (KINDS as string[]).includes(d.type)
      ? (d.type as ItemKind)
      : "other";
    const status = typeof d.status === "string" && (STATUSES as string[]).includes(d.status)
      ? (d.status as WorkItemStatus)
      : undefined;
    out.push({
      title: d.title.trim().slice(0, 120),
      type,
      refs,
      ...(typeof d.summary === "string" && d.summary.trim() !== ""
        ? { summary: d.summary.trim().slice(0, 300) }
        : {}),
      ...(status === undefined ? {} : { status }),
    });
  }
  if (out.length === 0) throw new Error("no usable work items in response");
  return out;
}

export type GroupOutcome = {
  items: WorkItem[];
  /** Commits the model never assigned; folded into a catch-all item. */
  unassigned: string[];
  /** SHAs the model invented; discarded, never rendered. */
  fabricated: string[];
};

/**
 * Turn drafts into work items, computing every aggregate from the facts.
 *
 * Guarantees: no fabricated SHA survives, no commit disappears from the report,
 * and no number originates from the model.
 */
export function materialize(drafts: WorkItemDraft[], facts: Fact[]): GroupOutcome {
  const bySha = new Map(facts.map((f) => [f.sha, f]));
  const claimed = new Set<string>();
  const fabricated: string[] = [];
  const items: WorkItem[] = [];

  for (const draft of drafts) {
    const refs: string[] = [];
    for (const sha of draft.refs) {
      const fact = bySha.get(sha);
      if (!fact) {
        // Accept abbreviated SHAs the model may echo back, but never an unknown one.
        const match = facts.find((f) => f.sha.startsWith(sha) || sha.startsWith(f.sha.slice(0, 7)));
        if (match) {
          if (!claimed.has(match.sha)) {
            refs.push(match.sha);
            claimed.add(match.sha);
          }
        } else if (!fabricated.includes(sha)) {
          fabricated.push(sha);
        }
        continue;
      }
      if (!claimed.has(sha)) {
        refs.push(sha);
        claimed.add(sha);
      }
    }
    if (refs.length === 0) continue;
    items.push(buildItem(draft, refs, bySha));
  }

  const unassigned = facts.filter((f) => !claimed.has(f.sha)).map((f) => f.sha);
  if (unassigned.length > 0) {
    // Never silently drop work: unattributed commits get their own item.
    items.push(buildItem(
      { title: "Other changes", type: "other", refs: unassigned },
      unassigned,
      bySha,
    ));
  }

  return { items, unassigned, fabricated };
}

function buildItem(draft: WorkItemDraft, refs: string[], bySha: Map<string, Fact>): WorkItem {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  const days = new Set<IsoDate>();
  const repos = new Set<string>();
  const kinds = new Map<ItemKind, number>();

  for (const sha of refs) {
    const f = bySha.get(sha);
    if (!f) continue;
    additions += f.additions;
    deletions += f.deletions;
    files += f.files;
    days.add(f.date);
    repos.add(f.sourceId);
    kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  }

  const dominant = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? draft.type;

  return {
    id: refs[0]?.slice(0, 10) ?? "item",
    title: draft.title,
    type: draft.type === "other" && dominant !== "other" ? dominant : draft.type,
    repos: [...repos].sort(),
    refs: [...refs],
    days: [...days].sort(),
    additions,
    deletions,
    files,
    impact: impactOf(additions, deletions),
    status: draft.status ?? "Done",
    ...(draft.summary === undefined ? {} : { summary: draft.summary }),
  };
}

export type GroupOptions = {
  provider: LlmProvider;
  window: { start: string; end: string };
};

/** Group with the model when one is configured, else deterministically. */
export async function groupWorkItems(
  days: DayEntry[],
  opts: GroupOptions,
): Promise<GroupOutcome & { usedModel: boolean }> {
  const facts = factsOf(days);
  if (facts.length === 0) return { items: [], unassigned: [], fabricated: [], usedModel: false };

  if (opts.provider.id === "offline") {
    return { ...materialize(groupDeterministic(days), facts), usedModel: false };
  }

  const drafts = await completeJson(opts.provider, groupPrompt(facts, opts.window), {
    label: "group-work-items",
    system: GROUP_SYSTEM,
    parse: parseDrafts,
    // Reasoning tokens bill against this budget, and the prompt now carries
    // commit bodies; too small a budget ends the call with finish_reason
    // "length" and no content at all.
    maxTokens: 8000,
  });
  return { ...materialize(drafts, facts), usedModel: true };
}

