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
import { isKeyInCooldown } from "./key-failover";
import { isMinimaxChatReverseProxy, probeMinimaxKeyQuotas } from "./quota";
import type { ProviderQuotaKey } from "./quota";

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

  const toId = pickNextKey(keys, providerName, active.id, threshold, now, id => isKeyInCooldown(providerName, id, now));
  if (!toId) return false; // every alternative is gated out → stay; 429 failover remains
  const next = pool.find(e => e.id === toId);
  if (!next) return false;

  const toQuota = keys.find(k => k.id === toId);
  provider.apiKey = next.key;
  saveConfig(config);

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
    `[key-scheduler] ${providerName}: active key ${active.id} 5h at ${(activeEst * 100).toFixed(1)}% ≥ ${threshold * 100}%; rotating to ${toId} (est ${((event.toFiveHourEst ?? 0) * 100).toFixed(1)}%)`,
  );
  return true;
}

/** Read-only snapshot for the management API / GUI. */
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
  let nextUpId: string | null = null;
  const cached = probeCache.get(providerName);
  if (enabled && cached) {
    const now = Date.now();
    nextUpId = pickNextKey(cached.keys, providerName, active?.id ?? null, threshold, now, id => isKeyInCooldown(providerName, id, now));
  }
  return {
    enabled,
    threshold,
    activeId: active?.id ?? null,
    nextUpId,
    events: [...(rotationEvents.get(providerName) ?? [])],
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
