import { listCodexAuthAccounts } from "../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { getValidAccessToken } from "../oauth";
import { getCredential } from "../oauth/store";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { getProviderRegistryEntry } from "./registry";
import type { OcxConfig, OcxProviderConfig } from "../types";

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_SKEW_MS = 60_000;
const MINIMAX_USAGE_TIMEOUT_MS = 15_000;
const MINIMAX_USER_AGENT = "opencodex-quota-probe/0.1 (cli)";

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
}

/** Per-key quota report (for providers with apiKeyPool). Mirrors the provider-level
 * ProviderQuota fields but scoped to one key. */
export interface ProviderQuotaKey {
  id: string;
  label?: string;
  masked: string;
  active: boolean;
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  expiresAt?: number;
  planLabel?: string;
  source: string;
  updatedAt: number;
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
  /** Per-key quota breakdown when the provider has multiple keys (apiKeyPool). */
  keys?: ProviderQuotaKey[];
  /** Plan display label (e.g. "旗舰版・69.9 元"). Provider-specific. */
  planLabel?: string;
  /** Plan expiry timestamp. Provider-specific. */
  expiresAt?: number;
  updatedAt: number;
}

export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  reverseEngineered?: boolean;
}

export interface ProviderQuotaResponse {
  generatedAt: number;
  reports: ProviderQuotaReport[];
}

let cache: { key: string; ts: number; response: ProviderQuotaResponse } | null = null;

/** Invalidate the report cache (e.g. after switching a provider's active account). */
export function clearProviderQuotaCache(): void {
  cache = null;
}

function cacheKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .map(([name, provider]) => `${name}:${provider.authMode ?? "key"}:${provider.disabled === true ? "off" : "on"}:${provider.baseUrl}`)
    .sort()
    .join("|");
  return `${config.defaultProvider}|${config.activeCodexAccountId ?? ""}|${providers}`;
}

function hasQuotaRows(quota: ProviderQuota | null | undefined): quota is ProviderQuota {
  if (!quota) return false;
  return typeof quota.fiveHourPercent === "number"
    || typeof quota.weeklyPercent === "number"
    || typeof quota.monthlyPercent === "number"
    || !!quota.customWindows?.some(window => typeof window.percent === "number");
}

function providerLabel(providerId: string): string {
  return getProviderRegistryEntry(providerId)?.label ?? providerId;
}

function normalizeResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isBuiltInChatGptForwardProvider(name: string, provider: OcxProviderConfig): boolean {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const normalizedName = name.toLowerCase();
  return (normalizedName === "openai" || normalizedName === "chatgpt")
    && provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && base === "https://chatgpt.com/backend-api/codex";
}

/**
 * Detect a minimax.chat reverse proxy. We don't hardcode the provider id because users
 * pick any name when adding a custom provider; the most reliable signal is the baseUrl.
 */
function isMinimaxChatReverseProxy(name: string, provider: OcxProviderConfig): boolean {
  const base = (provider.baseUrl ?? "").toLowerCase();
  return base.includes("minnimax.chat");
}

function report(provider: string, source: string, quota: ProviderQuota): ProviderQuotaReport | null {
  if (!hasQuotaRows(quota)) return null;
  return {
    provider,
    label: providerLabel(provider),
    source,
    quota,
    updatedAt: quota.updatedAt,
  };
}

async function fetchChatGptForwardQuota(config: OcxConfig, provider: string, forceRefresh: boolean): Promise<ProviderQuotaReport | null> {
  const accounts = await listCodexAuthAccounts(config, forceRefresh);
  const activeId = config.activeCodexAccountId || MAIN_CODEX_ACCOUNT_ID;
  const active = accounts.find(account => account.id === activeId)
    ?? accounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? accounts[0];
  const quota = active?.quota ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as ProviderQuota : null;
  return quota ? report(provider, "chatgpt:wham", quota) : null;
}

function centsValue(value: unknown): number | undefined {
  const rec = asRecord(value);
  return rec ? toFiniteNumber(rec.val) : undefined;
}

async function fetchXaiQuota(provider: string): Promise<ProviderQuotaReport | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("xai");
  } catch {
    return null;
  }
  const response = await fetch("https://cli-chat-proxy.grok.com/v1/billing", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const config = asRecord(body?.config);
  if (!config) return null;
  const limitCents = centsValue(config.monthlyLimit);
  const usedCents = centsValue(config.used);
  if (limitCents === undefined || usedCents === undefined || limitCents <= 0) return null;
  const percent = normalizePercent((usedCents / limitCents) * 100);
  if (percent === undefined) return null;
  const quota: ProviderQuota = {
    monthlyPercent: percent,
    monthlyResetAt: normalizeResetAt(config.billingPeriodEnd),
    updatedAt: Date.now(),
  };
  return report(provider, "xai:grok-billing", quota);
}

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

async function fetchAnthropicQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("anthropic");
  if (!credential || credential.expires <= Date.now() + REFRESH_SKEW_MS) return null;
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.63 (external, cli)",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      Authorization: `Bearer ${credential.access}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  if (!body) return null;
  const fiveHour = parseClaudeBucket(body.five_hour);
  const sevenDay = parseClaudeBucket(body.seven_day);
  const opus = parseClaudeBucket(body.seven_day_opus);
  const sonnet = parseClaudeBucket(body.seven_day_sonnet);
  const customWindows: ProviderQuotaWindow[] = [];
  if (opus?.percent !== undefined) customWindows.push({ label: "Opus", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
  if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
  const quota: ProviderQuota = {
    ...(fiveHour?.percent !== undefined ? { fiveHourPercent: fiveHour.percent } : {}),
    ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    ...(sevenDay?.percent !== undefined ? { weeklyPercent: sevenDay.percent } : {}),
    ...(sevenDay?.resetAt !== undefined ? { weeklyResetAt: sevenDay.resetAt } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    updatedAt: Date.now(),
  };
  return report(provider, "anthropic:oauth-usage", quota);
}

function quotaInfoEntries(modelInfo: Record<string, unknown>): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const add = (value: unknown, tier?: string) => {
    const rec = asRecord(value);
    if (!rec) return;
    entries.push(tier ? { ...rec, tier } : rec);
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) add(entry);
  };

  if (Array.isArray(modelInfo.quotaInfo)) addArray(modelInfo.quotaInfo);
  else add(modelInfo.quotaInfo);
  addArray(modelInfo.quotaInfos);

  const byTier = asRecord(modelInfo.quotaInfoByTier);
  if (byTier) {
    for (const [tier, value] of Object.entries(byTier)) {
      if (Array.isArray(value)) {
        for (const entry of value) add(entry, tier);
      } else {
        add(value, tier);
      }
    }
  }
  return entries;
}

function classifyAntigravityFamily(modelId: string, modelInfo: Record<string, unknown>, quotaInfo: Record<string, unknown>): "Gem" | "Cla" | null {
  const displayName = typeof modelInfo.displayName === "string" ? modelInfo.displayName : "";
  const tier = typeof quotaInfo.tier === "string" ? quotaInfo.tier : "";
  const haystack = `${modelId} ${displayName} ${tier}`.toLowerCase();
  if (haystack.includes("gemini")) return "Gem";
  if (haystack.includes("claude") || haystack.includes("opus") || haystack.includes("sonnet") || haystack.includes("gpt-oss") || haystack.includes("gpt_oss")) return "Cla";
  return null;
}

function antigravityUsedPercent(quotaInfo: Record<string, unknown>): number | undefined {
  const remaining = normalizePercent(toFiniteNumber(quotaInfo.remainingFraction) !== undefined
    ? toFiniteNumber(quotaInfo.remainingFraction)! * 100
    : toFiniteNumber(quotaInfo.remainingPercentage) !== undefined
      ? toFiniteNumber(quotaInfo.remainingPercentage)! * 100
      : undefined);
  if (remaining === undefined) return undefined;
  return normalizePercent(100 - remaining);
}

async function fetchAntigravityQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  const credential = getCredential("google-antigravity");
  if (!credential?.projectId) return null;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken("google-antigravity");
  } catch {
    return null;
  }
  const baseUrl = (config.baseUrl || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ project: credential.projectId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => null));
  const models = asRecord(body?.models);
  if (!models) return null;

  const windows = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, rawModelInfo] of Object.entries(models)) {
    const modelInfo = asRecord(rawModelInfo);
    if (!modelInfo) continue;
    for (const quotaInfo of quotaInfoEntries(modelInfo)) {
      const label = classifyAntigravityFamily(modelId, modelInfo, quotaInfo);
      if (!label || windows.has(label)) continue;
      const percent = antigravityUsedPercent(quotaInfo);
      if (percent === undefined) continue;
      windows.set(label, {
        label,
        percent,
        ...(normalizeResetAt(quotaInfo.resetTime) !== undefined ? { resetAt: normalizeResetAt(quotaInfo.resetTime) } : {}),
      });
    }
  }

  const customWindows = ["Gem", "Cla"].flatMap(label => {
    const window = windows.get(label);
    return window ? [window] : [];
  });
  if (customWindows.length === 0) return null;
  return report(provider, "google-antigravity:fetchAvailableModels", {
    customWindows,
    updatedAt: Date.now(),
  });
}

async function maybeFetchProviderQuota(
  name: string,
  provider: OcxProviderConfig,
  config: OcxConfig,
  forceRefresh: boolean,
): Promise<ProviderQuotaReport | null> {
  if (provider.disabled === true) return null;
  try {
    if (isBuiltInChatGptForwardProvider(name, provider)) return fetchChatGptForwardQuota(config, name, forceRefresh);
    if (isMinimaxChatReverseProxy(name, provider)) return fetchMinimaxChatQuota(name, provider);
    if (provider.authMode === "oauth" && name === "xai") return fetchXaiQuota(name);
    if (provider.authMode === "oauth" && name === "anthropic") return fetchAnthropicQuota(name);
    if (provider.authMode === "oauth" && name === "google-antigravity") return fetchAntigravityQuota(name, provider);
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull quota from the minimax.chat reverse proxy via GET /v1/usage. The endpoint requires
 * the same x-api-key header the user already configured in OpenCodeX for routing, so no
 * extra credentials live in this codebase. Response is JSON shaped like:
 *   { rolling_5h: { limit, used, window_start, window_end },
 *     weekly:    { limit, used, resets_at, week_start },
 *     plan_name, expires_at, allowed_models, daily_counts, best_practices }
 *
 * When the provider has multiple keys (apiKeyPool), every key's quota is fetched in
 * parallel. Per-key results land in quota.keys[]. The provider-level rollup mirrors
 * the ACTIVE key (or the only key) so existing badges still work for single-key setups.
 *
 * Cost per key: one HTTPS round-trip (~100-300ms). No browser, no Playwright.
 * Cache TTL: 5 minutes via the global CACHE_TTL_MS already applied by
 * fetchProviderQuotaReports.
 *
 * Failures degrade silently: any single key that errors out is omitted from keys[],
 * and the whole call returns null only if zero keys returned data.
 */
async function fetchMinimaxChatQuota(provider: string, prov: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  const baseUrl = (prov.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) return null;

  // Collect all keys: prefer apiKeyPool (multi-key), fall back to legacy single apiKey.
  const pool: Array<{ key: string; id: string; label?: string; active: boolean }> = [];
  if (prov.apiKeyPool && prov.apiKeyPool.length > 0) {
    const activeKey = prov.apiKey ?? prov.apiKeyPool[0]?.key ?? "";
    for (const entry of prov.apiKeyPool) {
      pool.push({ key: entry.key, id: entry.id, label: entry.label, active: entry.key === activeKey });
    }
  } else if (prov.apiKey) {
    pool.push({ key: prov.apiKey, id: sha8(prov.apiKey), active: true });
  }
  if (pool.length === 0) return null;

  // Fetch every key in parallel. One key's failure does not poison the others.
  const perKey = await Promise.all(pool.map(async (entry) => {
    try {
      const res = await fetch(`${baseUrl}/v1/usage`, {
        headers: {
          "x-api-key": entry.key,
          "anthropic-version": "2023-06-01",
          "User-Agent": MINIMAX_USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(MINIMAX_USAGE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const payload = await res.json() as Record<string, unknown>;
      return parseMinimaxUsageForKey(entry, payload);
    } catch {
      return null;
    }
  }));
  const keys = perKey.filter((k): k is ProviderQuotaKey => k !== null);
  if (keys.length === 0) return null;

  // Provider-level rollup mirrors the ACTIVE key (or the only key).
  const active = keys.find(k => k.active) ?? keys[0];
  const quota: ProviderQuota = {
    updatedAt: Date.now(),
    ...(active.fiveHourPercent !== undefined ? { fiveHourPercent: active.fiveHourPercent } : {}),
    ...(active.fiveHourResetAt !== undefined ? { fiveHourResetAt: active.fiveHourResetAt } : {}),
    ...(active.weeklyPercent !== undefined ? { weeklyPercent: active.weeklyPercent } : {}),
    ...(active.weeklyResetAt !== undefined ? { weeklyResetAt: active.weeklyResetAt } : {}),
    ...(active.planLabel ? { planLabel: active.planLabel } : {}),
    ...(active.expiresAt !== undefined ? { expiresAt: active.expiresAt } : {}),
    keys,
  };
  return report(provider, "minimax-chat:/v1/usage", quota);
}

function parseMinimaxUsageForKey(
  entry: { key: string; id: string; label?: string; active: boolean },
  payload: Record<string, unknown>,
): ProviderQuotaKey | null {
  const rolling = payload["rolling_5h"];
  const weekly = payload["weekly"];
  const rollingRec = rolling && typeof rolling === "object" ? rolling as Record<string, unknown> : null;
  const weeklyRec = weekly && typeof weekly === "object" ? weekly as Record<string, unknown> : null;

  const fiveHourPct = toWindowPercent(rollingRec);
  const weeklyPct = toWindowPercent(weeklyRec);
  const weeklyResetAt = normalizeResetAt(weeklyRec?.["resets_at"]);
  const expiresAt = normalizeResetAt(payload["expires_at"]);
  const planLabel = typeof payload["plan_name"] === "string" ? (payload["plan_name"] as string) : undefined;

  if (
    fiveHourPct === undefined && weeklyPct === undefined && weeklyResetAt === undefined &&
    expiresAt === undefined && planLabel === undefined
  ) return null;
  const result: ProviderQuotaKey = {
    id: entry.id,
    masked: maskApiKeyForDisplay(entry.key),
    active: entry.active,
    source: "minimax-chat:/v1/usage",
    updatedAt: Date.now(),
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(fiveHourPct !== undefined ? { fiveHourPercent: fiveHourPct } : {}),
    ...(weeklyResetAt !== undefined ? { fiveHourResetAt: weeklyResetAt } : {}),
    ...(weeklyPct !== undefined ? { weeklyPercent: weeklyPct } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(planLabel !== undefined ? { planLabel } : {}),
  };
  return result;
}

function maskApiKeyForDisplay(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function sha8(s: string): string {
  // Cheap content-derived id for legacy single-key entries (no entry.id).
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 8);
}

function toWindowPercent(rec: Record<string, unknown> | null): number | undefined {
  if (!rec) return undefined;
  const limit = toFiniteNumber(rec["limit"]);
  const used = toFiniteNumber(rec["used"]);
  if (limit === undefined || used === undefined || limit <= 0) return undefined;
  return normalizePercent((used / limit) * 100);
}

export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh = false): Promise<ProviderQuotaResponse> {
  const key = cacheKey(config);
  const now = Date.now();
  if (!forceRefresh && cache && cache.key === key && now - cache.ts < CACHE_TTL_MS) return cache.response;

  const reports = (await Promise.all(
    Object.entries(config.providers).map(([name, provider]) => maybeFetchProviderQuota(name, provider, config, forceRefresh)),
  )).filter((item): item is ProviderQuotaReport => item !== null);
  const response = { generatedAt: Date.now(), reports };
  cache = { key, ts: now, response };
  return response;
}
