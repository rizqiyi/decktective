import { LlmError } from "./provider.js";
export class JsonStageError extends Error {
    label;
    constructor(label, message) {
        super(`${label}: ${message}`);
        this.name = "JsonStageError";
        this.label = label;
    }
}
/** Pull a JSON object out of a response that may be fenced or padded with prose. */
export function extractJson(text) {
    const trimmed = text.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = fenced?.[1]?.trim() ?? trimmed;
    try {
        return JSON.parse(candidate);
    }
    catch {
        // Fall through: the model may have wrapped the object in explanation.
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(candidate.slice(start, end + 1));
        }
        catch {
            // Fall through to the error below.
        }
    }
    throw new JsonStageError("extract", `response contained no JSON object: ${trimmed.slice(0, 200)}`);
}
/**
 * Run a stage and return validated, typed output.
 *
 * The input is length-capped before sending: a week of commit data is small,
 * but a repo-wide window is not, and a silent truncation would produce a
 * confidently wrong deck.
 */
export async function completeJson(provider, prompt, opts) {
    const cap = opts.maxInputChars ?? 60_000;
    const bounded = prompt.length > cap
        ? `${prompt.slice(0, cap)}\n\n[input truncated at ${cap} characters]`
        : prompt;
    // Empty responses are common enough on gateways to deserve a second retry.
    const repairs = opts.repairs ?? 2;
    let attemptPrompt = bounded;
    let lastError = "";
    for (let attempt = 0; attempt <= repairs; attempt++) {
        const req = {
            prompt: attemptPrompt,
            maxTokens: opts.maxTokens ?? 4096,
            json: true,
            ...(opts.system === undefined ? {} : { system: opts.system }),
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
        };
        let text;
        try {
            text = await provider.complete(req);
        }
        catch (err) {
            if (err instanceof LlmError)
                throw new JsonStageError(opts.label, err.message);
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
        }
        catch (err) {
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
