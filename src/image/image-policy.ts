/**
 * Image retention policy: WHICH images to give up when the request does not fit.
 *
 * WHY "oldest first" is wrong: age is not value. The screenshot the user attached three
 * turns ago may be the only record of the bug they are still chasing, while the newest
 * one may be a screenshot of the same panel. Pure age-ordering also ignores the SIZE of
 * the image: it gives up a 200x200 icon before a 3000x2000 chart, even though the chart
 * is what actually blew the budget.
 *
 * The policy keeps FOUR tiers, and gives up images tier by tier, cheapest-value first:
 *
 *   P0  the CURRENT turn's images      - never dropped (the user just attached them)
 *   P1  the RECENT turns' images       - dropped last (a few turns of visual context)
 *   P2  early history, DUPLICATE payload - dropped first (same bytes = no new info)
 *   P3  early history, unique payload   - dropped next (old, and expensive)
 *
 * Within a tier, the LARGEST image goes first: it buys the most tokens per sacrifice.
 *
 * Phase 1 does not RESIZE anything (that needs a decoder); it only chooses WHICH images
 * to drop, and replaces each with a structured placeholder that tells the model what it
 * is missing instead of pretending the image was never there.
 */

import type { ImageInventory, ImageInventoryEntry } from "./image-inventory";
import {
  detectImageBillingFamily,
  estimateImageTokens,
  type ImageBillingFamily,
  type ImageEstimateMethod,
  type ImageTokenEstimate,
} from "./image-estimator";

/** How many recent turns keep their images at all. */
export const DEFAULT_PRESERVE_RECENT_TURNS = 4;

/**
 * Structured placeholder left in place of a dropped image.
 *
 * The old one-liner ("[image omitted: dropped to fit the upstream context budget]") told
 * the model nothing about WHAT was lost, so it often hallucinated around the gap. This
 * one states the dimensions, the turn it came from, and why it was dropped.
 */
export function droppedImagePlaceholder(entry: ImageInventoryEntry, reason: string): string {
  const dims = entry.width && entry.height ? `${entry.width}x${entry.height}` : "unknown size";
  return `[image omitted: ${reason}; ${dims}; turn ${entry.turnIndex}]`;
}

export type ImageTier = "P0-current-turn" | "P1-recent" | "P2-duplicate" | "P3-early-unique";

export interface ImagePolicyOptions {
  /** Provider name, for billing-family detection. */
  providerName: string;
  /** Model id, for billing-family detection. */
  modelId?: string;
  /** How many recent turns keep their images. */
  preserveRecentTurns?: number;
  /** The message index of the CURRENT turn (its images are never dropped). */
  currentTurnIndex?: number;
}

export interface ImagePlanEntry {
  entry: ImageInventoryEntry;
  tier: ImageTier;
  estimate: ImageTokenEstimate;
  /** True when this payload repeats an earlier image. */
  duplicate: boolean;
}

export interface ImagePlan {
  items: ImagePlanEntry[];
  family: ImageBillingFamily;
}

/**
 * Assign every image to a tier and price it.
 *
 * `currentTurnIndex` defaults to the last message that carries an image: whatever the
 * user attached most recently is the P0 tier.
 */
export function planImages(inventory: ImageInventory, opts: ImagePolicyOptions): ImagePlan {
  const family = detectImageBillingFamily(opts.providerName, opts.modelId);
  const preserve = Math.max(0, opts.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS);
  const native = inventory.entries.filter(e => e.kind === "native");
  const lastImageTurn = native.reduce((max, e) => Math.max(max, e.turnIndex), -1);
  const currentTurn = opts.currentTurnIndex ?? lastImageTurn;

  const items: ImagePlanEntry[] = native.map(entry => {
    const estimate = estimateImageTokens(entry.width, entry.height, family);
    const duplicate = entry.hash !== undefined
      && inventory.firstOccurrence.get(entry.hash) !== undefined
      && inventory.firstOccurrence.get(entry.hash) !== entry.ordinal;
    let tier: ImageTier;
    if (duplicate) {
      // A repeated payload carries NO new information - not even in the current turn.
      // It is the cheapest thing we can give up, so it goes first.
      tier = "P2-duplicate";
    } else if (entry.turnIndex >= currentTurn) {
      tier = "P0-current-turn";
    } else if (currentTurn - entry.turnIndex <= preserve) {
      tier = "P1-recent";
    } else {
      tier = "P3-early-unique";
    }
    return { entry, tier, estimate, duplicate };
  });
  return { items, family };
}

/**
 * The order in which images are sacrificed: lowest tier first, largest first inside a
 * tier, duplicates before uniques.
 *
 * P0 (the current turn) is NEVER in this list - the user just attached those, and
 * losing them loses the point of the request.
 */
export function dropOrder(plan: ImagePlan): ImagePlanEntry[] {
  const tierRank: Record<ImageTier, number> = {
    "P2-duplicate": 0,
    "P3-early-unique": 1,
    "P1-recent": 2,
    "P0-current-turn": 3,
  };
  return [...plan.items]
    .filter(item => item.tier !== "P0-current-turn")
    .sort((a, b) => {
      const rank = tierRank[a.tier] - tierRank[b.tier];
      if (rank !== 0) return rank;
      if (a.duplicate !== b.duplicate) return a.duplicate ? -1 : 1;
      // Biggest first: it buys the most tokens per sacrifice.
      return b.estimate.tokens - a.estimate.tokens;
    });
}

/**
 * Last-resort order: the CURRENT turn's images, biggest first.
 *
 * Used only when everything else is already gone and the request STILL does not fit
 * (e.g. one 4k screenshot alone exceeds the upstream window). Dropping the user's
 * current image is a real loss - but sending the request anyway means the upstream
 * 400s and the whole turn dies, which is worse. The brake has to brake.
 */
export function fallbackOrder(plan: ImagePlan): ImagePlanEntry[] {
  return plan.items
    .filter(item => item.tier === "P0-current-turn")
    .sort((a, b) => b.estimate.tokens - a.estimate.tokens);
}

/** One line per dropped image, for the request log. */
export interface ImageDropLog {
  ordinal: number;
  tier: ImageTier;
  reason: string;
  dimensions?: string;
  estimatedTokens: number;
  estimateMethod: ImageEstimateMethod;
  estimateConfidence: string;
  duplicate: boolean;
}

export function describeDrop(item: ImagePlanEntry, reason: string): ImageDropLog {
  return {
    ordinal: item.entry.ordinal,
    tier: item.tier,
    reason,
    ...(item.entry.width && item.entry.height
      ? { dimensions: `${item.entry.width}x${item.entry.height}` }
      : {}),
    estimatedTokens: item.estimate.tokens,
    estimateMethod: item.estimate.method,
    estimateConfidence: item.estimate.confidence,
    duplicate: item.duplicate,
  };
}
