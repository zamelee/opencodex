/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 * A provider with a legacy bare `apiKey` is seeded into a one-entry pool on first touch.
 */
import { createHash } from "node:crypto";
import { saveConfig } from "../config";
import { validateApiKey } from "../oauth/key-providers";
import type { OcxConfig, OcxProviderConfig } from "../types";

export interface ProviderApiKeyInfo {
  id: string;
  label?: string;
  /** First/last 4 chars only; env references (`${VAR}`) are shown verbatim (not secrets). */
  masked: string;
  active: boolean;
  addedAt?: number;
}

function isEnvReference(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function maskApiKey(value: string): string {
  if (isEnvReference(value)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** Content-derived id: re-adding the same key upserts instead of duplicating. */
function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** True for providers whose upstream auth is a configured API key (not oauth/forward). */
export function isKeyAuthProvider(provider: OcxProviderConfig): boolean {
  return provider.authMode !== "oauth" && provider.authMode !== "forward";
}

/** Seed the pool from a legacy bare `apiKey`, and keep `apiKey` mirrored to the active entry. */
function ensurePool(provider: OcxProviderConfig): NonNullable<OcxProviderConfig["apiKeyPool"]> {
  if (!provider.apiKeyPool) provider.apiKeyPool = [];
  if (provider.apiKeyPool.length === 0 && provider.apiKey) {
    provider.apiKeyPool.push({ id: keyId(provider.apiKey), key: provider.apiKey });
  }
  return provider.apiKeyPool;
}

function activeEntryId(provider: OcxProviderConfig): string | null {
  const pool = provider.apiKeyPool ?? [];
  if (pool.length === 0) return null;
  return (pool.find(e => e.key === provider.apiKey) ?? pool[0]!).id;
}

export function listProviderApiKeys(config: OcxConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  const pool = ensurePool(provider);
  const activeId = activeEntryId(provider);
  return {
    activeId,
    keys: pool.map(entry => ({
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      masked: maskApiKey(entry.key),
      active: entry.id === activeId,
      ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
    })),
  };
}

/** Add (or upsert) a key and make it ACTIVE. Persists config. */
export function addProviderApiKey(config: OcxConfig, name: string, key: string, label?: string): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  const trimmed = key.trim();
  if (!trimmed) return { error: "key is required" };
  if (/[\r\n]/.test(trimmed)) return { error: "key must not include line breaks" };
  const pool = ensurePool(provider);
  const id = keyId(trimmed);
  const existing = pool.find(e => e.id === id);
  if (existing) {
    if (label?.trim()) existing.label = label.trim();
  } else {
    pool.push({ id, key: trimmed, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
  }
  provider.apiKey = trimmed;
  saveConfig(config);
  return { id };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return false;
  provider.apiKey = entry.key;
  saveConfig(config);
  return true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const pool = ensurePool(provider);
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  provider.apiKeyPool = pool.filter(e => e.id !== id);
  if (provider.apiKey === entry.key) {
    const next = provider.apiKeyPool[0];
    if (next) provider.apiKey = next.key;
    else delete provider.apiKey;
  }
  if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
  saveConfig(config);
  return true;
}

/** Return the full key value for a pool entry, or null when the id isn't in this provider's pool.
 *  Mirrors the audit shape used by /api/keys/reveal — callers log id/label/provider, never the
 *  key contents themselves. */
export function revealProviderApiKey(config: OcxConfig, name: string, id: string): { id: string; label?: string; masked: string; key: string } | null {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return null;
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return null;
  return {
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    masked: maskApiKey(entry.key),
    key: entry.key,
  };
}

/** Result of probing an upstream API key against its provider. `unknown` covers transport /
 *  non-auth errors so the UI can render "couldn't tell" instead of a misleading pass/fail. */
export type ProviderApiKeyTestResult = { ok: true | false | "unknown"; latencyMs: number };

/** Probe a pool entry's key against its provider's upstream (anthropic messages, google
 *  models.list, or openai-compatible /models). Pure read — never persists config. */
export async function testProviderApiKey(config: OcxConfig, name: string, id: string): Promise<ProviderApiKeyTestResult | { error: string }> {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return { error: "key not found" };
  if (isEnvReference(entry.key)) return { error: "env-referenced keys cannot be tested directly" };
  // All providers (including minimax.chat reverse proxy) go through validateApiKey so the
  // probe mirrors what the proxy actually does at runtime: POST /v1/messages + max_tokens=1 +
  // provider.testModel ?? defaultModel. This means a key that passes /v1/usage but fails
  // /v1/messages (different gateway routes) is correctly flagged, and a key that works for
  // inference but not quota is also correctly flagged.
  // Reuse the dashboard-flow validator with a synthetic registry entry shaped from the saved
  // provider config — only adapter / baseUrl / googleMode / defaultModel are read by the probe.
  const googleMode = (provider as unknown as { googleMode?: "ai-studio" | "vertex" | "cloud-code-assist" }).googleMode;
  const synthetic = {
    label: name,
    baseUrl: provider.baseUrl,
    adapter: provider.adapter,
    dashboardUrl: "",
    ...(provider.testModel ? { testModel: provider.testModel } : {}),
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    ...(googleMode ? { googleMode } : {}),
  };
  const started = Date.now();
  const ok = await validateApiKey(synthetic as Parameters<typeof validateApiKey>[0], entry.key);
  return { ok, latencyMs: Date.now() - started };
}
