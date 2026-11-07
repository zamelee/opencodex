/**
 * Upstream prompt budget: the brake Codex does not have.
 *
 * WHY: Codex meters the prompt in ITS tokenizer (and counts images at ~0 bytes/4), while the
 * upstream meters the body WE put on the wire in ITS tokenizer. Measured on 2026-11-06:
 *   - native image block (base64 in `source.data`) -> billed as vision (~1.6k tokens/image)
 *   - the SAME base64 inside a text block          -> billed as text (~1.4 chars/token)
 * The upstream's own words: "prompt is too long: 2225110 tokens > 1048576 maximum" (code 11115).
 * Codex believed the same prompt was ~350k tokens, so its auto-compact brake never fired and the
 * turn died instead of compacting. That is the "cannot stop" behaviour this module prevents.
 *
 * WHAT: before the request goes upstream, estimate the upstream-side token count of the wire
 * body. If it exceeds the upstream's real window, degrade the request instead of letting the
 * upstream reject it:
 *   1. images whose payload is NOT a usable data URL are dropped (an unusable image is billed
 *      as text upstream — the 2.2M-token shape),
 *   2. then the OLDEST images are textified, one by one, until the estimate fits.
 * The upstream's window is learned from its own error text ("... > 1048576 maximum"), because
 * neither the provider config nor the model catalog has to be right for the brake to work.
 */

import { measureAnthropicWireComposition } from "./token-composition";

/** Fraction of the upstream window we aim to stay under. */
export const UPSTREAM_BUDGET_MARGIN = 0.9;

/**
 * A compaction request carries the PRE-compaction history, so it is intrinsically heavier than
 * the last successful turn — it gets its own, stricter budget. (Measured on the failing thread:
 * the compaction request is the one that died with "prompt is too long".)
 */
export const COMPACTION_BUDGET_FACTOR = 0.85;

/** Placeholder that replaces an image we had to drop. */
export const DROPPED_IMAGE_TEXT = "[image omitted: dropped to fit the upstream context budget]";

/** Upstream window learned per provider (from a "prompt is too long" error). */
const learnedLimits = new Map<string, number>();

/**
 * Extract the upstream's context window from its error text.
 * Handles the MiniMax/new-api shape: "prompt is too long: 2225110 tokens > 1048576 maximum".
 */
export function parseUpstreamPromptLimit(errorText: string): number | undefined {
  const m = errorText.match(/tokens?\s*>\s*(\d+)\s+maximum/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Record the upstream's real window so the NEXT request can be protected. */
export function noteUpstreamPromptLimit(providerKey: string, limitTokens: number): void {
  if (!providerKey || !Number.isFinite(limitTokens) || limitTokens <= 0) return;
  const prev = learnedLimits.get(providerKey);
  // Keep the smallest limit we ever saw: a provider that reports 1,048,576 is the real ceiling
  // even if another message quotes a bigger number.
  if (prev === undefined || limitTokens < prev) learnedLimits.set(providerKey, limitTokens);
}

/** The learned upstream window for a provider, if we have seen one. */
export function learnedUpstreamPromptLimit(providerKey: string): number | undefined {
  return learnedLimits.get(providerKey);
}

/** Test seam: forget everything we learned. */
export function resetLearnedUpstreamLimits(): void {
  learnedLimits.clear();
}

interface ImageRef {
  container: unknown[];
  index: number;
  /** True when the payload is a data URL we can still bill as vision. */
  usable: boolean;
  /** Payload length — the cost we remove when the block is dropped. */
  payloadChars: number;
}

/**
 * Is this an Anthropic wire body?
 *
 * `detectWireShape` is not enough: an OpenAI chat-completions body also has `messages`. The
 * discriminators we use are Anthropic's own `max_tokens` field and the absence of the
 * OpenAI-only content block types.
 */
function isAnthropicWireBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const wire = body as { messages?: unknown; max_tokens?: unknown };
  if (!Array.isArray(wire.messages)) return false;
  if (typeof wire.max_tokens !== "number") return false;
  for (const msg of wire.messages as Array<{ content?: unknown }>) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: unknown }>) {
      const t = String(block?.type ?? "");
      if (t === "image_url" || t === "input_text" || t === "input_image") return false;
    }
  }
  return true;
}

function isHttpUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function collectImages(messages: unknown[]): ImageRef[] {
  const refs: ImageRef[] = [];
  const scan = (arr: unknown[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i] as { type?: unknown; source?: unknown; content?: unknown } | null;
      if (!block || typeof block !== "object") continue;
      if (block.type === "image") {
        const source = (block.source ?? {}) as { type?: unknown; data?: unknown; url?: unknown };
        const usable = source.type === "base64" && typeof source.data === "string";
        const url = typeof source.url === "string" ? source.url : "";
        const payloadChars = usable
          ? String(source.data ?? "").length
          : (isHttpUrl(url) ? 0 : url.length);
        refs.push({ container: arr, index: i, usable, payloadChars });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        scan(block.content);
      }
    }
  };
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (Array.isArray(content)) scan(content);
  }
  return refs;
}

export interface PromptBudgetResult {
  /** The (possibly rewritten) wire body. */
  body: unknown;
  /** Estimated upstream-side tokens AFTER the enforcement. */
  estimatedTokens: number;
  /** The limit we enforced, if any. */
  limitTokens: number | null;
  /** How many image blocks were replaced by a text marker. */
  droppedImages: number;
  /** True when the estimate still exceeds the limit (text alone is too big). */
  overBudget: boolean;
}

/**
 * The budget we actually enforce for one request.
 *
 * `limitTokens` is the upstream's real window. Two things come off it:
 *   - the OUTPUT reserve: the upstream counts the completion against the same window, so the
 *     prompt must leave room for it (we read `max_tokens` out of the wire body).
 *   - for a compaction request, a stricter factor, because that body carries the whole
 *     pre-compaction history.
 */
export function effectiveUpstreamPromptLimit(
  limitTokens: number,
  opts: { compaction?: boolean; outputReserve?: number } = {},
): number {
  const factor = opts.compaction ? COMPACTION_BUDGET_FACTOR : 1;
  const reserve = Math.max(0, opts.outputReserve ?? 0);
  return Math.max(1, Math.floor(limitTokens * factor) - reserve);
}

/**
 * Enforce the upstream's prompt budget on an Anthropic wire body.
 *
 * `limitTokens` is the upstream's real window. When it is undefined nothing changes — the
 * request goes out exactly as built. The body may be a JSON string (that is what the adapters
 * hand to fetch) or a parsed object; the same shape comes back.
 */
export function enforceUpstreamPromptBudget(
  body: unknown,
  limitTokens: number | undefined,
): PromptBudgetResult {
  const isString = typeof body === "string";
  let parsed: unknown = body;
  if (isString) {
    try {
      parsed = JSON.parse(body as string);
    } catch {
      return {
        body,
        estimatedTokens: 0,
        limitTokens: limitTokens ?? null,
        droppedImages: 0,
        overBudget: false,
      };
    }
  }
  const before = measureAnthropicWireComposition(parsed);
  // The brake models the Anthropic wire format (a native image block vs. a payload that the
  // upstream bills as text). On any other wire shape the estimate would be wrong — it would
  // read an OpenAI-style `image_url` part as text and drop images for no reason — so the
  // budget is not applied there.
  if (!isAnthropicWireBody(parsed)) {
    return {
      body,
      estimatedTokens: before.estimatedTokens,
      limitTokens: limitTokens ?? null,
      droppedImages: 0,
      overBudget: false,
    };
  }
  if (limitTokens === undefined || before.estimatedTokens <= limitTokens) {
    return {
      body,
      estimatedTokens: before.estimatedTokens,
      limitTokens: limitTokens ?? null,
      droppedImages: 0,
      overBudget: limitTokens !== undefined && before.estimatedTokens > limitTokens,
    };
  }

  const wire = parsed as { messages?: unknown[] };
  const messages = Array.isArray(wire.messages) ? wire.messages : [];
  const budget = Math.floor(limitTokens * UPSTREAM_BUDGET_MARGIN);
  let dropped = 0;

  // Step 1: an image we cannot bill as vision is billed as TEXT upstream. Drop those first —
  // they are the expensive ones (a 400KB "url" payload costs ~300k tokens as text).
  for (const ref of collectImages(messages)) {
    if (ref.usable || ref.payloadChars === 0) continue;
    ref.container[ref.index] = { type: "text", text: DROPPED_IMAGE_TEXT };
    dropped++;
  }

  // Step 2: still over budget — give up the OLDEST images first (the newest screenshot is the
  // one the model needs). Each native image costs ~1.6k vision tokens.
  let guard = 0;
  while (guard++ < 200) {
    const current = measureAnthropicWireComposition(wire);
    if (current.estimatedTokens <= budget) break;
    const images = collectImages(messages).filter((r) => r.usable);
    if (images.length === 0) break;
    const oldest = images[0];
    oldest.container[oldest.index] = { type: "text", text: DROPPED_IMAGE_TEXT };
    dropped++;
  }

  const after = measureAnthropicWireComposition(wire);
  return {
    body: isString ? JSON.stringify(wire) : wire,
    estimatedTokens: after.estimatedTokens,
    limitTokens,
    droppedImages: dropped,
    overBudget: after.estimatedTokens > limitTokens,
  };
}
