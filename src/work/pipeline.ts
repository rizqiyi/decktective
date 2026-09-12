/**
 * The decktective pipeline.
 *
 *   fetch -> normalize -> group into work items -> analyze -> articulate
 *         -> review & validate -> (retry from normalize) -> build report
 *
 * Every model-touching stage is optional: with no provider, or with `--offline`,
 * each stage takes its deterministic path and the whole run is reproducible.
 *
 * The review gate has two halves and they are deliberately different in kind:
 * style is a judgement, judged against the upstream `i-have-adhd` contract text;
 * facts are immutable, verified in code. A failed review is a normal outcome
 * that triggers a bounded retry, never an error and never an infinite loop.
 */
import type { DayEntry, Narrative, Window, WorkItem } from "../ir/types.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { LlmError } from "../llm/provider.ts";
import { completeJson } from "../llm/json.ts";
import { TemplateNarrative } from "../narrative/template.ts";
import { groupWorkItems, type GroupOutcome } from "./workitems.ts";
import { reviewDraft, type Draft, type Violation } from "./review.ts";
import type { StyleContract } from "../style/contract.ts";

/** Bounded retries: a loop that cannot terminate is worse than a style miss. */
export const MAX_ATTEMPTS = 3;

export type Articulation = Draft;

/** Visible list cap. The contract states it; this only bounds our own prompt. */
export const LIST_CAP = 5;

export type PipelineResult = {
  workItems: WorkItem[];
  narrative: Narrative;
  articulation: Articulation;
  attempts: number;
  usedModel: boolean;
  /** Contract violations that survived the final attempt. Empty means aligned. */
  violations: Violation[];
  /** SHAs a model produced that do not exist in the facts; discarded. */
  fabricatedRefs: string[];
  history: Array<{ attempt: number; violations: Violation[] }>;
  /** Which contract text was enforced, and where it came from. */
  styleSource?: string;
  /** Set when the model path failed and a deterministic fallback was used. */
  degraded?: string;
  /** Set when the gate could not run at all (offline, or no contract). */
  reviewSkipped?: string;
};

const providerLabel = (p: LlmProvider): string => `${p.id}/${p.model}`;

/** Deterministic prose, used offline and as the seed when the model path dies. */
function articulationsFrom(narrative: Narrative, workItems: WorkItem[]): Articulation {
  const ranked = [...workItems].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  return {
    summary: narrative.summary,
    highlights: ranked.slice(0, LIST_CAP).map((w) => w.title),
    blockers: narrative.risks.slice(0, LIST_CAP),
    nextSteps: narrative.nextWeek.slice(0, 1),
  };
}

const ARTICULATE_SYSTEM =
  "You write the narrative layer of a weekly engineering update. Report only what " +
  "the work items support; never introduce a number, date, duration or percentage " +
  "that is not already present. Be concrete and outcome-oriented — say what now " +
  "works, not which files changed.";

function articulatePrompt(
  workItems: WorkItem[],
  narrative: Narrative,
  window: Window,
  guidance: string,
): string {
  const items = workItems.map(
    (w) =>
      `- ${w.title} [${w.type}/${w.impact}, ${w.status}] ` +
      `${w.refs.length} commits, +${w.additions}/-${w.deletions}, days ${w.days.join(",")}`,
  );
  return (
    `Window ${window.start} .. ${window.end}.\nWork items:\n${items.join("\n")}\n\n` +
    `Facts you may cite: ${narrative.summary}\n\n` +
    (guidance === "" ? "" : `The previous draft was rejected:\n${guidance}\n\n`) +
    `Return JSON: {"summary":string,"highlights":[string],"blockers":[string],"nextSteps":[string]}\n` +
    `Rules: highlights are at most ${LIST_CAP}, most significant first. blockers are at ` +
    `most ${LIST_CAP}, phrased as cause + fix. nextSteps has EXACTLY ONE concrete action. ` +
    `No greeting, no closing, no figure that is absent from the work items.`
  );
}

type RawArticulation = {
  summary?: unknown;
  highlights?: unknown;
  blockers?: unknown;
  nextSteps?: unknown;
};

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => x.trim()).slice(0, max)
    : [];

function parseArticulation(raw: unknown): Articulation {
  if (typeof raw !== "object" || raw === null) throw new Error("expected a JSON object");
  const r = raw as RawArticulation;
  const highlights = strings(r.highlights, LIST_CAP);
  if (highlights.length === 0) throw new Error('"highlights" must be a non-empty array of strings');
  return {
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    highlights,
    blockers: strings(r.blockers, LIST_CAP),
    // One next action, per the contract: take the first rather than failing.
    nextSteps: strings(r.nextSteps, 1),
  };
}

export type PipelineOptions = {
  provider: LlmProvider;
  window: Window;
  /** The upstream style contract. Omitted means the gate cannot run. */
  contract?: StyleContract;
  maxAttempts?: number;
};

/**
 * Run the pipeline, retrying the model stages when review fails.
 *
 * The retry re-runs grouping as well as articulation: a style failure often
 * means the work items were split badly (six thin highlights instead of four
 * real ones), which no amount of rephrasing fixes.
 */
export async function runPipeline(
  days: DayEntry[],
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const narrative = await new TemplateNarrative().narrate(days, opts.window);
  const styleSource = opts.contract?.source;
  const history: Array<{ attempt: number; violations: Violation[] }> = [];

  const offlineGrouping = (): Promise<GroupOutcome> => {
    const offline: LlmProvider = { id: "offline", model: "none", complete: async () => "" };
    return groupWorkItems(days, {
      provider: offline,
      window: { start: opts.window.start, end: opts.window.end },
    });
  };

  const deterministicResult = async (
    extra: Partial<PipelineResult>,
  ): Promise<PipelineResult> => {
    const grouping = await offlineGrouping();
    return {
      workItems: grouping.items,
      narrative,
      articulation: articulationsFrom(narrative, grouping.items),
      attempts: 1,
      usedModel: false,
      violations: [],
      fabricatedRefs: grouping.fabricated,
      history,
      ...(styleSource === undefined ? {} : { styleSource }),
      ...extra,
    };
  };

  // Nothing to narrate: skip the model stages entirely. Without this an empty
  // window still paid for grouping, articulation and up to N review attempts
  // arguing about a contract over blank input.
  if (!days.some((d) => d.items.length > 0)) {
    return deterministicResult({ reviewSkipped: "no activity in the window" });
  }
  if (opts.provider.id === "offline") {
    return deterministicResult({
      reviewSkipped: "no model configured, so the style gate could not run",
    });
  }
  if (opts.contract === undefined) {
    return deterministicResult({
      reviewSkipped: "no style contract loaded, so the style gate could not run",
    });
  }

  let guidance = "";
  let last: PipelineResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let grouping: GroupOutcome;
    let articulation: Articulation;

    try {
      grouping = await groupWorkItems(days, {
        provider: opts.provider,
        window: { start: opts.window.start, end: opts.window.end },
      });
      articulation = await completeJson(
        opts.provider,
        articulatePrompt(grouping.items, narrative, opts.window, guidance),
        {
          label: "articulate",
          system: ARTICULATE_SYSTEM,
          parse: parseArticulation,
          // Reasoning models bill thinking against max_tokens; too small a
          // budget truncates the JSON mid-string and loses the stage.
          maxTokens: 4000,
        },
      );
    } catch (err) {
      // A provider failure must not lose the run, but it must not be silent
      // either: the caller needs to know the deck is deterministic, not modelled.
      const reason = err instanceof LlmError || err instanceof Error ? err.message : String(err);
      return deterministicResult({
        attempts: attempt,
        degraded: `${providerLabel(opts.provider)} failed: ${reason}`,
      });
    }

    // The gate itself can fail (unparseable verdict, provider hiccup). That is
    // not the draft's fault, and it must not discard a usable deck — but it must
    // be reported, because "we did not check" is different from "we checked".
    let verdict;
    try {
      verdict = await reviewDraft(articulation, grouping.items, {
        provider: opts.provider,
        contract: opts.contract,
        days,
        narrative,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        workItems: grouping.items,
        narrative,
        articulation,
        attempts: attempt,
        usedModel: true,
        violations: [],
        fabricatedRefs: grouping.fabricated,
        history,
        styleSource: opts.contract.source,
        reviewSkipped: `the review gate failed on attempt ${attempt}: ${reason.slice(0, 200)}`,
      };
    }
    history.push({ attempt, violations: verdict.violations });

    const result: PipelineResult = {
      workItems: grouping.items,
      narrative,
      articulation,
      attempts: attempt,
      usedModel: true,
      violations: verdict.violations,
      fabricatedRefs: grouping.fabricated,
      history,
      styleSource: opts.contract.source,
    };

    if (verdict.aligned) return result;
    last = result;
    guidance = verdict.guidance;
  }

  // Out of attempts: return the last draft and report what still violates, so
  // the caller can surface it instead of shipping a silent style regression.
  return last ?? await deterministicResult({
    reviewSkipped: "no draft survived the review loop",
  });
}
