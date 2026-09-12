/**
 * Known vendors. `model` is passed through verbatim, so any model the gateway
 * serves works without code changes — the pipeline never hardcodes a model.
 */
export const KNOWN_PROVIDERS = {
    commandcode: {
        protocol: "openai",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        keyEnv: "COMMANDCODE_API_KEY",
    },
    openai: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        keyEnv: "OPENAI_API_KEY",
    },
    anthropic: {
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        keyEnv: "ANTHROPIC_API_KEY",
    },
};
export class LlmError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "LlmError";
        this.status = status;
    }
}
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * POST JSON with bounded retries. Rate limits and 5xx are transient and worth
 * retrying; 4xx (bad model, bad key) are not — surfacing those immediately is
 * what makes a misconfigured provider fixable.
 */
async function postJson(url, headers, body) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
            });
        }
        catch (err) {
            lastError = new LlmError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (attempt < MAX_ATTEMPTS) {
                await sleep(500 * 2 ** (attempt - 1));
                continue;
            }
            throw lastError;
        }
        const text = await res.text();
        if (res.ok) {
            try {
                return JSON.parse(text);
            }
            catch {
                throw new LlmError(`provider returned non-JSON response: ${text.slice(0, 200)}`, res.status);
            }
        }
        const detail = text.slice(0, 300);
        if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new LlmError(`HTTP ${res.status}: ${detail}`, res.status);
            await sleep(500 * 2 ** (attempt - 1));
            continue;
        }
        throw new LlmError(`HTTP ${res.status}: ${detail}`, res.status);
    }
    throw lastError ?? new LlmError("unreachable");
}
function openAiChoice(payload) {
    if (typeof payload !== "object" || payload === null || !("choices" in payload)) {
        throw new LlmError("unexpected response shape (no choices)");
    }
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        throw new LlmError("empty choices");
    const first = choices[0];
    const content = first.message?.content;
    if (typeof content !== "string")
        throw new LlmError("choice had no text content");
    return {
        text: content,
        finish: typeof first.finish_reason === "string" ? first.finish_reason : "",
    };
}
function anthropicText(payload) {
    if (typeof payload !== "object" || payload === null || !("content" in payload)) {
        throw new LlmError("unexpected response shape (no content)");
    }
    const content = payload.content;
    if (!Array.isArray(content))
        throw new LlmError("unexpected content shape");
    const parts = content
        .map((b) => (typeof b === "object" && b !== null ? b : undefined))
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text ?? "");
    if (parts.length === 0)
        throw new LlmError("response contained no text block");
    return parts.join("");
}
class OpenAiCompatProvider {
    id;
    model;
    baseUrl;
    apiKey;
    constructor(id, model, baseUrl, apiKey) {
        this.id = id;
        this.model = model;
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.apiKey = apiKey;
    }
    async complete(req) {
        const messages = [];
        if (req.system)
            messages.push({ role: "system", content: req.system });
        messages.push({ role: "user", content: req.prompt });
        const body = (jsonFlag) => {
            const b = {
                model: this.model,
                messages,
                max_tokens: req.maxTokens ?? 4096,
            };
            if (req.temperature !== undefined)
                b.temperature = req.temperature;
            if (jsonFlag)
                b.response_format = { type: "json_object" };
            return b;
        };
        const url = `${this.baseUrl}/chat/completions`;
        const headers = { authorization: `Bearer ${this.apiKey}` };
        const first = openAiChoice(await postJson(url, headers, body(req.json === true)));
        // Some gateways let `response_format: json_object` trigger runaway reasoning
        // that consumes the whole budget, so the model returns finish_reason
        // "length" with EMPTY content — observed on commandcode + deepseek with a
        // system prompt present. The prompt already instructs JSON, so retrying
        // without the flag recovers the answer instead of losing the stage.
        if (req.json === true && first.text.trim() === "") {
            const retry = openAiChoice(await postJson(url, headers, body(false)));
            if (retry.text.trim() !== "")
                return retry.text;
            throw new LlmError(`model produced no content (finish_reason=${retry.finish || first.finish || "unknown"}); ` +
                `raise max_tokens or use a non-reasoning model`);
        }
        if (first.text.trim() === "") {
            throw new LlmError(`model produced no content (finish_reason=${first.finish || "unknown"})`);
        }
        return first.text;
    }
}
class AnthropicProvider {
    id;
    model;
    baseUrl;
    apiKey;
    constructor(id, model, baseUrl, apiKey) {
        this.id = id;
        this.model = model;
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.apiKey = apiKey;
    }
    async complete(req) {
        const body = {
            model: this.model,
            max_tokens: req.maxTokens ?? 4096,
            messages: [{ role: "user", content: req.prompt }],
        };
        if (req.system)
            body.system = req.system;
        if (req.temperature !== undefined)
            body.temperature = req.temperature;
        const payload = await postJson(`${this.baseUrl}/messages`, { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body);
        return anthropicText(payload);
    }
}
/** No model configured: stages must fall back to their deterministic path. */
export class OfflineProvider {
    id = "offline";
    model = "none";
    async complete() {
        throw new LlmError("no LLM configured (running offline)");
    }
}
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
/**
 * Resolve a provider from a `provider/model` spec or the environment.
 *
 * The model half is passed through untouched — gateways differ on whether ids
 * carry a vendor prefix, so guessing would break them. Order: explicit spec,
 * `DECKTECTIVE_LLM`, then the single configured provider, else offline.
 */
export function resolveProvider(req = {}) {
    const env = req.env ?? process.env;
    const spec = req.spec ?? env.DECKTECTIVE_LLM;
    let providerId;
    let model;
    if (spec) {
        const slash = spec.indexOf("/");
        if (slash < 0)
            throw new LlmError(`llm spec must be "provider/model", got ${JSON.stringify(spec)}`);
        providerId = spec.slice(0, slash);
        model = spec.slice(slash + 1);
        if (model.length === 0)
            throw new LlmError(`llm spec ${JSON.stringify(spec)} has no model`);
    }
    else {
        providerId = Object.keys(KNOWN_PROVIDERS).find((id) => {
            const k = KNOWN_PROVIDERS[id]?.keyEnv;
            return k !== undefined && (env[k]?.length ?? 0) > 0;
        }) ?? "";
        if (providerId === "")
            return new OfflineProvider();
        model = DEFAULT_MODEL;
    }
    const known = KNOWN_PROVIDERS[providerId];
    const baseUrl = req.baseUrl ?? known?.baseUrl;
    const keyEnv = req.keyEnv ?? known?.keyEnv ?? `${providerId.toUpperCase()}_API_KEY`;
    const protocol = req.protocol ?? known?.protocol ?? "openai";
    if (baseUrl === undefined) {
        throw new LlmError(`unknown LLM provider ${JSON.stringify(providerId)}; ` +
            `known: ${Object.keys(KNOWN_PROVIDERS).join(", ")}. ` +
            `Pass --llm-base-url for a custom gateway.`);
    }
    const apiKey = env[keyEnv];
    if (!apiKey) {
        throw new LlmError(`provider ${JSON.stringify(providerId)} needs ${keyEnv} in the environment`);
    }
    return protocol === "anthropic"
        ? new AnthropicProvider(providerId, model, baseUrl, apiKey)
        : new OpenAiCompatProvider(providerId, model, baseUrl, apiKey);
}
/** True when a real model is available; stages use this to pick their path. */
export function isLive(provider) {
    return provider.id !== "offline";
}
