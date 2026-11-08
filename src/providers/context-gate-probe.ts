/**
 * ACTIVE context-gate probe: ask the upstream where its ceiling is.
 *
 * The passive view (src/lib/upstream-prompt-budget.ts) only knows what the upstream has
 * already told us - usually nothing, because a rejected request is the only thing that
 * makes an upstream quote its gate. This module spends one request to make it talk.
 *
 * HOW IT WORKS, and why it is safe to run on demand:
 *   - We send ONE request whose body is deliberately far larger than any plausible window.
 *     The upstream is expected to REJECT it, and a rejected request is normally not billed.
 *   - The rejection carries the ceiling ("prompt is too long: N tokens > M maximum"), which
 *     is the number we want. If the upstream ACCEPTS it, we did not learn a ceiling - we
 *     learned a LOWER BOUND, and we stop there rather than doubling into a bill.
 *   - The output is 1 token, so a surprise acceptance costs the input tokens, not a
 *     generation.
 *
 * WHAT IT DOES NOT DO: it never guesses. A 429, a 5xx, a timeout or an unrecognised
 * 400 yields no number at all - the trace says so instead of inventing one.
 */

import { parseUpstreamRejection } from "../lib/upstream-prompt-budget";
import type { OcxProviderConfig } from "../types";

/**
 * The default size of the request we send.
 *
 * Big enough to overshoot a 1M window, but not bigger for the sake of it: the body is
 * several megabytes, and a relay that has to read all of it before it can reject the
 * request will time out on a 6MB upload long before it gets to answer.
 */
export const GATE_PROBE_DEFAULT_TARGET_TOKENS = 1_200_000;
/** Hard ceiling for one probe request. */
export const GATE_PROBE_MAX_TARGET_TOKENS = 4_000_000;
/** How long we wait for the upstream to reject the request. */
const GATE_PROBE_TIMEOUT_MS = 150_000;

/**
 * Filler words for the oversized request.
 *
 * They have to survive BPE: a body of "aaaaaaaa..." collapses into a handful of tokens, so
 * the request would be far smaller than it looks and the upstream would accept it. Random
 * short alphanumeric words do not merge, so the body really is as many tokens as we asked
 * for (within the usual tokenizer variance).
 */
const FILLER_WORDS: string[] = [
  "zx7q", "kv3m", "wp9d", "rq4t", "bn6y", "hj2w", "vf8s", "gx5r", "kl7n", "pt3c",
  "dz9m", "wq4h", "fy2j", "nk6b", "tv8x", "rc1p", "mb5z", "jh3v", "sp7g", "xn2d",
];

/**
 * Build a body of roughly `targetTokens` tokens.
 *
 * The ratio is deliberately pessimistic (3 chars/token): the upstream's tokenizer usually
 * packs MORE characters into a token than that, so the request comes out LARGER than we
 * intended. Overshooting is free - the request is supposed to be rejected - while
 * undershooting costs a round trip and a bill.
 */
export function buildProbeFiller(targetTokens: number): string {
  const targetChars = Math.max(1, Math.floor(targetTokens * 3));
  const parts: string[] = [];
  let length = 0;
  let i = 0;
  while (length < targetChars) {
    const word = FILLER_WORDS[i++ % FILLER_WORDS.length]!;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

export interface GateProbeAttempt {
  /** What we did, in one line, for the operator-facing trace. */
  action: string;
  /** The size we aimed for (estimated tokens). */
  targetTokens: number;
  /** The upstream's HTTP status, when we got one. */
  status?: number;
  /** The request size the upstream quoted, when it said one. */
  reportedTokens?: number;
  /** The ceiling the upstream reported, when it reported one. */
  limit?: number;
  /** The size the upstream accepted, when it accepted the request. */
  lowerBoundTokens?: number;
  /** What the attempt proved. */
  outcome: "rejected" | "accepted" | "unknown";
  /** Why this attempt ended the way it did (the GUI translates it). */
  reason?: GateProbeReason;
  /** The upstream's own words, quoted verbatim (never translated, never invented). */
  detail?: string;
}

/** Why a probe ended the way it did, in a form the GUI can translate. */
export type GateProbeReason =
  | "gate-learned"
  | "rejected-no-limit"
  | "accepted-lower-bound"
  | "rate-limited"
  | "no-balance"
  | "bad-key"
  | "model-not-found"
  | "upstream-error"
  | "timeout"
  | "unsupported-adapter"
  | "unknown";

export interface GateProbeResult {
  /** Every attempt, in order. */
  attempts: GateProbeAttempt[];
  /** The ceiling we learned, when the upstream rejected the request. */
  limit?: number;
  /** What we know the upstream CAN take, when it accepted the request. */
  lowerBound?: number;
  /** True when the probe produced a usable ceiling. */
  ok: boolean;
  /** Why it ended that way. */
  reason: GateProbeReason;
  /** Why the probe produced nothing, when it produced nothing. */
  error?: string;
}

/** The inference endpoint for a provider's adapter, and how to authenticate to it. */
function probeTarget(provider: OcxProviderConfig, key: string):
  | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
  | { error: string } {
  const base = (provider.baseUrl ?? "").replace(/\/v1\/?$/, "");
  const custom = provider.headers ? { ...provider.headers } : {};
  switch (provider.adapter) {
    case "anthropic": {
      if (!base) return { error: "provider has no baseUrl" };
      return {
        url: `${base}/v1/messages`,
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key,
          ...custom,
        },
        body: { model: "", max_tokens: 1, messages: [] },
      };
    }
    case "openai-chat": {
      const root = provider.baseUrl ?? "";
      if (!root) return { error: "provider has no baseUrl" };
      return {
        url: `${root.replace(/\/+$/, "")}/chat/completions`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...custom },
        body: { model: "", max_tokens: 1, messages: [] },
      };
    }
    case "openai-responses": {
      if (!base) return { error: "provider has no baseUrl" };
      return {
        url: `${base}/v1/responses`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...custom },
        body: { model: "", max_output_tokens: 1, input: [] },
      };
    }
    default:
      return { error: `the ${provider.adapter} adapter cannot be probed for a context gate` };
  }
}

/**
 * Send ONE oversized request and read the upstream's answer.
 */
export async function probeUpstreamGate(opts: {
  provider: OcxProviderConfig;
  modelId: string;
  apiKey: string;
  /** A ceiling we already know; we aim well past it. */
  learnedLimit?: number;
  /** A declared window; we aim past it too. */
  declaredLimit?: number;
  /** Override the request size (tests). */
  targetTokens?: number;
}): Promise<GateProbeResult> {
  const { provider, modelId, apiKey } = opts;
  const attempts: GateProbeAttempt[] = [];

  const target = probeTarget(provider, apiKey);
  if ("error" in target) {
    return { attempts, ok: false, reason: "unsupported-adapter", error: target.error };
  }

  // Aim well past anything we already know: a request that lands UNDER the ceiling costs
  // a bill and teaches us nothing, while one that lands OVER it is normally free.
  const known = Math.max(opts.learnedLimit ?? 0, opts.declaredLimit ?? 0);
  const wanted = opts.targetTokens ?? Math.max(GATE_PROBE_DEFAULT_TARGET_TOKENS, Math.ceil(known * 1.5));
  const targetTokens = Math.min(Math.max(1, Math.floor(wanted)), GATE_PROBE_MAX_TARGET_TOKENS);

  const filler = buildProbeFiller(targetTokens);
  const wire = target.body;
  if (provider.adapter === "anthropic") {
    wire.model = modelId;
    wire.messages = [{ role: "user", content: [{ type: "text", text: filler }] }];
  } else if (provider.adapter === "openai-chat") {
    wire.model = modelId;
    wire.messages = [{ role: "user", content: filler }];
  } else {
    wire.model = modelId;
    wire.input = [{ role: "user", content: [{ type: "input_text", text: filler }] }];
  }

  const attempt: GateProbeAttempt = {
    action: "sent one oversized request",
    targetTokens,
    outcome: "unknown",
  };
  attempts.push(attempt);

  let text = "";
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(GATE_PROBE_TIMEOUT_MS),
    });
    attempt.status = res.status;
    text = await res.text().catch(() => "");
  } catch (err) {
    attempt.outcome = "unknown";
    attempt.detail = err instanceof Error ? err.message : String(err);
    return {
      attempts,
      ok: false,
      reason: /timeout|aborted/i.test(attempt.detail) ? "timeout" : "unknown",
      error: `the probe request did not complete: ${attempt.detail}`,
    };
  }

  const gate = parseUpstreamRejection(text);
  if (gate.limit) {
    attempt.outcome = "rejected";
    attempt.reason = "gate-learned";
    attempt.limit = gate.limit;
    if (gate.observedInputTokens !== undefined) attempt.reportedTokens = gate.observedInputTokens;
    attempt.detail = quote(text);
    return { attempts, limit: gate.limit, ok: true, reason: "gate-learned" };
  }

  if (gate.rejectedWithoutLimit) {
    // The upstream refused it for being too long but named no ceiling. That confirms the
    // request WAS over the limit, but a number we cannot read is not a number we may store.
    attempt.outcome = "rejected";
    attempt.reason = "rejected-no-limit";
    attempt.detail = quote(text);
    return {
      attempts,
      ok: false,
      reason: "rejected-no-limit",
      error: "the upstream confirmed the request was too long but did not name a ceiling, so nothing was learned",
    };
  }

  if (attempt.status === 200) {
    attempt.outcome = "accepted";
    attempt.reason = "accepted-lower-bound";
    // The upstream took it, so its ceiling is above what we sent. That is a lower bound,
    // not a ceiling - and sending more would cost real money, so we stop here.
    const usageTokens = readInputTokens(text);
    attempt.lowerBoundTokens = usageTokens;
    attempt.detail = quote(text);
    return {
      attempts,
      ok: false,
      reason: "accepted-lower-bound",
      lowerBound: usageTokens ?? targetTokens,
      error: "the upstream accepted the oversized request, so no ceiling was learned; its real limit is above what we sent",
    };
  }

  attempt.outcome = "unknown";
  attempt.reason = reasonForStatus(attempt.status);
  attempt.detail = quote(text);
  return {
    attempts,
    ok: false,
    reason: reasonForStatus(attempt.status),
    error: `the upstream answered ${attempt.status} without naming a ceiling, so nothing was learned`,
  };
}

/** The upstream's answer, quoted as-is and trimmed. */
function quote(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

/** Map an HTTP status to the reason the GUI shows. */
function reasonForStatus(status: number | undefined): GateProbeReason {
  if (status === 401) return "bad-key";
  if (status === 403) return "no-balance";
  if (status === 404) return "model-not-found";
  if (status === 429) return "rate-limited";
  return "upstream-error";
}

/** Pull the input token count out of a response body, when the upstream reports one. */
function readInputTokens(text: string): number | undefined {
  try {
    const parsed = JSON.parse(text) as {
      usage?: { input_tokens?: unknown; prompt_tokens?: unknown };
      inputTokens?: unknown;
    };
    const n = parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens ?? parsed.inputTokens;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
