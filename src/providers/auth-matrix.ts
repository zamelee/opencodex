/**
 * Auth Strategy Matrix for /v1/models discovery.
 *
 * Different upstream providers expect different auth headers at the /v1/models endpoint:
 * - Standard OpenAI-compatible (e.g. baollm.rqez.cn): Authorization: Bearer <key>
 * - Standard Anthropic (e.g. Anthropic API itself, baollm also accepts this): x-api-key + anthropic-version
 * - Reverse proxies that strip extras (m.aiio.chat, minimax.chat): x-api-key only
 *
 * opencodex historically hardcoded x-api-key inside the anthropic adapter path, which
 * broke any provider that needs Bearer. This module centralizes the dispatch so the
 * "拉取模型" button + the matrix UI can pick the right strategy per provider.
 *
 * Default strategy order: bearer -> x-api-key+anthropic-version -> x-api-key. This
 * matches what most modern providers accept and falls through to the legacy reverse-proxy
 * convention last (preserves prior behavior for m.aiio.chat / minimax.chat).
 */
import type { OcxProviderConfig } from "../types";

export type AuthStrategy = "bearer" | "x-api-key" | "x-api-key+anthropic-version";

export const AUTH_STRATEGIES: readonly AuthStrategy[] = [
  "bearer",
  "x-api-key+anthropic-version",
  "x-api-key",
] as const;

export const AUTH_STRATEGY_LABELS: Record<AuthStrategy, string> = {
  "bearer": "Bearer",
  "x-api-key": "x-api-key (裸)",
  "x-api-key+anthropic-version": "x-api-key + version",
};

/** Adapters tested in the 2D matrix. openai-* adapters and anthropic each go to
 * a different URL under the provider baseUrl, so user can see which combo
 * actually works. */
export const SUPPORTED_ADAPTERS = ["openai-chat", "openai-responses", "anthropic"] as const;
export type SupportedAdapter = typeof SUPPORTED_ADAPTERS[number];

export const ADAPTER_LABELS: Record<SupportedAdapter, string> = {
  "openai-chat": "openai-chat",
  "openai-responses": "openai-responses",
  "anthropic": "anthropic",
};

/** opencodex writes these paths for /v1/models discovery per adapter:
 * All adapters use ${stripBase(baseUrl)}/v1/models. ${stripBase} handles both `https://api.openai.com/v1`
 * and `https://api.openai.com` (auto-compat). */
const ADAPTER_DISCOVERY_PATH: Record<SupportedAdapter, string> = {
  "openai-chat": "/v1/models",
  "openai-responses": "/v1/models",
  "anthropic": "/v1/models",
};

/** Build the HTTP headers to attach to /v1/models for the given strategy. */
export function buildAuthHeaders(strategy: AuthStrategy, key: string): Record<string, string> {
  switch (strategy) {
    case "bearer":
      return { Authorization: `Bearer ${key}`, Accept: "application/json" };
    case "x-api-key":
      return { "x-api-key": key };
    case "x-api-key+anthropic-version":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
}

/** Detect known reverse-proxy baseUrls that need x-api-key-only (no version header). */
export function isReverseProxyProvider(baseUrl: string): boolean {
  const lower = (baseUrl ?? "").toLowerCase();
  return lower.includes("minnimax.chat") || lower.includes("m.aiio.chat");
}

/** Pick the default strategy list to try, in order, for a given provider config. */
export function defaultStrategiesFor(provider: OcxProviderConfig): AuthStrategy[] {
  if (provider.modelListAuth) return [provider.modelListAuth];
  if (isReverseProxyProvider(provider.baseUrl ?? "")) return ["x-api-key"];
  return ["bearer", "x-api-key+anthropic-version", "x-api-key"];
}

export interface ProbeResult {
  status: number | "timeout" | "error";
  latencyMs: number;
  ok: boolean;
  modelCount?: number;
  error?: string;
}

/** Strip trailing /v1 or / so we can append /v1/models safely. */
export function stripBase(url: string): string {
  const parts = (url ?? "").split("://", 2);
  const head = parts.length === 2 ? parts[0] + "://" : "";
  const tail = (parts[1] ?? "").replace(/\/{2,}/g, "/");
  return (head + tail).replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Probe a single (provider, strategy) pair. Returns ProbeResult. */
export async function probeOne(
  provider: OcxProviderConfig,
  adapter: SupportedAdapter,
  strategy: AuthStrategy,
  key: string,
): Promise<ProbeResult> {
  const base = stripBase(provider.baseUrl ?? "");
  const path = ADAPTER_DISCOVERY_PATH[adapter];
  const url = `${base}${path}`;
  const headers = buildAuthHeaders(strategy, key);
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(25000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: res.status, latencyMs, ok: false, error: body.slice(0, 80) };
    }
    const json = await res.json().catch(() => null);
    const modelCount = parseModelIds(json).length;
    return { status: res.status, latencyMs, ok: true, modelCount };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const name = err instanceof Error ? err.name : String(err);
    if ((name === "AbortError" || name === "TimeoutError") && attempt === 0) continue;
    return {
      status: name === "AbortError" || name === "TimeoutError" ? "timeout" : "error",
      latencyMs,
      ok: false,
      error: name === "AbortError" || name === "TimeoutError" ? undefined : (err instanceof Error ? err.message : String(err)).slice(0, 80),
    };
  }
  }
  return { status: "timeout", latencyMs: 25000, ok: false };
}

/** Extract model ids from OpenAI (data[]) or Anthropic (models[]) shape. */
export function parseModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const arr = (Array.isArray(obj["data"]) ? obj["data"] : Array.isArray(obj["models"]) ? obj["models"] : []) as unknown[];
  return arr
    .map((m) => {
      const r = m as Record<string, unknown>;
      const id = r?.id;
      if (typeof id === "string") return id;
      const name = r?.name;
      if (typeof name === "string") return name.replace(/^models\//, "");
      return "";
    })
    .filter(Boolean);
}

/** Probe all (adapter, strategy) pairs concurrently. Returns the 2D matrix shape
 * used by the GUI: rows = adapter, cells = strategy results. */
export async function probeAuthMatrix(
  provider: OcxProviderConfig,
  providerName: string,
  key: string,
): Promise<{
  provider: string;
  currentAdapter: string;
  currentStrategy: AuthStrategy | null;
  recommended: { adapter: SupportedAdapter; strategy: AuthStrategy } | null;
  rows: { adapter: SupportedAdapter; cells: Record<AuthStrategy, ProbeResult> }[];
  probeTimeoutMs: number;
}> {
  const probes = SUPPORTED_ADAPTERS.flatMap((adapter) =>
    AUTH_STRATEGIES.map((strategy) => probeOne(provider, adapter, strategy, key)),
  );
  const flat = await Promise.all(probes);
  const rows = SUPPORTED_ADAPTERS.map((adapter, i) => {
    const cells: Record<string, ProbeResult> = {};
    AUTH_STRATEGIES.forEach((strategy, j) => {
      cells[strategy] = flat[i * AUTH_STRATEGIES.length + j];
    });
    return { adapter, cells: cells as Record<AuthStrategy, ProbeResult> };
  });

  // Pick the first working (adapter, strategy). Prefer current adapter, then
  // reverse-proxy fallback, then everything else.
  const currentAdapter = (provider.adapter ?? "").toLowerCase() as SupportedAdapter;
  const preferredOrder: Array<{ adapter: SupportedAdapter; strategy: AuthStrategy }> = [];
  if ((SUPPORTED_ADAPTERS as readonly string[]).includes(currentAdapter)) {
    for (const strategy of AUTH_STRATEGIES) {
      preferredOrder.push({ adapter: currentAdapter, strategy });
    }
  }
  if (isReverseProxyProvider(provider.baseUrl ?? "")) {
    preferredOrder.push({ adapter: "anthropic", strategy: "x-api-key" });
  } else {
    for (const adapter of SUPPORTED_ADAPTERS) {
      if (adapter === currentAdapter) continue;
      for (const strategy of AUTH_STRATEGIES) {
        preferredOrder.push({ adapter, strategy });
      }
    }
  }
  let recommended: { adapter: SupportedAdapter; strategy: AuthStrategy } | null = null;
  for (const p of preferredOrder) {
    const cell = rows.find((r) => r.adapter === p.adapter)?.cells[p.strategy];
    if (cell?.ok) {
      recommended = p;
      break;
    }
  }

  return {
    provider: providerName,
    currentAdapter: provider.adapter ?? "",
    currentStrategy: provider.modelListAuth ?? null,
    recommended,
    rows,
    probeTimeoutMs: 25000,
  };
}
