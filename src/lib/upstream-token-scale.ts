/**
 * The scale factor between OUR token estimate and the UPSTREAM's own count.
 *
 * WHY: the proxy's brake compares "how big is this request" against "how big can this
 * upstream go". Both numbers have to be in the SAME unit, and today they are not:
 *
 *   - we estimate with a character heuristic (3 chars/token for prose, the pixel rule
 *     for images);
 *   - the upstream counts with ITS tokenizer, over ITS own wire shape.
 *
 * Measured on the failing thread (2026-11-09, m.aiio.chat / MiniMax-M3.1-Flash):
 *
 *   our estimate       498,000 tokens
 *   upstream reported 2,010,775 tokens   ("prompt is too long: 2010775 tokens > 1048576")
 *   ratio              4.04x
 *
 * With a 4x underestimate the brake believes a 2M-token request is a 500k-token request,
 * so it never brakes - the request goes out and the upstream refuses it. Then Codex
 * compacts, and the loop repeats. The circuit stops the loop, but the turn still dies.
 *
 * WHAT: the upstream's own refusal text names BOTH numbers - the size it was asked to
 * handle AND the ceiling it enforces. That is a free, authoritative calibration point:
 * one refusal teaches us the ratio for that provider, and the NEXT request is braked
 * correctly instead of being sent into the same wall.
 *
 * The factor is per provider (not per request): the tokenizer that counted the refusal
 * is the tokenizer that counts the next request. It is kept as the MAXIMUM ratio ever
 * observed, because the safe direction is to over-estimate - a too-large estimate
 * degrades an image early, a too-small one sends a doomed request.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * How far the upstream's count may differ from ours before we believe it.
 *
 * Below 1.5x our estimate is close enough that a learned factor would be noise; above
 * 8x something structurally different is happening (the upstream is billing the body as
 * text, not vision) and the factor is capped so one weird refusal cannot wedge the
 * proxy into refusing everything.
 */
export const MIN_LEARNED_SCALE = 1.5;
export const MAX_LEARNED_SCALE = 8;

export interface LearnedScale {
  /** upstream tokens divided by our estimate. */
  factor: number;
  /** The upstream's own count for the request that taught us this. */
  observedInputTokens: number;
  /** OUR estimate for that same request. */
  estimatedTokens: number;
  /** ISO timestamp of the observation. */
  observedAt: string;
  /** ISO timestamp of the most recent sighting. */
  lastSeenAt: string;
}

const learnedScales = new Map<string, LearnedScale>();

function scalesPath(): string {
  const { getConfigDir } = require("../config") as { getConfigDir: () => string };
  return join(getConfigDir(), "upstream-token-scales.json");
}

/** Load the persisted factors. Called once at server start. */
export function loadLearnedScales(): void {
  try {
    const path = scalesPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    const scales = record.scales;
    if (!scales || typeof scales !== "object" || Array.isArray(scales)) return;
    for (const [key, value] of Object.entries(scales as Record<string, unknown>)) {
      const scale = normalizeScale(value);
      if (scale) learnedScales.set(key, scale);
    }
  } catch {
    /* no sidecar / unreadable -> we learn again */
  }
}

/** Persist the factors. Called after a new one is learned. */
export function saveLearnedScales(): void {
  try {
    const path = scalesPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const scales: Record<string, LearnedScale> = {};
    for (const [key, scale] of learnedScales) scales[key] = scale;
    writeFileSync(path, JSON.stringify({ version: 1, scales }, null, 2), "utf-8");
  } catch {
    /* diagnostics must never break the request path */
  }
}

function normalizeScale(value: unknown): LearnedScale | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const factor = raw.factor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return undefined;
  const observedInputTokens = typeof raw.observedInputTokens === "number" ? raw.observedInputTokens : 0;
  const estimatedTokens = typeof raw.estimatedTokens === "number" ? raw.estimatedTokens : 0;
  const observedAt = typeof raw.observedAt === "string" ? raw.observedAt : "";
  const lastSeenAt = typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : observedAt;
  return { factor, observedInputTokens, estimatedTokens, observedAt, lastSeenAt };
}

/**
 * Record one calibration point.
 *
 * Returns the learned factor, or undefined when the observation is not usable (our
 * estimate was zero, or the two numbers agree closely enough that no factor is needed).
 */
export function noteUpstreamTokenScale(
  providerKey: string,
  observedInputTokens: number | undefined,
  estimatedTokens: number,
): LearnedScale | undefined {
  if (!providerKey) return undefined;
  if (!Number.isFinite(observedInputTokens ?? 0) || (observedInputTokens ?? 0) <= 0) return undefined;
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return undefined;
  const observed = observedInputTokens as number;
  const factor = observed / estimatedTokens;
  if (!Number.isFinite(factor) || factor <= 0) return undefined;
  // A factor below MIN means our estimate is close enough; keep whatever we already
  // learned rather than replacing a good factor with a noisier one.
  if (factor < MIN_LEARNED_SCALE) return learnedScales.get(providerKey);
  const capped = Math.min(factor, MAX_LEARNED_SCALE);
  const now = new Date().toISOString();
  const prev = learnedScales.get(providerKey);
  const next: LearnedScale = {
    factor: prev ? Math.max(prev.factor, capped) : capped,
    observedInputTokens: observed,
    estimatedTokens,
    observedAt: prev?.observedAt ?? now,
    lastSeenAt: now,
  };
  learnedScales.set(providerKey, next);
  return next;
}

/** The learned factor for a provider, if any. */
export function learnedTokenScale(providerKey: string): LearnedScale | undefined {
  if (!providerKey) return undefined;
  return learnedScales.get(providerKey);
}

/**
 * The factor to apply to OUR estimate so it speaks the upstream's unit.
 *
 * 1 when nothing is known (the estimate stands on its own), otherwise the learned factor.
 */
export function upstreamTokenScaleFactor(providerKey: string): number {
  return learnedScales.get(providerKey)?.factor ?? 1;
}

/** Every learned factor, for display. */
export function allLearnedScales(): Array<{ provider: string; scale: LearnedScale }> {
  return [...learnedScales.entries()].map(([provider, scale]) => ({ provider, scale }));
}

/** Test seam: forget everything we learned. */
export function resetLearnedTokenScales(): void {
  learnedScales.clear();
}
