/**
 * Fetch the provider's live `/models` endpoint. Used by `/api/providers/models` to populate
 * the per-provider model dropdown in the Providers page. Adapter-specific dispatch mirrors
 * what the Codex catalog sync does; here we keep the surface tiny because this is a
 * user-triggered refresh, not the periodic sync.
 */
import type { OcxProviderConfig } from "../types";

/** Strip trailing `/v1` or `/` from a base URL so we can append endpoints safely. */
function stripBase(url: string): string {
  return (url ?? "").replace(/\/+$/, "").replace(/\/v1\/?$/, "");
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
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "User-Agent": "@anthropic-ai/sdk/0.74.0",
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
export async function fetchProviderModels(provider: OcxProviderConfig, pool: Array<{ key: string }>): Promise<{ models: string[] } | { error: string }> {
  const adapter = (provider.adapter ?? "").toLowerCase();
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
    if (!looksAuth && pool.length > 1) return { error: r.error };
  }
  return { error: "no key produced a usable model list (all returned auth failures)" };
}
