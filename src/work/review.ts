/**
 * Review & Validate.
 *
 * Judges a drafted report against the output-style contract (the upstream
 * `i-have-adhd` skill text, passed through verbatim) and returns JSON. When the
 * draft is not aligned, the pipeline loops back to normalization with the
 * returned guidance, bounded by an attempt cap.
 *
 * Two things are checked, and they are checked differently:
 *
 *   - STYLE is a judgement, so it goes to the model with the contract text.
 *   - FACTS are not negotiable, so they are verified in code (`assertFactLocked`).
 *     A model never gets to bless a number it invented.
 */
import type { DayEntry, Narrative, WorkItem } from "../ir/types.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { completeJson } from "../llm/json.ts";
import { assertFactLocked } from "../narrative/validate.ts";
import type { StyleContract } from "../style/contract.ts";

export type Violation = {
  /** Quoted from the contract, e.g. "Cap lists to 5 items". */
  rule: string;
  /** Where in the draft, e.g. "highlights[6]". */
  where: string;
  detail: string;
};

export type ReviewVerdict = {
  aligned: boolean;
  violations: Violation[];
  /** Instruction fed to the next attempt. Empty when aligned. */
  guidance: string;
  /** True when the code-level fact check rejected the draft. */
  factLocked: boolean;
};

export type Draft = {
  summary: string;
  highlights: string[];
  blockers: string[];
  nextSteps: string[];
};

const REVIEW_SYSTEM_TAIL =
  "\n\n---\n\nYou are reviewing a weekly engineering update against the contract above. " +
  "Judge presentation only — never facts, never wording you merely dislike. " +
  "Report a violation only when the contract is actually broken, and quote the rule " +
  "you are applying. Be strict about structure (list caps, one next action, preamble, " +
  "closers) and lenient about taste.";

function reviewPrompt(draft: Draft, workItems: WorkItem[]): string {
  const items = workItems.map(
    (w) => `- ${w.title} [${w.type}/${w.impact}, ${w.status}] ${w.refs.length} commits`,
  );
  return (
    `DRAFT UNDER REVIEW\n` +
    `summary: ${draft.summary}\n` +
    `highlights:\n${draft.highlights.map((h) => `  - ${h}`).join("\n")}\n` +
    `blockers:\n${draft.blockers.map((b) => `  - ${b}`).join("\n") || "  (none)"}\n` +
    `nextSteps:\n${draft.nextSteps.map((s) => `  - ${s}`).join("\n") || "  (none)"}\n\n` +
    `WORK ITEMS IT REPORTS ON\n${items.join("\n")}\n\n` +
    `Return JSON: {"aligned":boolean,"violations":[{"rule":string,"where":string,"detail":string}],` +
    `"guidance":string}\n` +
    `Keep "rule" under 8 words and "detail" under 20 — quote the contract, do not restate it. ` +
    `"guidance" must be one actionable instruction, and empty when aligned.`
  );
}

type RawVerdict = { aligned?: unknown; violations?: unknown; guidance?: unknown };

function parseVerdict(raw: unknown): { aligned: boolean; violations: Violation[]; guidance: string } {
  if (typeof raw !== "object" || raw === null) throw new Error("expected a JSON object");
  const r = raw as RawVerdict;
  if (typeof r.aligned !== "boolean") throw new Error('"aligned" must be a boolean');

  const violations: Violation[] = [];
  if (Array.isArray(r.violations)) {
    for (const v of r.violations) {
      if (typeof v !== "object" || v === null) continue;
      const { rule, where, detail } = v as Record<string, unknown>;
      if (typeof rule !== "string" || rule.trim() === "") continue;
      violations.push({
        rule: rule.trim().slice(0, 120),
        where: typeof where === "string" ? where.trim().slice(0, 80) : "draft",
        detail: typeof detail === "string" ? detail.trim().slice(0, 400) : "",
      });
    }
  }
  const guidance = typeof r.guidance === "string" ? r.guidance.trim() : "";
  // Trust the field only as far as it is consistent with the listed violations:
  // "aligned" with violations against it, or vice versa, is a model mistake.
  const aligned = r.aligned && violations.length === 0;
  return { aligned, violations, guidance };
}

export type ReviewOptions = {
  provider: LlmProvider;
  contract: StyleContract;
  days: DayEntry[];
  /** The deterministic narrative, used for the fact check. */
  narrative: Narrative;
};

/**
 * Review a draft. Returns a verdict rather than throwing: a failed review is a
 * normal outcome the pipeline retries, not an error.
 */
export async function reviewDraft(
  draft: Draft,
  workItems: WorkItem[],
  opts: ReviewOptions,
): Promise<ReviewVerdict> {
  // Facts first. Style cannot rescue an invented number.
  let factLocked = true;
  let factDetail = "";
  try {
    assertFactLocked({ ...opts.narrative, summary: draft.summary }, opts.days);
  } catch (err) {
    factLocked = false;
    factDetail = err instanceof Error ? err.message : String(err);
  }

  const raw = await completeJson(opts.provider, reviewPrompt(draft, workItems), {
    label: "review",
    system: `${opts.contract.text}${REVIEW_SYSTEM_TAIL}`,
    parse: parseVerdict,
    // The system prompt is the whole contract document, and reasoning bills
    // against this budget: too small a value ends the call with finish_reason
    // "length" and no content, so the gate never even sees a verdict.
    maxTokens: 6000,
  });

  const violations = [...raw.violations];
  if (!factLocked) {
    violations.unshift({
      rule: "facts are immutable",
      where: "summary",
      detail: factDetail,
    });
  }

  const guidanceParts: string[] = [];
  if (raw.guidance !== "") guidanceParts.push(raw.guidance);
  if (!factLocked) {
    guidanceParts.push(
      "Your summary used a figure that is not in the supplied facts. Remove it or " +
      "replace it with one of the supplied values.",
    );
  }
  if (violations.length > 0 && guidanceParts.length === 0) {
    guidanceParts.push(
      `Fix these contract violations and resend:\n` +
      violations.map((v) => `- [${v.rule}] ${v.where}: ${v.detail}`).join("\n"),
    );
  }

  return {
    aligned: raw.aligned && violations.length === 0,
    violations,
    guidance: guidanceParts.join("\n"),
    factLocked,
  };
}
