/**
 * The gate circuit: what we do when the upstream keeps refusing the same request.
 *
 * WHY: Codex's recovery from an over-long prompt is to COMPACT and retry. When the upstream
 * refuses for a reason compaction cannot fix (the compacted history is still over the
 * upstream's ceiling), Codex compacts again, and again - an unbounded loop that keeps
 * spending upstream quota and never terminates. This is the second half of "cannot stop":
 * the first half is the brake (src/lib/upstream-prompt-budget.ts), this half is the STOP.
 *
 * THE RULE, and why it is shaped this way:
 *
 *  - We never PREDICT an overflow. A character/token estimate is wrong for CJK and for
 *    JSON-heavy prompts, and a wrong "no" kills a turn that would have worked. The upstream
 *    is the only authority on its own window, so it speaks first and we listen.
 *
 *  - A refusal is attributed to a CONVERSATION by the SIZE of the request that was refused,
 *    not by the route alone. Codex does not send a conversation id, and the route is shared
 *    by every thread of that provider: a per-route counter would be cleared by an unrelated
 *    small request that happens to succeed in between, and the loop we want to break would
 *    never break. So we compare sizes: a refusal of a request of size X arms the circuit for
 *    requests of roughly that size, and a request that is clearly SMALLER (compaction did
 *    its job) is let through.
 *
 *  - A success only clears the streak when it was a request of comparable size. A small
 *    success says nothing about the big ones - it is a different conversation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * How many comparable refusals arm the circuit.
 *
 * Three is the smallest number that separates "a conversation that needed one compact"
 * (one refusal, then success) from "a conversation that cannot get through" (refusal after
 * refusal, with no comparable success in between).
 */
export const GATE_CIRCUIT_THRESHOLD = 3;

/** How long the circuit stays armed before it cools down, in ms. */
export const GATE_CIRCUIT_TTL_MS = 90_000;

/**
 * How close together two refusals have to be to count as one streak, in ms.
 *
 * A compaction loop fires within seconds. Three unrelated failures spread over a day are
 * not a loop.
 */
export const GATE_CIRCUIT_WINDOW_MS = 600_000;

/**
 * How close two request sizes have to be to count as "the same kind of request".
 *
 * Below 0.5 the request got much smaller (compaction worked). Above 2 it grew (the
 * conversation moved on) - either way it is a different story.
 */
export const GATE_CIRCUIT_SIZE_BAND = 0.5;

/**
 * A request at least this fraction of the refused size counts as "as big as the one that
 * was refused". Below it, the request is small enough that the upstream might well take it.
 */
export const GATE_CIRCUIT_COMPARABLE_RATIO = 0.9;

/** What we learned from one upstream refusal. */
export interface GateRejectionInfo {
  /** The ceiling the upstream quoted, when it quoted one. */
  limit?: number;
  /** The request size the upstream quoted alongside the ceiling. */
  observedInputTokens?: number;
  /** True when the upstream refused for length but named no ceiling. */
  withoutLimit?: boolean;
  /** A short, already-redacted sample of the upstream's message. */
  sample?: string;
  /**
   * OUR estimate of the refused request (our tokenizer). This is the number we compare
   * later requests against, so it has to be in OUR units.
   */
  estimatedTokens?: number;
}

/**
 * The persisted record for one route (`<provider>/<model>`).
 *
 * "The upstream refused us for being too long, but did not say where its ceiling is" is a
 * FACT worth keeping - it is the difference between "we know the gate" and "we know the
 * request is over some gate we cannot name". Without it the operator sees an empty cell and
 * cannot tell "never observed" from "observed and told us nothing".
 */
export interface GateRejectionRecord {
  /** How many over-limit refusals we have seen for this route. */
  confirmedCount: number;
  /** How many of those named no ceiling. */
  withoutLimitCount: number;
  /** ISO timestamp of the first refusal. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent refusal. */
  lastSeenAt: string;
  /** The smallest ceiling the upstream ever quoted for this route. */
  limit?: number;
  /** The request size the upstream quoted alongside that ceiling. */
  observedInputTokens?: number;
  /** A short sample of the upstream's wording. */
  sample?: string;
  /**
   * The smallest request size (in OUR estimate) that the upstream refused on this route.
   * This is the baseline a new request is compared against.
   */
  minRefusedTokens?: number;
}

/** The live state of one route's circuit. */
export interface GateCircuitState {
  record: GateRejectionRecord;
  /** Comparable refusals in a row, with no comparable success in between. */
  consecutive: number;
  /** Epoch ms until which the circuit refuses to forward. */
  armedUntil: number;
  /** The baseline size a request has to match to be refused locally. */
  minRefusedTokens: number;
}

interface RouteState {
  consecutive: number;
  lastRefusalAt: number;
  lastRefusalSize: number;
  minRefusedSize: number;
  armedUntil: number;
}

const records = new Map<string, GateRejectionRecord>();
const states = new Map<string, RouteState>();

/** The key a route's record is stored under. */
function routeKey(providerKey: string, modelId?: string): string {
  return modelId ? `${providerKey}/${modelId}` : providerKey;
}

function sidecarPath(): string {
  // Imported lazily: config.ts pulls in zod and the whole config surface, and this module
  // sits on the request path.
  const { getConfigDir } = require("../config") as { getConfigDir: () => string };
  return join(getConfigDir(), "upstream-gate-circuit.json");
}

function normalizeRecord(value: unknown): GateRejectionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const confirmedCount = raw.confirmedCount;
  if (typeof confirmedCount !== "number" || !Number.isFinite(confirmedCount) || confirmedCount <= 0) {
    return undefined;
  }
  const withoutLimitCount =
    typeof raw.withoutLimitCount === "number" && Number.isFinite(raw.withoutLimitCount)
      ? raw.withoutLimitCount
      : 0;
  const firstSeenAt = typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : "";
  const lastSeenAt = typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : firstSeenAt;
  const limit = typeof raw.limit === "number" && Number.isFinite(raw.limit) && raw.limit > 0
    ? raw.limit
    : undefined;
  const observedInputTokens =
    typeof raw.observedInputTokens === "number" && Number.isFinite(raw.observedInputTokens)
      ? raw.observedInputTokens
      : undefined;
  const sample =
    typeof raw.sample === "string" && raw.sample.length > 0 ? raw.sample.slice(0, 300) : undefined;
  const minRefusedTokens =
    typeof raw.minRefusedTokens === "number" && Number.isFinite(raw.minRefusedTokens) && raw.minRefusedTokens > 0
      ? raw.minRefusedTokens
      : undefined;
  return {
    confirmedCount,
    withoutLimitCount,
    firstSeenAt,
    lastSeenAt,
    ...(limit !== undefined ? { limit } : {}),
    ...(observedInputTokens !== undefined ? { observedInputTokens } : {}),
    ...(sample !== undefined ? { sample } : {}),
    ...(minRefusedTokens !== undefined ? { minRefusedTokens } : {}),
  };
}

/**
 * Load the persisted refusal records.
 *
 * Explicit load/save (the server calls them): a module that wrote to disk on its own would
 * write into the operator's real config dir during `bun test`.
 */
export function loadGateCircuit(): void {
  try {
    const path = sidecarPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    const routes = record.routes;
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) return;
    for (const [key, value] of Object.entries(routes as Record<string, unknown>)) {
      const normalized = normalizeRecord(value);
      if (!normalized) continue;
      records.set(key, normalized);
      if (normalized.minRefusedTokens !== undefined) {
        states.set(key, {
          consecutive: 0,
          lastRefusalAt: 0,
          lastRefusalSize: normalized.minRefusedTokens,
          minRefusedSize: normalized.minRefusedTokens,
          armedUntil: 0,
        });
      }
    }
  } catch {
    /* no sidecar / unreadable -> we learn again */
  }
}

/** Persist the refusal records. Called after a NEW refusal is observed. */
export function saveGateCircuit(): void {
  try {
    const path = sidecarPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const routes: Record<string, GateRejectionRecord> = {};
    for (const [key, value] of records) routes[key] = value;
    writeFileSync(path, JSON.stringify({ version: 1, routes }, null, 2), "utf-8");
  } catch {
    /* diagnostics must never break the request path */
  }
}

/** The TTL the circuit uses, overridable for operators who need a longer stop. */
export function gateCircuitTtlMs(): number {
  const raw = process.env.OCX_GATE_CIRCUIT_TTL_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return GATE_CIRCUIT_TTL_MS;
}

/**
 * Record an upstream refusal for a route.
 *
 * Returns the live state so the caller can tell whether the circuit just armed.
 */
export function noteGateRejection(
  providerKey: string,
  modelId: string | undefined,
  info: GateRejectionInfo,
): GateCircuitState {
  const key = routeKey(providerKey, modelId);
  const now = new Date();
  const iso = now.toISOString();
  const prev = records.get(key);

  // The size we compare against is OUR estimate; the upstream's own quoted size is only a
  // fallback (it counts in the upstream's tokenizer, which is not ours).
  const size = info.estimatedTokens ?? info.observedInputTokens ?? 0;

  const record: GateRejectionRecord = {
    confirmedCount: (prev?.confirmedCount ?? 0) + 1,
    withoutLimitCount: (prev?.withoutLimitCount ?? 0) + (info.withoutLimit ? 1 : 0),
    firstSeenAt: prev?.firstSeenAt || iso,
    lastSeenAt: iso,
    // Keep the SMALLEST ceiling we ever saw: that is the one that actually bites.
    ...(info.limit !== undefined
      ? { limit: prev?.limit !== undefined ? Math.min(prev.limit, info.limit) : info.limit }
      : prev?.limit !== undefined
        ? { limit: prev.limit }
        : {}),
    ...(info.observedInputTokens !== undefined
      ? { observedInputTokens: info.observedInputTokens }
      : prev?.observedInputTokens !== undefined
        ? { observedInputTokens: prev.observedInputTokens }
        : {}),
    ...(info.sample !== undefined
      ? { sample: info.sample }
      : prev?.sample !== undefined
        ? { sample: prev.sample }
        : {}),
    ...(size > 0
      ? {
        minRefusedTokens: prev?.minRefusedTokens !== undefined
          ? Math.min(prev.minRefusedTokens, size)
          : size,
      }
      : prev?.minRefusedTokens !== undefined
        ? { minRefusedTokens: prev.minRefusedTokens }
        : {}),
  };
  records.set(key, record);

  // The streak: comparable refusals, close in time, of a comparable size.
  const prevState = states.get(key);
  let streak = 1;
  if (prevState && now.getTime() - prevState.lastRefusalAt <= GATE_CIRCUIT_WINDOW_MS) {
    const sameBand =
      size === 0 || prevState.lastRefusalSize === 0
        ? true
        : size >= prevState.lastRefusalSize * GATE_CIRCUIT_SIZE_BAND
          && size <= prevState.lastRefusalSize / GATE_CIRCUIT_SIZE_BAND;
    if (sameBand) streak = prevState.consecutive + 1;
  }
  const minRefusedSize =
    prevState && prevState.minRefusedSize > 0 && size > 0
      ? Math.min(prevState.minRefusedSize, size)
      : size > 0
        ? size
        : prevState?.minRefusedSize ?? 0;
  const armedUntil =
    streak >= GATE_CIRCUIT_THRESHOLD
      ? now.getTime() + gateCircuitTtlMs()
      : prevState?.armedUntil ?? 0;
  states.set(key, {
    consecutive: streak,
    lastRefusalAt: now.getTime(),
    lastRefusalSize: size > 0 ? size : prevState?.lastRefusalSize ?? 0,
    minRefusedSize,
    armedUntil,
  });

  return { record, consecutive: streak, armedUntil, minRefusedTokens: minRefusedSize };
}

/**
 * Record a SUCCESSFUL request for a route.
 *
 * A success only clears the streak when it was a request of comparable size: a small
 * success belongs to a different conversation and says nothing about the big one that is
 * being refused. A comparable success, on the other hand, proves the route takes requests
 * of that size - so the upstream's ceiling moved and the streak is void.
 */
export function noteGateSuccess(
  providerKey: string,
  modelId: string | undefined,
  estimatedTokens = 0,
): void {
  const key = routeKey(providerKey, modelId);
  const state = states.get(key);
  if (!state) return;
  if (state.minRefusedSize > 0 && estimatedTokens >= state.minRefusedSize * GATE_CIRCUIT_COMPARABLE_RATIO) {
    states.set(key, { ...state, consecutive: 0, armedUntil: 0 });
  }
}

/** The live state of a route's circuit. */
export function gateCircuitState(providerKey: string, modelId?: string): GateCircuitState | undefined {
  const key = routeKey(providerKey, modelId);
  const record = records.get(key);
  const state = states.get(key);
  if (!record && !state) return undefined;
  return {
    record: record ?? {
      confirmedCount: 0,
      withoutLimitCount: 0,
      firstSeenAt: "",
      lastSeenAt: "",
    },
    consecutive: state?.consecutive ?? 0,
    armedUntil: state?.armedUntil ?? 0,
    minRefusedTokens: state?.minRefusedSize ?? record?.minRefusedTokens ?? 0,
  };
}

/** What the circuit decided about one request. */
export interface GateCircuitVerdict {
  /** True when the request must not be forwarded. */
  refuse: boolean;
  /** How many comparable refusals we have seen. */
  consecutive: number;
  /** The size baseline the request was compared against. */
  baselineTokens: number;
  /** The estimated size of the request in question. */
  estimatedTokens: number;
}

/**
 * Ask the circuit whether this request may go upstream.
 *
 * `estimatedTokens` is OUR estimate of the request about to be sent; `gateTokens` is the
 * upstream's ceiling when we know it. The request is refused when it is at least as big as
 * the smallest request the upstream already refused on this route - that is the one piece
 * of evidence we have that it will be refused again.
 */
export function gateCircuitVerdictFor(
  providerKey: string,
  modelId: string | undefined,
  estimatedTokens: number,
  now = Date.now(),
): GateCircuitVerdict {
  const key = routeKey(providerKey, modelId);
  const state = states.get(key);
  const base = {
    consecutive: state?.consecutive ?? 0,
    baselineTokens: state?.minRefusedSize ?? 0,
    estimatedTokens,
  };
  if (!state || state.consecutive < GATE_CIRCUIT_THRESHOLD) {
    return { ...base, refuse: false };
  }
  if (state.armedUntil === 0 || now >= state.armedUntil) {
    // Cooled down: forget the streak so the next refusal starts counting again.
    states.set(key, { ...state, consecutive: 0, armedUntil: 0 });
    return { ...base, refuse: false };
  }
  // The baseline is the smallest request the upstream refused on this route, measured in OUR
  // tokenizer - the same unit as `estimatedTokens`. The upstream's own ceiling is NOT mixed
  // in: it is counted in the UPSTREAM's tokenizer, and comparing it against our estimate
  // would be the tokenizer mismatch this whole module exists to avoid (our meter said 200k
  // where the upstream counted 1.58M, because base64 image payloads are billed as text
  // upstream). Two numbers in two tokenizers never belong on the same scale.
  const baseline = state.minRefusedSize;
  if (baseline <= 0) {
    // No size to compare against: refuse while the circuit is hot.
    return { ...base, baselineTokens: 0, refuse: true };
  }
  const comparable = estimatedTokens <= 0
    ? true
    : estimatedTokens >= baseline * GATE_CIRCUIT_COMPARABLE_RATIO;
  return { ...base, baselineTokens: baseline, refuse: comparable };
}

/** True when the circuit is armed, whatever the request size. */
export function isGateCircuitArmed(providerKey: string, modelId?: string, now = Date.now()): boolean {
  const key = routeKey(providerKey, modelId);
  const state = states.get(key);
  if (!state || state.consecutive < GATE_CIRCUIT_THRESHOLD) return false;
  if (state.armedUntil === 0) return false;
  if (now >= state.armedUntil) {
    states.set(key, { ...state, consecutive: 0, armedUntil: 0 });
    return false;
  }
  return true;
}

/** The persisted refusal record of a route, if we have one. */
export function gateRejectionRecord(
  providerKey: string,
  modelId?: string,
): GateRejectionRecord | undefined {
  return records.get(routeKey(providerKey, modelId));
}

/** Every route we have a refusal record for, for display. */
export function allGateRejectionRecords(): Array<{
  key: string;
  provider: string;
  model?: string;
  record: GateRejectionRecord;
}> {
  const out: Array<{ key: string; provider: string; model?: string; record: GateRejectionRecord }> = [];
  for (const [key, record] of records) {
    const idx = key.indexOf("/");
    const provider = idx < 0 ? key : key.slice(0, idx);
    const model = idx < 0 ? undefined : key.slice(idx + 1);
    out.push({ key, provider, ...(model !== undefined ? { model } : {}), record });
  }
  return out;
}

/** Test seam: forget everything we recorded. */
export function resetGateCircuit(): void {
  records.clear();
  states.clear();
}
