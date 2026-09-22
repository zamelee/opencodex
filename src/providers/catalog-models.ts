/**
 * Fetch the provider's live `/models` endpoint. Used by `/api/providers/models` to populate
 * the per-provider model dropdown in the Providers page. Adapter-specific dispatch mirrors
 * what the Codex catalog sync does; here we keep the surface tiny because this is a
 * user-triggered refresh, not the periodic sync.
 */
import type { OcxProviderConfig } from "../types";

/** Strip trailing `/v1` or `/` from a base URL so we can append endpoints safely. */
export function stripBase(url: string): string {
  // Collapse repeated slashes only AFTER the protocol separator (which
  // is the only legal place for `//`); strip trailing slashes, then
  // strip one optional trailing `/v1` segment.
  const parts = (url ?? "").split("://", 2);
  const head = parts.length === 2 ? parts[0] + "://" : "";
  const tail = (parts[1] ?? "").replace(/\/{2,}/g, "/");
  return (head + tail).replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Common shape: we extract `id` and `data[]` (OpenAI shape) and `data[]`/`models[]` (anthropic). */
function parseModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj["data"])) {
    return (obj["data"] as unknown[]).map((m) => typeof (m as Record<string, unknown>).id === "string" ? (m as Record<string, string>).id : "").filter(Boolean);
  }
  if (Array.isArray(obj["models"])) {
    return (obj["models"] as unknown[]).map((m) => typeof (m as Record<string, unknown>).id === "string" ? (m as Record<string, string>).id : "").filter(Boolean);
  }
  return [];
}

async function fetchAnthropicModels(provider: OcxProviderConfig, key: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const base = stripBase(provider.baseUrl);
  try {
    const res = await fetch(`${base}/v1/models`, {
      method: "GET",
      // m.aiio.chat (and other minimax reverse proxies) reject any request
      // carrying extra headers beyond `x-api-key` with 401. Match the
      // dashboard JS bundle's fetch exactly: one header, the key.
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `models endpoint returned ${res.status}` + (body ? `: ${body.slice(0, 120)}` : "") };
    }
    const models = parseModelIds(await res.json().catch(() => null));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function fetchOpenAiModels(provider: OcxProviderConfig, key: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const base = stripBase(provider.baseUrl);
  try {
    const res = await fetch(`${base}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `models endpoint returned ${res.status}` + (body ? `: ${body.slice(0, 120)}` : "") };
    }
    const models = parseModelIds(await res.json().catch(() => null));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function fetchGoogleModels(provider: OcxProviderConfig, key: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${provider.baseUrl}/v1beta/models?pageSize=100`, {
      method: "GET",
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `models endpoint returned ${res.status}` + (body ? `: ${body.slice(0, 120)}` : "") };
    }
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return { ok: true, models: [] };
    const models = Array.isArray((json as Record<string, unknown>)["models"])
      ? ((json as Record<string, unknown>)["models"] as unknown[]).map((m) => {
          const name = (m as Record<string, unknown>)["name"];
          return typeof name === "string" ? name.replace(/^models\//, "") : "";
        }).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Try each pool key in order; first 2xx wins. Used by the "拉取模型" button. */
export async function fetchProviderModels(provider: OcxProviderConfig, pool: Array<{ key: string }>): Promise<{ models: string[] } | { error: string; hint?: string }> {
  const adapter = (provider.adapter ?? "").toLowerCase();
  const base = (provider.baseUrl ?? "").toLowerCase();
  // Reverse-proxy providers (m.aiio.chat, minnimax.chat) accept the `x-api-key`
  // header but reject `openai-chat`/anthropic-version/User-Agent. Adapter=openai-*
  // sends `Authorization: Bearer` which these proxies ignore, so a key that
  // works for /v1/usage returns [] for /v1/models. Detect and steer.
  const looksLikeReverseProxy = base.includes("m.aiio.chat") || base.includes("minnimax.chat");
  if (looksLikeReverseProxy && adapter !== "anthropic") {
    return {
      error: "wrong adapter for reverse-proxy provider",
      hint: `baseUrl "${provider.baseUrl}" looks like the m.aiio.chat / minnimax.chat reverse proxy, which expects adapter=anthropic (x-api-key header, /v1/models + /v1/usage). Current adapter="${provider.adapter}" sends Authorization: Bearer and the proxy returns an empty list. Switch adapter to "anthropic" and retry.`,
    };
  }
  for (const entry of pool) {
    let r: { ok: true; models: string[] } | { ok: false; error: string };
    if (adapter === "anthropic") {
      r = await fetchAnthropicModels(provider, entry.key);
    } else if (adapter === "openai-responses" || adapter === "openai-chat") {
      r = await fetchOpenAiModels(provider, entry.key);
    } else if (adapter === "google") {
      r = await fetchGoogleModels(provider, entry.key);
    } else {
      return { error: `live model fetch not implemented for adapter "${adapter}"` };
    }
    if (r.ok) {
      if (r.models.length === 0) return { error: "endpoint returned no models" };
      return { models: r.models };
    }
    // If this key failed with auth, try the next one. Otherwise stop and surface.
    const looksAuth = /401|403|empty key|invalid/i.test(r.error);
    if (!looksAuth && pool.length > 1) return { error: r.error, hint: undefined };
  }
  return {
    error: "no key produced a usable model list (all returned auth failures)",
    hint: "Every key in apiKeyPool was rejected with 401/403. Common causes: (1) all keys are expired/disabled; (2) adapter mismatch — e.g. baseUrl is a reverse proxy (m.aiio.chat / minnimax.chat) but adapter is \"openai-responses\", which sends Authorization: Bearer instead of x-api-key; (3) key was copied with stray whitespace. Verify with: curl -H \"x-api-key: <key>\" -H \"anthropic-version: 2023-06-01\" <baseUrl>/v1/usage",
  };
}
// Per-adapter probe used by the dashboard "Detect" button. Each candidate
// adapter is probed independently (concurrent) against the same baseUrl +
// first key, with results returned for the user to choose from. NEVER
// applied automatically — the user must explicitly pick one and persist
// it themselves, so this function stays purely read-only.
export type ProbeAdapterResult = {
  adapter: "anthropic" | "openai-responses" | "openai-chat";
  ok: boolean;
  status?: number;
  modelCount: number;
  models: string[];
  warning?: string;
};

const PROBE_ADAPTERS: ProbeAdapterResult["adapter"][] = [
  "anthropic",
  "openai-responses",
  "openai-chat",
];

function poolFirstKey(provider: OcxProviderConfig): string | null {
  const pool = provider.apiKeyPool;
  if (Array.isArray(pool) && pool.length > 0 && pool[0]?.key) return pool[0].key;
  if (provider.apiKey) return provider.apiKey;
  return null;
}

async function probeOneAdapter(adapter: ProbeAdapterResult["adapter"], provider: OcxProviderConfig, key: string): Promise<ProbeAdapterResult> {
  const probeProvider = { ...provider, adapter };
  const r = adapter === "anthropic"
    ? await fetchAnthropicModels(probeProvider, key)
    : await fetchOpenAiModels(probeProvider, key);
  if (!r.ok) {
    return { adapter, ok: false, modelCount: 0, models: [], warning: r.error };
  }
  return {
    adapter,
    ok: r.models.length > 0,
    status: 200,
    modelCount: r.models.length,
    models: r.models,
    ...(r.models.length === 0 ? { warning: "endpoint returned no models (200 OK with empty list)" } : {}),
  };
}

export async function probeAllAdapters(provider: OcxProviderConfig): Promise<{ recommended: ProbeAdapterResult["adapter"]; results: ProbeAdapterResult[] }> {
  const key = poolFirstKey(provider);
  if (!key) {
    throw new Error("no apiKey / apiKeyPool[0].key configured");
  }
  const base = (provider.baseUrl ?? "").toLowerCase();
  const reverseProxy =
    base.includes("m.aiio.chat") || base.includes("minnimax.chat");
  const order: ProbeAdapterResult["adapter"][] = reverseProxy
    ? ["anthropic", "openai-responses", "openai-chat"]
    : ["openai-chat", "openai-responses", "anthropic"];
  const probed = await Promise.all(
    order.map(async (a) => {
      try {
        const r = await probeOneAdapter(a, provider, key);
        return r;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { adapter: a, ok: false, modelCount: 0, models: [], warning: msg } as ProbeAdapterResult;
      }
    }),
  );
  // Recommended = first adapter that returned >= 1 model, in the
  // probe order above. If none return anything, fall back to first
  // order entry — the user can still see all 3 results and pick.
  const anySuccess = probed.find(r => r.ok && r.modelCount > 0);
  const recommended = anySuccess ? anySuccess.adapter : order[0]!;
  return { recommended, results: probed };
}
