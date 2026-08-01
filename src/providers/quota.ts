import { listCodexAuthAccounts } from "../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { getValidAccessToken } from "../oauth";
import { getCredential } from "../oauth/store";
import { antigravityUserAgent } from "../adapters/client-fingerprint";
import { getProviderRegistryEntry } from "./registry";
import { getMinimaxRuntime, isMinimaxRuntimeAvailable } from "./playwright-runtime";
import type { OcxConfig, OcxProviderConfig } from "../types";

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const REFRESH_SKEW_MS = 60_000;
const MINIMAX_PROBE_TIMEOUT_MS = 25_000;
const MINIMAX_LOGIN_WAIT_MS = 8_000;

export interface ProviderQuotaWindow {
  label: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderQuota {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: ProviderQuotaWindow[];
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
 * Pull quota from the minimax.chat user panel. The site has no public REST API, so we
 * headless-load the SPA, fill the API key, click save, and read the rendered DOM.
 *
 * Cost:
 *   - First call (cold): ~1s (browser launch + SPA mount + wait for quota numbers).
 *   - Subsequent calls (warm): ~440ms (SPA reload + DOM scrape).
 *   - Cache TTL: 5 minutes (the global CACHE_TTL_MS already applied by fetchProviderQuotaReports).
 *
 * Failures degrade silently: returns null so the caller simply omits this provider
 * from the report (matching the behavior of all other fetch* functions above).
 */
async function fetchMinimaxChatQuota(provider: string, prov: OcxProviderConfig): Promise<ProviderQuotaReport | null> {
  const apiKey = prov.apiKey;
  if (!apiKey) return null;
  if (!(await isMinimaxRuntimeAvailable())) return null;

  const ctx = await getMinimaxRuntime();
  const page = await ctx.newPage();
  try {
    const probe = await Promise.race([
      scrapeMinimaxQuota(page, apiKey),
      Bun.sleep(MINIMAX_PROBE_TIMEOUT_MS).then(() => null),
    ]);
    if (!probe) return null;
    return report(provider, "minimax-chat:playwright-spa-scrape", probe);
  } finally {
    await page.close().catch(() => { /* best-effort */ });
  }
}

async function scrapeMinimaxQuota(page: import("playwright").Page, apiKey: string): Promise<ProviderQuota | null> {
  await page.goto("https://minnimax.chat/", { waitUntil: "domcontentloaded", timeout: 15_000 });

  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ timeout: 10_000 });

  // The SPA may auto-fill if the key is already in cookies — only type when empty to
  // avoid triggering React's controlled-input reset which would clear the field.
  const currentValue = await passwordInput.inputValue().catch(() => "");
  if (currentValue !== apiKey) {
    await passwordInput.fill(apiKey);
  }

  const saveBtn = page.locator("button", { hasText: "保存" }).first();
  await saveBtn.click();

  // Wait for the 5h quota number "<used> / <total>" (e.g. "522 / 2,500") to render.
  // After login the SPA fetches quota and re-renders the panel within a few seconds.
  await page.waitForFunction(
    () => /\d{1,3}(?:,\d{3})?\s*\/\s*\d{1,3}(?:,\d{3})?/.test(document.body.innerText || ""),
    { timeout: 15_000 },
  );
  // Tiny settle so trailing percentages / reset timestamps finish rendering.
  await Bun.sleep(200);

  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    const grabPct = (label: string): { pct?: number; resetAt?: number } | null => {
      const re = new RegExp(label + "[\\s\\S]{0,120}?([\\d,]+)\\s*\\/\\s*([\\d,]+)", "i");
      const m = text.match(re);
      if (!m) return null;
      const used = Number(m[1].replace(/,/g, ""));
      const total = Number(m[2].replace(/,/g, ""));
      if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
      return { pct: Math.max(0, Math.min(100, (used / total) * 100)) };
    };

    const fiveHour = grabPct("5 小时额度");
    const weekly = grabPct("本周额度");

    // Reset timestamps:
    //   5h:  "最早释放 08/02 00:33"  -> next 5h boundary from oldest call
    //   week: "每周一 00:00 重置 · 下次 08/03 00:00" -> next Monday 00:00
    const weeklyResetMatch = text.match(/下次\s*(\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/);
    let weeklyResetAt: number | undefined;
    if (weeklyResetMatch) {
      const m = weeklyResetMatch[1].match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        const now = new Date();
        const month = Number(m[1]);
        const day = Number(m[2]);
        const hour = Number(m[3]);
        const minute = Number(m[4]);
        // Assume current year; if month/day already passed, roll to next year.
        const candidate = new Date(now.getFullYear(), month - 1, day, hour, minute);
        if (candidate.getTime() < now.getTime()) candidate.setFullYear(now.getFullYear() + 1);
        weeklyResetAt = candidate.getTime();
      }
    }

    if (!fiveHour && !weekly) return null;
    return {
      ...(fiveHour?.pct !== undefined ? { fiveHourPercent: fiveHour.pct } : {}),
      ...(weekly?.pct !== undefined ? { weeklyPercent: weekly.pct } : {}),
      ...(weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
      updatedAt: Date.now(),
    } as ProviderQuota;
  });
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
