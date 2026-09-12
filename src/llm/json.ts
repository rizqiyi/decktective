/**
 * Schema-constrained JSON calls for pipeline stages.
 *
 * Every model-touching stage must return structured data, so this centralises
 * three things that would otherwise be re-implemented (and got wrong) per
 * stage: extracting JSON from a chatty response, validating it, and giving the
 * model one chance to repair its own output when the shape is wrong.
 */
import type { LlmProvider, LlmRequest } from "./provider.ts";
import { LlmError } from "./provider.ts";

export class JsonStageError extends Error {
  readonly label: string;
  constructor(label: string, message: string) {
    super(`${label}: ${message}`);
    this.name = "JsonStageError";
    this.label = label;
  }
}

/** Pull a JSON object out of a response that may be fenced or padded with prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // Fall through: the model may have wrapped the object in explanation.
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      // Fall through to the error below.
    }
  }
  throw new JsonStageError("extract", `response contained no JSON object: ${trimmed.slice(0, 200)}`);
}

export type JsonStageOptions<T> = {
  /** Human name used in errors, e.g. "group-work-items". */
  label: string;
  system?: string;
  /** Validates and narrows the parsed value; throw to trigger a repair round. */
  parse: (raw: unknown) => T;
  maxTokens?: number;
  temperature?: number;
  /** Repair attempts after the first failure. */
  repairs?: number;
  maxInputChars?: number;
};

/**
 * Run a stage and return validated, typed output.
 *
 * The input is length-capped before sending: a week of commit data is small,
 * but a repo-wide window is not, and a silent truncation would produce a
 * confidently wrong deck.
 */
export async function completeJson<T>(
  provider: LlmProvider,
  prompt: string,
  opts: JsonStageOptions<T>,
): Promise<T> {
  const cap = opts.maxInputChars ?? 60_000;
  const bounded = prompt.length > cap
    ? `${prompt.slice(0, cap)}\n\n[input truncated at ${cap} characters]`
    : prompt;

  // Empty responses are common enough on gateways to deserve a second retry.
  const repairs = opts.repairs ?? 2;
  let attemptPrompt = bounded;
  let lastError = "";

  for (let attempt = 0; attempt <= repairs; attempt++) {
    const req: LlmRequest = {
      prompt: attemptPrompt,
      maxTokens: opts.maxTokens ?? 4096,
      json: true,
      ...(opts.system === undefined ? {} : { system: opts.system }),
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    };
    let text: string;
    try {
      text = await provider.complete(req);
    } catch (err) {
      if (err instanceof LlmError) throw new JsonStageError(opts.label, err.message);
      throw err;
    }

    // Gateways intermittently return an empty body with HTTP 200. That is a
    // transient provider fault, not a malformed answer, so it takes the repair
    // path (a fresh call) instead of looking like unparseable output.
    if (text.trim() === "") {
      lastError = "provider returned empty content";
      if (attempt < repairs) {
        attemptPrompt =
          `${bounded}\n\n(Your previous response was empty. Respond with ONLY the JSON object.)`;
      }
      continue;
    }

    try {
      return opts.parse(extractJson(text));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < repairs) {
        attemptPrompt =
          `${bounded}\n\nYour previous response was rejected: ${lastError}\n` +
          `Respond with ONLY a corrected JSON object.`;
      }
    }
  }

  throw new JsonStageError(opts.label, `output failed validation after repair: ${lastError}`);
}
