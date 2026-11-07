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
import { collectImageInventory } from "../image/image-inventory";
import { downsampleImagePayload } from "../image/image-downsample";
import { estimateImageTokens, targetMaxEdgeForFamily } from "../image/image-estimator";
import type { ImageInventoryEntry } from "../image/image-inventory";
import {
  describeDrop,
  dropOrder,
  droppedImagePlaceholder,
  fallbackOrder,
  planImages,
  type ImageDropLog,
} from "../image/image-policy";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

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
 * The learned ceilings are the single most valuable number we have (the upstream's REAL limit,
 * learned from its own rejection), and they are expensive to learn: it takes an over-long turn
 * to find out. Keeping them in memory only meant a restart threw them away — the probe would
 * answer "nothing learned yet" right after we had learned it. So they live in a small sidecar
 * file next to config.json.
 *
 * Load/save are EXPLICIT (the server calls them): a module that wrote to disk on its own would
 * write into the operator's real config dir during `bun test`, and the test fixtures would end
 * up masquerading as learned facts.
 */

function learnedLimitsPath(): string {
  // Imported lazily: config.ts pulls in zod and the whole config surface; this module is on the
  // hot request path and must not pay for it.
  const { getConfigDir } = require("../config") as { getConfigDir: () => string };
  return join(getConfigDir(), "upstream-limits.json");
}

/** Load the persisted ceilings into memory. Called once at server start. */
export function loadLearnedLimits(): void {
  try {
    const path = learnedLimitsPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        learnedLimits.set(key, value);
      }
    }
  } catch {
    /* no sidecar / unreadable -> we learn again */
  }
}

/** Persist the ceilings to the sidecar file. Called after a NEW ceiling is learned. */
export function saveLearnedLimits(): void {
  try {
    const path = learnedLimitsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(learnedLimits), null, 2), "utf-8");
  } catch {
    /* diagnostics must never break the request path */
  }
}

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

export interface PromptBudgetResult {
  /** The (possibly rewritten) wire body. */
  body: unknown;
  /** Estimated upstream-side tokens AFTER the enforcement. */
  estimatedTokens: number;
  /** The limit we enforced, if any. */
  limitTokens: number | null;
  /** How many image blocks were replaced by a text marker. */
  droppedImages: number;
  /** Per-image audit of what the brake gave up and why. */
  imageDrops: ImageDropLog[];
  /** Per-image audit of what the brake SHRANK instead of dropping. */
  imageDownsamples: ImageDownsampleLog[];
  /** True when the estimate still exceeds the limit (text alone is too big). */
  overBudget: boolean;
}

/** One line per downsampled image, for the request log. */
export interface ImageDownsampleLog {
  ordinal: number;
  tier: string;
  reason: string;
  dimensionsBefore?: string;
  dimensionsAfter: string;
  bytesBefore: number;
  bytesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface PromptBudgetOptions {
  /** Provider name, for the billing-family detection behind the per-image estimate. */
  providerName?: string;
  /** Model id, for the billing-family detection behind the per-image estimate. */
  modelId?: string;
  /** How many recent turns keep their images when the brake has to give some up. */
  preserveRecentTurns?: number;
  /**
   * Shrink an oversized image instead of dropping it (phase 2). Off by default: an
   * operator who wants the upstream to see byte-exact payloads must be able to say no.
   */
  imageDownsample?: boolean;
  /** Override the target long edge. Defaults to the provider family's standard limit. */
  downsampleMaxEdge?: number;
}

/**
 * Shrink one image block in place and keep the inventory in sync.
 *
 * The wire block is the Anthropic shape `{ type: "image", source: { type: "base64",
 * media_type, data } }`. The media type has to follow the new payload - a PNG payload
 * announced as JPEG is a 400 from the upstream.
 */
async function downsampleImageBlock(
  entry: ImageInventoryEntry,
  options: { maxEdge: number },
): Promise<{ data: string; width: number; height: number; bytesBefore: number; bytesAfter: number } | null> {
  const block = entry.container[entry.index] as
    | { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } }
    | undefined;
  const source = block?.source;
  if (!source || typeof source.data !== "string") return null;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
  const result = await downsampleImagePayload(source.data, mediaType, options);
  if (!result) return null;
  source.media_type = result.mediaType;
  source.data = result.data;
  entry.data = result.data;
  return {
    data: result.data,
    width: result.width,
    height: result.height,
    bytesBefore: result.bytesBefore,
    bytesAfter: result.bytesAfter,
  };
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
export async function enforceUpstreamPromptBudget(
  body: unknown,
  limitTokens: number | undefined,
  options: PromptBudgetOptions = {},
): Promise<PromptBudgetResult> {
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
        imageDrops: [],
        imageDownsamples: [],
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
      imageDrops: [],
      imageDownsamples: [],
      overBudget: false,
    };
  }
  if (limitTokens === undefined || before.estimatedTokens <= limitTokens) {
    return {
      body,
      estimatedTokens: before.estimatedTokens,
      limitTokens: limitTokens ?? null,
      droppedImages: 0,
      imageDrops: [],
      imageDownsamples: [],
      overBudget: limitTokens !== undefined && before.estimatedTokens > limitTokens,
    };
  }

  const wire = parsed as { messages?: unknown[] };
  const budget = Math.floor(limitTokens * UPSTREAM_BUDGET_MARGIN);
  let dropped = 0;
  const imageDrops: ImageDropLog[] = [];
  const imageDownsamples: ImageDownsampleLog[] = [];

  // Step 1: an image we cannot bill as vision is billed as TEXT upstream. Drop those first —
  // they are the expensive ones (a 400KB "url" payload costs ~300k tokens as text).
  const inventory = collectImageInventory(wire);
  for (const ref of inventory.entries) {
    if (ref.kind === "native") continue;
    if (ref.payloadChars === 0) continue;
    ref.container[ref.index] = { type: "text", text: DROPPED_IMAGE_TEXT };
    dropped++;
  }

  // Step 2: still over budget — give up images by VALUE, not by age.
  //
  // The old rule was "oldest first". That is wrong in both directions: an old screenshot
  // may be the only record of the bug the user is chasing, and the newest one may be a
  // duplicate of it. The policy drops, in order: early-history duplicates, then early
  // history (biggest first), then recent turns. The CURRENT turn's images are never
  // dropped - those are what the user just attached.
  const plan = planImages(inventory, {
    providerName: options.providerName ?? "",
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    ...(options.preserveRecentTurns !== undefined ? { preserveRecentTurns: options.preserveRecentTurns } : {}),
  });
  // Phase 2 (optional): shrink an oversized image rather than give it up.
  const downsampleEnabled = options.imageDownsample === true;
  const targetMaxEdge = options.downsampleMaxEdge ?? targetMaxEdgeForFamily(plan.family);
  let guard = 0;
  while (guard++ < 200) {
    const current = measureAnthropicWireComposition(wire);
    if (current.estimatedTokens <= budget) break;
    const stillImages = (item: typeof plan.items[number]): boolean =>
      (item.entry.container[item.entry.index] as { type?: unknown } | undefined)?.type === "image";

    // 2a. A repeated payload is the cheapest thing we can give up: the same bytes are
    //     still in the request, so nothing is lost. It goes first.
    const duplicate = dropOrder(plan).find(
      (item) => item.tier === "P2-duplicate" && stillImages(item),
    );
    if (duplicate) {
      const reason = "dropped to fit the upstream context budget (duplicate of an earlier image)";
      duplicate.entry.container[duplicate.entry.index] = {
        type: "text",
        text: droppedImagePlaceholder(duplicate.entry, reason),
      };
      imageDrops.push(describeDrop(duplicate, reason));
      dropped++;
      continue;
    }

    // 2b. Still over budget: SHRINK the most expensive image instead of dropping it.
    //     The model keeps seeing the picture - just a smaller one.
    if (downsampleEnabled) {
      const candidate = plan.items
        .filter((item) => stillImages(item))
        .filter((item) => {
          const w = item.entry.width ?? 0;
          const h = item.entry.height ?? 0;
          return w > 0 && h > 0 && Math.max(w, h) > targetMaxEdge;
        })
        .sort((a, b) => b.estimate.tokens - a.estimate.tokens)[0];
      if (candidate) {
        const dimsBefore = candidate.entry.width && candidate.entry.height
          ? `${candidate.entry.width}x${candidate.entry.height}`
          : undefined;
        const tokensBefore = candidate.estimate.tokens;
        const outcome = await downsampleImageBlock(candidate.entry, { maxEdge: targetMaxEdge });
        if (outcome) {
          candidate.entry.width = outcome.width;
          candidate.entry.height = outcome.height;
          candidate.entry.payloadChars = outcome.data.length;
          candidate.estimate = estimateImageTokens(outcome.width, outcome.height, plan.family);
          imageDownsamples.push({
            ordinal: candidate.entry.ordinal,
            tier: candidate.tier,
            reason: "downscaled to fit the upstream context budget",
            ...(dimsBefore ? { dimensionsBefore: dimsBefore } : {}),
            dimensionsAfter: `${outcome.width}x${outcome.height}`,
            bytesBefore: outcome.bytesBefore,
            bytesAfter: outcome.bytesAfter,
            estimatedTokensBefore: tokensBefore,
            estimatedTokensAfter: candidate.estimate.tokens,
          });
          continue;
        }
      }
    }

    // 2c. Nothing left to shrink: give up images by policy value, not by position.
    let remaining = dropOrder(plan).filter(stillImages);
    if (remaining.length === 0) {
      // Everything except the current turn is gone and it still does not fit.
      // Now the current turn has to go too - a request that the upstream rejects
      // outright kills the whole turn, which is worse than losing the image.
      remaining = fallbackOrder(plan).filter(stillImages);
      if (remaining.length === 0) break;
    }
    const next = remaining[0];
    if (!next) break;
    const reason = next.tier === "P2-duplicate"
      ? "dropped to fit the upstream context budget (duplicate of an earlier image)"
      : next.tier === "P3-early-unique"
        ? "dropped to fit the upstream context budget (early history)"
        : "dropped to fit the upstream context budget (recent turn)";
    next.entry.container[next.entry.index] = {
      type: "text",
      text: droppedImagePlaceholder(next.entry, reason),
    };
    imageDrops.push(describeDrop(next, reason));
    dropped++;
  }

  const after = measureAnthropicWireComposition(wire);
  return {
    body: isString ? JSON.stringify(wire) : wire,
    estimatedTokens: after.estimatedTokens,
    limitTokens,
    droppedImages: dropped,
    imageDrops,
    imageDownsamples,
    overBudget: after.estimatedTokens > limitTokens,
  };
}
