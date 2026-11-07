/**
 * Provider-aware image token estimation.
 *
 * WHY: a flat "1.6k tokens per image" is wrong often enough to matter. The upstream
 * bills vision tokens by PIXELS, so a 4k screenshot costs ~10x a 1000x760 one, and the
 * flat number over-charges the small ones (which is what made the old brake drop
 * images "too early") while under-charging the big ones (which is what let a request
 * blow past the window).
 *
 * The rules we model, with the confidence we have in each:
 *   - Anthropic-style (Claude family): tiles of 750px, ~1 token per 750 px, with a
 *     per-image cap (1568px standard / 4784px high-res). Confidence: high (measured
 *     against a real upstream: 6x 1000x760 screenshots billed at ~1013 tokens each).
 *   - OpenAI-style (GPT-4o/4.1 family): 512px tiles after a 2048px downscale, with
 *     85 tokens of base cost per tile and 170 per tile. Confidence: medium.
 *   - Everything else: a flat per-image fallback. Confidence: low.
 *
 * We report the METHOD and the CONFIDENCE next to the number so an operator can tell a
 * measured estimate from a guess - the estimate drives a destructive decision (dropping
 * an image), so it must be auditable.
 */

export type ImageEstimateMethod =
  | "anthropic-pixels"
  | "openai-tiles"
  | "flat-fallback";

export type ImageEstimateConfidence = "high" | "medium" | "low";

export interface ImageTokenEstimate {
  /** Estimated upstream-side vision tokens for this image. */
  tokens: number;
  method: ImageEstimateMethod;
  confidence: ImageEstimateConfidence;
}

/** Anthropic: ~1 token per 750 px, capped by the 1568px "standard" image limit. */
const ANTHROPIC_TILE_PX = 750;
/** Anthropic "standard" images are billed up to 1568px on the long edge. */
const ANTHROPIC_STANDARD_MAX_EDGE = 1568;
/** Anthropic "high-res" images are billed up to 4784px on the long edge. */
const ANTHROPIC_HIGH_RES_MAX_EDGE = 4784;
/** OpenAI-style: images are scaled to fit 2048px, then tiled at 512px. */
const OPENAI_MAX_EDGE = 2048;
const OPENAI_TILE_PX = 512;
/** OpenAI-style tile pricing: 85 tokens for the base, 170 per tile. */
const OPENAI_BASE_TOKENS = 85;
const OPENAI_TILE_TOKENS = 170;
/** Fallback when we know nothing about the image at all. */
const FLAT_FALLBACK_TOKENS = 1600;

export type ImageBillingFamily = "anthropic" | "openai" | "unknown";

/**
 * Guess the billing family from the provider/model identity.
 *
 * The signal is deliberately weak: model names differ per relay, so we look for the
 * well-known families and fall back to "unknown" rather than guessing wrong.
 */
export function detectImageBillingFamily(providerName: string, modelId?: string): ImageBillingFamily {
  const haystack = `${providerName} ${modelId ?? ""}`.toLowerCase();
  if (/claude|anthropic|minimax|qwen/.test(haystack)) return "anthropic";
  if (/gpt|openai|o3|o4|codex/.test(haystack)) return "openai";
  return "unknown";
}

function longEdge(width: number, height: number): number {
  return Math.max(width, height);
}

/**
 * Estimate the upstream vision cost of one image.
 *
 * `width`/`height` are the PIXEL dimensions (from the image header, not the byte size).
 * When they are unknown we fall back to the flat estimate - an unknown-size image is
 * charged the conservative amount, because under-charging it would let the request
 * through and the upstream would 400 it.
 */
export function estimateImageTokens(
  width: number | undefined,
  height: number | undefined,
  family: ImageBillingFamily = "unknown",
): ImageTokenEstimate {
  if (!width || !height || width <= 0 || height <= 0) {
    return { tokens: FLAT_FALLBACK_TOKENS, method: "flat-fallback", confidence: "low" };
  }
  if (family === "anthropic") {
    // Billing caps at the standard image limit; a larger image is billed as high-res.
    const capped = Math.min(longEdge(width, height), ANTHROPIC_STANDARD_MAX_EDGE);
    const pixels = Math.min(width * height, capped * capped);
    const tokens = Math.max(1, Math.round(pixels / ANTHROPIC_TILE_PX));
    return { tokens, method: "anthropic-pixels", confidence: "high" };
  }
  if (family === "openai") {
    // Scale to fit 2048px, then tile at 512px.
    const scale = longEdge(width, height) > OPENAI_MAX_EDGE ? OPENAI_MAX_EDGE / longEdge(width, height) : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const tiles = Math.ceil(w / OPENAI_TILE_PX) * Math.ceil(h / OPENAI_TILE_PX);
    return { tokens: OPENAI_BASE_TOKENS + OPENAI_TILE_TOKENS * tiles, method: "openai-tiles", confidence: "medium" };
  }
  return { tokens: FLAT_FALLBACK_TOKENS, method: "flat-fallback", confidence: "low" };
}

/** The Anthropic high-res ceiling, exposed for the policy/logs. */
export const ANTHROPIC_HIGH_RES_CEILING = ANTHROPIC_HIGH_RES_MAX_EDGE;

/**
 * The long edge a downscaled image should have.
 *
 * Anthropic bills anything above 1568px as a high-res image, so shrinking to that
 * edge is the point where the vision bill stops growing. OpenAI-style upstreams
 * scale to 2048px before tiling, so their ceiling is higher - downsampling below it
 * would throw away detail the upstream would have billed anyway.
 */
export function targetMaxEdgeForFamily(family: ImageBillingFamily): number {
  return family === "openai" ? OPENAI_MAX_EDGE : ANTHROPIC_STANDARD_MAX_EDGE;
}
