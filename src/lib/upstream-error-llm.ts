/**
 * Optional LLM assist for classifying an upstream refusal.
 *
 * WHY: some upstreams word their refusals in ways no rule set anticipates. A small model can
 * read a message and say "this is a plan/quota refusal" where our own patterns saw nothing.
 * That is the ONLY job it gets here.
 *
 * WHAT it may NOT do, by construction:
 *   - it never supplies a number. Token counts and ceilings come from the deterministic
 *     reader, because a model that is asked for a number will sometimes produce a plausible
 *     one (measured on Qwen3.5-4B: 9/10 correct on the observed size, 5/10 on the code, and a
 *     providerType field that was pure invention - azure, groq, api, unknown, ...).
 *   - it never writes a learned limit or a learned token scale.
 *   - it only fills a gap: when the deterministic reader already named a family, the model is
 *     not consulted at all.
 *   - it never blocks the request: a timeout, a 429, a malformed answer or a disagreement
 *     about a number all end the same way - no suggestion, and the deterministic reading
 *     stands.
 *
 * The switch is OFF by default. An operator turns it on deliberately.
 */

import type { NormalizedUpstreamError, UpstreamErrorFamily } from "./upstream-error-normalize";

export interface UpstreamErrorLlmAssistConfig {
  /** Off unless the operator says otherwise. */
  enabled?: boolean;
  /** A provider from config.json to take baseUrl/apiKey from. */
  provider?: string;
  /** The anthropic-style endpoint to ask (e.g. https://api.siliconflow.cn). */
  baseUrl?: string;
  /** The key for that endpoint. */
  apiKey?: string;
  /** The model id to ask. */
  model?: string;
  /** Hard ceiling on the whole call. The measured long tail was 34s; 5s is the default. */
  timeoutMs?: number;
}

export interface ErrorFamilySuggestion {
  family: UpstreamErrorFamily;
  confidence?: number;
  reason?: string;
}

const KNOWN_FAMILIES: UpstreamErrorFamily[] = [
  "prompt_too_long",
  "context_length_exceeded",
  "quota_exhausted",
  "content_policy",
  "auth",
  "unknown",
];

const DEFAULT_TIMEOUT_MS = 5_000;

const SYSTEM_PROMPT = [
  "You are an upstream API error classifier. Reply with EXACTLY one minified JSON object and",
  "nothing else. No prose, no markdown, no thousands separators. Keys:",
  "family (one of prompt_too_long|context_length_exceeded|quota_exhausted|content_policy|auth|unknown),",
  "providerType (string or null), providerCode (number or null), observedTokens (number or null),",
  "contextLimit (number or null), reason (short string).",
  "Copy any number verbatim from the source text; use null when absent. Never compute numbers.",
].join(" ");

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Ask the model for a family, and return it only when it passes every gate.
 *
 * Returns undefined - meaning "use the deterministic reading" - on every failure path.
 */
export async function suggestErrorFamily(
  normalized: NormalizedUpstreamError,
  opts: {
    config: UpstreamErrorLlmAssistConfig;
    fetchImpl?: typeof fetch;
  },
): Promise<ErrorFamilySuggestion | undefined> {
  const { config } = opts;
  if (!config?.enabled) return undefined;
  // Only fill a gap. A deterministic reading is never second-guessed.
  if (normalized.family !== "unknown") return undefined;
  if (!config.baseUrl || !config.apiKey || !config.model) return undefined;

  const text = normalized.message?.trim();
  if (!text) return undefined;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        // Reasoners spend their whole budget thinking and then answer with nothing; the
        // measured 4B model needed 45s+ with thinking on and ~2s with it off.
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: `raw error body:\n${text}` }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const answer = (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!answer) return undefined;

    const parsed = extractJson(answer) as
      | {
          family?: string;
          confidence?: number;
          reason?: string;
          observedTokens?: number | null;
          contextLimit?: number | null;
        }
      | undefined;
    if (!parsed || typeof parsed !== "object") return undefined;

    // CROSS-CHECK: a model that reports a number we already know, and gets it wrong, is not
    // trusted for the family either. Numbers from the model are never used; they only buy
    // the model the right to suggest a family.
    const claimedObserved = typeof parsed.observedTokens === "number" ? parsed.observedTokens : undefined;
    const claimedLimit = typeof parsed.contextLimit === "number" ? parsed.contextLimit : undefined;
    if (
      (claimedObserved !== undefined && normalized.observedTokens !== undefined
        && claimedObserved !== normalized.observedTokens)
      || (claimedLimit !== undefined && normalized.contextLimit !== undefined
        && claimedLimit !== normalized.contextLimit)
    ) {
      return undefined;
    }

    const family = parsed.family as UpstreamErrorFamily | undefined;
    if (!family || !KNOWN_FAMILIES.includes(family) || family === "unknown") return undefined;

    return {
      family,
      ...(typeof parsed.confidence === "number" ? { confidence: parsed.confidence } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason.slice(0, 300) } : {}),
    };
  } catch {
    // A timeout, a 429, a network error or an unreadable answer all mean the same thing:
    // the deterministic reading stands.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
