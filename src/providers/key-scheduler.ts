/**
 * Quota-aware proactive key scheduling ("A+B" strategy: 5h-threshold gate + expiry-urgency
 * ranking), the proactive twin of key-failover.ts's reactive 429 rotation.
 *
 * Problem: with per-call billing, every key owns independent quota accounts — a rolling 5h
 * window (burst cap, per-key trigger times) and a calendar-week budget (shared Monday 00:00
 * reset), plus a per-key expiry (use-it-or-lose-it). Single-active-key routing burns one key
 * into the 5h wall while its siblings idle; 429 failover only learns about saturation by
 * failing, and its ≤10min cooldown cannot express "this key's 5h window is full".
 *
 * Strategy (agreed shape):
 *   - GATE: before a request is dispatched, estimate the ACTIVE key's 5h utilization as
 *     (probeUsed + locallyCountedCalls) / limit. Below threshold → do nothing (sticky).
 *   - RANK: when the gate trips, pick the next key by expiry urgency —
 *     remainingWeekly / min(daysToExpiry, daysToWeeklyReset) — so quota on sooner-dying keys
 *     is burned first. Keys that are weekly-exhausted, already expired, in 429 cooldown, or
 *     themselves over the 5h gate are not candidates.
 *   - STICKINESS: no per-request round-robin (each rotation costs one cold prompt-cache
 *     prefill upstream). New conversations simply land on whatever key is currently active.
 *   - DEGRADATION: probe failure / unknown data → no-op; the reactive 429 path is the
 *     backstop and stays untouched.
 *
 * Quota source is pluggable in principle; v1 only minimax.chat reverse proxies expose
 * /v1/usage, so scheduling is limited to them (isMinimaxChatReverseProxy).
 */
import { saveConfig } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isKeyInCooldown, markKeyReturnCooldown } from "./key-failover";
import { RETURN_COOLDOWN_MS } from "./key-failover";
import { isMinimaxChatReverseProxy, probeMinimaxKeyQuotas } from "./quota";
import type { ProviderQuotaKey } from "./quota";

/** Per-provider dedup of the "[all keys saturated]" warning so concurrent requests
 * don't spam the log. Reset whenever a successful rotation lands. */
const saturationWarnTs = new Map<string, number>();
const SATURATION_WARN_RESYNC_MS = 60_000;

/** Circuit-breaker (Layer 3) warning. Emitted when every candidate is gated out so the
 * operator knows the proxy is about to start serving with no real key-switching headroom.
 * Deduped per-provider with a 60s resync window; concurrent requests won't pile on. */
function maybeEmitSaturationWarning(providerName: string, now: number): void {
  const last = saturationWarnTs.get(providerName) ?? 0;
  if (now - last < SATURATION_WARN_RESYNC_MS) return;
  saturationWarnTs.set(providerName, now);
  console.warn(
    `[key-scheduler] ${providerName}: circuit-breaker — every alternative key is gated ` +
    `(expired / weekly-exhausted / in cooldown). The active key will keep serving until ` +
    `a candidate clears, or until upstream 429s.`,
  );
}

export interface KeyRotationEvent {
  ts: number;
  provider: string;
  fromId: string;
  toId: string;
  reason: "5h-threshold";
  /** Utilization (0-1) of the key rotated away from, including local-call estimates. */
  fromFiveHourEst?: number;
  /** Same estimate for the key rotated to. */
  toFiveHourEst?: number;
  /** 5h window reset of the exhausted key — when it becomes eligible again. */
  fiveHourResetAt?: number;
}

export interface KeyScheduleState {
  enabled: boolean;
  threshold: number;
  activeId: string | null;
  /** Best-ranked standby key, computed from the cached probe; null when unknown. */
  nextUpId: string | null;
  events: KeyRotationEvent[];
  /** Mirror of provider.pendingKeyChange; non-null when a staged rotation is awaiting commit. */
  pendingKeyChange?: import("../types").PendingKeyChange;
}

const DEFAULT_THRESHOLD = 0.85;
const PROBE_TTL_MS = 120_000;
const EVENT_CAP = 50;

/** Per-provider probe cache. Fresh fetches reset local call counters (they're now included). */
const probeCache = new Map<string, { ts: number; keys: ProviderQuotaKey[] }>();
/** Calls dispatched since the last probe, keyed `${provider} ${keyId}` (space separator). */
const localCalls = new Map<string, number>();
/** Rotation event ring buffers per provider. */
const rotationEvents = new Map<string, KeyRotationEvent[]>();

function localKey(providerName: string, keyId: string): string {
  return `${providerName} ${keyId}`;
}

function thresholdFor(provider: OcxProviderConfig): number {
  const configured = provider.keySchedule?.threshold;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_THRESHOLD;
  return Math.min(0.99, Math.max(0.5, configured));
}

/** Estimated 5h utilization (0-1) including locally counted calls; undefined when no data. */
function estFiveHour(key: ProviderQuotaKey, providerName: string): number | undefined {
  if (key.fiveHourUsed === undefined || key.fiveHourLimit === undefined || key.fiveHourLimit <= 0) return undefined;
  return (key.fiveHourUsed + (localCalls.get(localKey(providerName, key.id)) ?? 0)) / key.fiveHourLimit;
}

function daysUntil(ts: number | undefined, now: number): number | undefined {
  return ts === undefined ? undefined : (ts - now) / 86_400_000;
}

/**
 * Expiry urgency: remaining weekly calls per remaining usable day. Higher → burn first.
 * Horizon is the nearer of key expiry and weekly reset (weekly resets do not help a key
 * that dies first). Floor of half a day so same-day expiries dominate.
 */
function expiryUrgency(key: ProviderQuotaKey, now: number): number {
  if (key.weeklyUsed === undefined || key.weeklyLimit === undefined) return 0;
  const remaining = key.weeklyLimit - key.weeklyUsed;
  const horizon = Math.max(0.5, Math.min(daysUntil(key.expiresAt, now) ?? Infinity, daysUntil(key.weeklyResetAt, now) ?? Infinity));
  return remaining / horizon;
}

/** True when the key can serve at all tomorrow-or-later: not weekly-exhausted, not expired. */
function isServiceable(key: ProviderQuotaKey, now: number): boolean {
  if (key.weeklyUsed !== undefined && key.weeklyLimit !== undefined && key.weeklyLimit > 0 && key.weeklyUsed >= key.weeklyLimit) return false;
  const dExp = daysUntil(key.expiresAt, now);
  if (dExp !== undefined && dExp <= 0) return false;
  return true;
}

/**
 * Pure candidate picker (exported for tests). Returns the id of the best standby key, or
 * null when every alternative is gated out. The caller decides WHETHER to rotate; this only
 * answers WHO next.
 */
export function pickNextKey(
  keys: ProviderQuotaKey[],
  providerName: string,
  activeId: string | null,
  threshold: number,
  now: number,
  inCooldown: (keyId: string) => boolean,
  estimate: (key: ProviderQuotaKey) => number | undefined = k => estFiveHour(k, providerName),
): string | null {
  const candidates = keys.filter(key => {
    if (key.id === activeId) return false;
    if (!isServiceable(key, now)) return false;
    if (inCooldown(key.id)) return false;
    const est = estimate(key);
    return est === undefined || est < threshold; // unknown 5h data → allow (benefit of doubt)
  });
  if (candidates.length === 0) return null;
  const ranked = candidates.map(key => ({
    key,
    urgency: expiryUrgency(key, now),
    headroom: 1 - (estimate(key) ?? 0),
  }));
  ranked.sort((a, b) => (b.urgency - a.urgency) || (b.headroom - a.headroom));
  return ranked[0]!.key.id;
}

/**
 * Watchdog ranking (Layer 1 of the ping-pong fix). Returns the id of the BEST key in the
 * pool — where "best" = lowest estimated 5h usage, with the active key winning ties.
 *
 * Unlike `pickNextKey` this INCLUDES the active key, so the caller can answer the question
 * "am I the best of the bunch, or is there a strictly better candidate?". If the answer
 * is "I'm the best", a rotation is a zero-improvement move that just opens the door to
 * thrash — the watchdog vetoes it.
 *
 * Two semantic differences from `pickNextKey`:
 *   - Serviceability + cooldown filters still apply (expired / weekly-dead / 429-cooldown
 *     keys never win), but the threshold filter does NOT — we want to rank everyone.
 *   - Unknown estimates rank LAST (headroom = -Infinity), pessimistically. This is the
 *     opposite of `pickNextKey`'s "benefit of doubt" rule, because here "allow unknown"
 *     would mean "let it block a known-good key from winning".
 */
export function pickBestKeyId(
  keys: ProviderQuotaKey[],
  providerName: string,
  activeId: string | null,
  now: number,
  inCooldown: (keyId: string) => boolean,
  estimate: (key: ProviderQuotaKey) => number | undefined = k => estFiveHour(k, providerName),
): string | null {
  const candidates = keys.filter(key => {
    if (!isServiceable(key, now)) return false;
    if (inCooldown(key.id)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const ranked = candidates.map(key => {
    const est = estimate(key);
    return {
      key,
      isActive: key.id === activeId,
      urgency: expiryUrgency(key, now),
      // unknown → -Infinity → sorts last (pessimistic)
      headroom: est === undefined ? -Infinity : 1 - est,
    };
  });
  ranked.sort((a, b) => {
    // Primary: lower estimated usage first (headroom descending) — this is the real
    // "which key should we use" question.
    if (a.headroom !== b.headroom) return b.headroom - a.headroom;
    // Secondary: more-urgent expiry first (mirror `pickNextKey` policy).
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    // Final tiebreaker: active wins when all else is equal — provides natural
    // hysteresis on equal-utilization comparisons (both A and B at 87% → don't
    // switch for nothing). Without this, equal-estimate rankings would be
    // determined by sort stability alone, which is JS-engine-dependent.
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.headroom - a.headroom;
  });
  return ranked[0]!.key.id;
}

async function probeKeysCached(providerName: string, provider: OcxProviderConfig, now: number): Promise<ProviderQuotaKey[] | null> {
  const cached = probeCache.get(providerName);
  if (cached && now - cached.ts < PROBE_TTL_MS) return cached.keys;
  const keys = await probeImpl(provider);
  if (!keys) return null;
  probeCache.set(providerName, { ts: now, keys });
  // Fresh probe already includes everything dispatched before it; reset local counters.
  for (const mapKey of [...localCalls.keys()]) {
    if (mapKey.startsWith(`${providerName} `)) localCalls.delete(mapKey);
  }
  return keys;
}

// Indirection so tests can stub the network probe.
let probeImpl: (provider: OcxProviderConfig) => Promise<ProviderQuotaKey[] | null> = probeMinimaxKeyQuotas;
export function _setProbeForTests(impl: typeof probeImpl | null): void {
  probeImpl = impl ?? probeMinimaxKeyQuotas;
}

/** Record one billable upstream dispatch for the rolling local estimate between probes. */
export function recordRoutedCall(providerName: string, keyId: string): void {
  if (!keyId) return;
  const mapKey = localKey(providerName, keyId);
  localCalls.set(mapKey, (localCalls.get(mapKey) ?? 0) + 1);
}

function activePoolEntry(provider: OcxProviderConfig): { id: string; key: string } | null {
  const pool = provider.apiKeyPool ?? [];
  if (pool.length === 0) return null;
  return pool.find(e => e.key === provider.apiKey) ?? pool[0]!;
}

/**
 * Pre-request scheduling gate. Returns true when the active key was rotated (config already
 * swapped + persisted). Never throws — scheduling is best-effort; any failure leaves routing
 * exactly as it was, with the reactive 429 path as backstop.
 */
export async function maybeRotateForQuota(config: OcxConfig, providerName: string, now = Date.now()): Promise<boolean> {
  const provider = config.providers[providerName];
  if (!provider || provider.disabled === true) return false;
  if (provider.keySchedule?.enabled === false) return false;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  const pool = provider.apiKeyPool;
  if (!pool || pool.length < 2) return false;
  if (!isMinimaxChatReverseProxy(providerName, provider)) return false;

  const threshold = thresholdFor(provider);
  let keys: ProviderQuotaKey[] | null;
  try {
    keys = await probeKeysCached(providerName, provider, now);
  } catch {
    return false; // probe failure → reactive 429 backstop
  }
  if (!keys || keys.length === 0) return false;

  const active = activePoolEntry(provider);
  if (!active) return false;
  const activeQuota = keys.find(k => k.id === active.id);
  if (!activeQuota) return false;
  const activeEst = estFiveHour(activeQuota, providerName);
  if (activeEst === undefined || activeEst < threshold) return false;

  // Watchdog (Layer 1) + return-cooldown (Layer 2) + circuit breaker (Layer 3).
  //
  // `pickBestKeyId` includes the active key in the ranking. If the active key is still
  // the best of the bunch despite being over threshold, we DON'T rotate — that's the
  // watchdog veto. Keys that the local scheduler just rotated from are excluded by
  // `markKeyReturnCooldown` so a flip-flopping A→B→A is impossible in the cooldown
  // window. If `pickBestKeyId` returns null, every candidate is gated out (expired,
  // weekly-dead, or in cooldown) — that's the circuit breaker: stay put + warn once.
  const toId = pickBestKeyId(keys, providerName, active.id, now, id => isKeyInCooldown(providerName, id, now));
  if (!toId) {
    maybeEmitSaturationWarning(providerName, now);
    return false;
  }
  if (toId === active.id) {
    // Watchdog veto: the active key is rank #1 even though it's over threshold.
    // No rotation; keep burning this key until something strictly better shows up.
    return false;
  }
  const next = pool.find(e => e.id === toId);
  if (!next) return false;

 const toQuota = keys.find(k => k.id === toId);
  // Pending mode: stage the change instead of mutating. The dispatch for the
  // current request continues with the existing apiKey; commitPendingKeyChange
  // (called by responses.ts when the dispatch stream closes) applies the swap.
  // This prevents mid-stream cuts that surface as CodexPlusPlus 100s
  // upstream_stall_timeout aborts.
  const pending: PendingKeyChange = {
    keyId: toId,
    key: next.key,
    ts: now,
    reason: "5h-threshold",
  };
  provider.pendingKeyChange = pending;
  // Layer 2: pin the key we just rotated from out of candidates for `RETURN_COOLDOWN_MS`.
  // The pendingKeyChange commits when the current stream closes; until then, even if
  // the destination key's localCalls push it over threshold, `isKeyInCooldown` will
  // block the just-rotated-from key from being picked as the next target.
  markKeyReturnCooldown(providerName, active.id, RETURN_COOLDOWN_MS, now);
  // Reset saturation-warn dedup so the next "all gated" event re-logs.
  saturationWarnTs.delete(providerName);
  for (const entry of pool) {
    entry.active = entry.id === toId;
  }

  const event: KeyRotationEvent = {
    ts: now,
    provider: providerName,
    fromId: active.id,
    toId,
    reason: "5h-threshold",
    fromFiveHourEst: Math.round(activeEst * 1000) / 1000,
    ...(toQuota ? { toFiveHourEst: Math.round((estFiveHour(toQuota, providerName) ?? 0) * 1000) / 1000 } : {}),
    ...(activeQuota.fiveHourResetAt !== undefined ? { fiveHourResetAt: activeQuota.fiveHourResetAt } : {}),
  };
  const list = rotationEvents.get(providerName) ?? [];
  list.push(event);
  if (list.length > EVENT_CAP) list.splice(0, list.length - EVENT_CAP);
  rotationEvents.set(providerName, list);

  console.warn(
    `[key-scheduler] ${providerName}: active key ${active.id} 5h at ${(activeEst * 100).toFixed(1)}% ≥ ${threshold * 100}%; STAGED rotation to ${toId} (est ${((event.toFiveHourEst ?? 0) * 100).toFixed(1)}%, applies on next request)`,
  );
  return true;
}

/**
 * Apply a previously-staged `pendingKeyChange`. Called by responses.ts once the
 * dispatch stream for the request which triggered the rotation closes, OR at the
 * start of the next request if a stale pendingKeyChange is still hanging around
 * (the previous stream died without firing its onDone). Idempotent: no-op if
 * `provider.pendingKeyChange` is unset. Errors during saveConfig are logged and
 * swallowed - the next request's retry will re-attempt the commit.
 */
export function commitPendingKeyChange(config: OcxConfig, providerName: string): boolean {
  const provider = config.providers[providerName];
  if (!provider || !provider.pendingKeyChange) return false;
  const pkc = provider.pendingKeyChange;
  provider.apiKey = pkc.key;
  if (provider.apiKeyPool) {
    for (const entry of provider.apiKeyPool) {
      entry.active = entry.id === pkc.keyId;
    }
  }
  provider.pendingKeyChange = undefined;
  try {
    saveConfig(config);
  } catch (error) {
    console.warn(
      `[key-scheduler] ${providerName}: commitPendingKeyChange saveConfig failed (${error instanceof Error ? error.message : String(error)}) - key left at ${pkc.keyId}; next request will retry`,
    );
    provider.pendingKeyChange = pkc;
    return false;
  }
  console.log(
    `[key-scheduler] ${providerName}: committed pending key change to ${pkc.keyId} (reason: ${pkc.reason})`,
  );
  return true;
}

/** Read-only snapshot for the management API / GUI. */
/**
 * Warm the probe cache for the state endpoint. Without this, a fresh server reports
 * nextUpId=null until the first real request happens to run the gate — the GUI badge
 * would never show on page load. Best-effort: probe failure leaves the cache cold and
 * the state simply reports nextUpId=null.
 */
export async function warmKeyScheduleProbe(config: OcxConfig, providerName: string): Promise<void> {
  const provider = config.providers[providerName];
  if (!provider || provider.disabled === true) return;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return;
  if ((provider.apiKeyPool?.length ?? 0) < 2) return;
  if (!isMinimaxChatReverseProxy(providerName, provider)) return;
  try {
    await probeKeysCached(providerName, provider, Date.now());
  } catch { /* probe failure → cold cache → nextUpId null */ }
}

export function getKeyScheduleState(config: OcxConfig, providerName: string): KeyScheduleState | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  const pool = provider.apiKeyPool ?? [];
  const active = activePoolEntry(provider);
  const threshold = thresholdFor(provider);
  const enabled = provider.keySchedule?.enabled !== false
    && provider.authMode !== "oauth" && provider.authMode !== "forward"
    && pool.length >= 2
    && isMinimaxChatReverseProxy(providerName, provider);
  // Pending-mode: when a rotation is pending, the key being rotated to IS the next-useful
  // key from the user perspective. After commit lands on next request, the active key
  // flips and pickNextKey reports the new standby.
  let nextUpId: string | null = provider.pendingKeyChange?.keyId ?? null;
  const cached = probeCache.get(providerName);
  if (!nextUpId && enabled && cached) {
    const now = Date.now();
    nextUpId = pickNextKey(cached.keys, providerName, active?.id ?? null, threshold, now, id => isKeyInCooldown(providerName, id, now));
  }
  return {
    enabled,
    threshold,
    activeId: active?.id ?? null,
    nextUpId,
    events: [...(rotationEvents.get(providerName) ?? [])],
    pendingKeyChange: provider.pendingKeyChange,
  };
}

/** Manual key management invalidates probe + local-count state (mirrors clearKeyCooldowns). */
export function clearKeyScheduleState(providerName?: string): void {
  if (!providerName) {
    probeCache.clear();
    localCalls.clear();
    rotationEvents.clear();
    return;
  }
  probeCache.delete(providerName);
  for (const mapKey of [...localCalls.keys()]) {
    if (mapKey.startsWith(`${providerName} `)) localCalls.delete(mapKey);
  }
}
import type { PendingKeyChange } from "../types";
