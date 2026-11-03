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
import { buildAuthHeaders, defaultStrategiesFor, isReverseProxyProvider, stripBase } from "./auth-matrix";
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
export type ProviderApiKeyTestResult = {
  ok: true | false | "unknown";
  latencyMs: number;
  /** Upstream response body / transport error, truncated. Surfaced in the result dialog. */
  detail?: string;
};

/** Cheap, token-free probe path for each adapter family. Reverse proxies expose a
 *  /v1/usage balance endpoint; everything else answers model discovery. Either way this
 *  costs no completion tokens, which is what separates 余量探测 from 测试. */
function cheapProbePath(provider: OcxProviderConfig): string {
  return isReverseProxyProvider(provider.baseUrl ?? "") ? "/v1/usage" : "/v1/models";
}

/** Probe a pool entry's key against its provider's upstream. Pure read — never persists
 *  config and never spends completion tokens. Auth headers come from the auth matrix
 *  (`defaultStrategiesFor`), so this probe and the 测试 button agree about which header
 *  the provider expects. */
export async function testProviderApiKey(config: OcxConfig, name: string, id: string): Promise<ProviderApiKeyTestResult | { error: string }> {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return { error: "key not found" };
  if (isEnvReference(entry.key)) return { error: "env-referenced keys cannot be tested directly" };

  // Google has its own discovery contract (x-goog-api-key, v1beta) that the matrix does
  // not model, so keep the dedicated validator for it instead of guessing a header.
  if ((provider.adapter ?? "").toLowerCase() === "google") {
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
    const startedAt = Date.now();
    const ok = await validateApiKey(synthetic as Parameters<typeof validateApiKey>[0], entry.key);
    return { ok, latencyMs: Date.now() - startedAt };
  }

  const base = stripBase(provider.baseUrl ?? "");
  if (!base) return { error: "provider has no baseUrl" };
  const url = `${base}${cheapProbePath(provider)}`;

  const started = Date.now();
  let sawAuthRejection = false;
  let lastError: string | undefined;
  // Try the matrix's candidate strategies in order (a locked modelListAuth yields one).
  for (const strategy of defaultStrategiesFor(provider)) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(strategy, entry.key),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true, latencyMs: Date.now() - started };
      const text = (await res.text().catch(() => "")).slice(0, 240);
      // Keep the HTTP status visible: without it a bare error body is hard to act on.
      const detail = text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        sawAuthRejection = true;
        lastError = detail;
        continue;
      }
      // 404 / 5xx / anything else is not an auth verdict — report "couldn't tell".
      return { ok: "unknown", latencyMs: Date.now() - started, detail };
    } catch (err) {
      const nm = err instanceof Error ? err.name : String(err);
      lastError = nm === "AbortError" || nm === "TimeoutError"
        ? "请求超时 (10s)"
        : (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }
  return {
    ok: sawAuthRejection ? false : "unknown",
    latencyMs: Date.now() - started,
    ...(lastError ? { detail: lastError } : {}),
  };
}

export interface ChatTestOpts {
  id?: string;
  model?: string;
  prompt?: string;
}

export interface ChatTestResult {
  ok: boolean;
  status: number | "timeout" | "error";
  latencyMs: number;
  /** Reply text snippet (first 240 chars), if any. */
  reply?: string;
  /** Token usage from upstream, if reported. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
}

/**
 * Send a real chat completion using the matrix-selected (adapter, auth) combo for
 * the provider. Adapter decides URL path, authMatrix decides headers. The model is
 * taken from `opts.model` first, then `provider.testModel`, then `provider.defaultModel`.
 */
interface ChatProbeOpts {
  model: string;
  prompt: string;
  maxTokens: number;
  /** Request deadline. The 1-token quota probe wants a much tighter bound than a real chat. */
  timeoutMs?: number;
}

/**
 * Shared core for both per-key actions. Builds the request from the matrix-locked
 * (adapter, auth) pair so 余量探测 and 测试 can never disagree about which endpoint or
 * header the provider expects. Returns the raw status plus, on success, the parsed reply.
 */
async function runChatProbe(
  provider: OcxProviderConfig,
  key: string,
  opts: ChatProbeOpts,
): Promise<ChatTestResult> {
  const adapter = (provider.adapter ?? "").toLowerCase();
  const base = (provider.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return { ok: false, status: "error", latencyMs: 0, error: "provider has no baseUrl" };

  // Model resolution, in the order the doc comment promises: explicit request >
  // provider.testModel > provider.defaultModel > first entry of provider.models.
  // Without the fallbacks the "默认" option in the GUI (which sends no model) dead-ends
  // with "no model selected" for every provider that has no defaultModel/testModel.
  const model = (opts.model ?? "").trim()
    || (provider.testModel ?? "").trim()
    || (provider.defaultModel ?? "").trim()
    || (provider.models?.[0] ?? "").trim();
  if (!model) {
    return {
      ok: false, status: "error", latencyMs: 0,
      error: "no model available: 请求未指定模型，且 provider 没有 defaultModel / testModel / models —— 请在上方「当前的拉取方式」选一个模型，或给该 provider 配 defaultModel",
    };
  }

  // Auth strategies, same dispatch as the quota probe: an explicit modelListAuth
  // locks one strategy; otherwise try the matrix order and fall through on 401/403.
  // Hardcoding "bearer" here would disagree with what the runtime actually sends
  // (x-api-key for reverse proxies) and could report a false failure.
  const strategies = defaultStrategiesFor(provider);

  // Build URL + body per adapter
  let url: string;
  let body: unknown;
  if (adapter === "anthropic") {
    url = `${base.replace(/\/v1\/?$/, "")}/v1/messages`;
    body = { model, max_tokens: opts.maxTokens, messages: [{ role: "user", content: opts.prompt }] };
  } else if (adapter === "openai-chat") {
    url = `${base}/v1/chat/completions`;
    body = { model, max_tokens: opts.maxTokens, messages: [{ role: "user", content: opts.prompt }] };
  } else if (adapter === "openai-responses") {
    url = `${base}/v1/responses`;
    body = { model, max_tokens: opts.maxTokens, input: opts.prompt };
  } else {
    return { ok: false, status: "error", latencyMs: 0, error: `chat-test not implemented for adapter "${adapter}"` };
  }

  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 25000;
  let lastAuthError: { status: number; error: string } | null = null;
  for (const strategy of strategies) {
    const allHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...buildAuthHeaders(strategy, key),
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: allHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    const latencyMs = Date.now() - started;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
        // 401/403 = this auth strategy is wrong for this provider; try the next one.
        // Anything else (404/5xx/body error) is a real verdict — report it as-is.
        if (res.status === 401 || res.status === 403) {
          lastAuthError = { status: res.status, error: text.slice(0, 240) };
          continue;
        }
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: text.slice(0, 240),
      };
    }
    let reply: string | undefined;
    let usage: ChatTestResult["usage"];
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // Anthropic: content[0].text
      const content = parsed["content"];
      if (Array.isArray(content) && content[0] && typeof (content[0] as Record<string, unknown>)["text"] === "string") {
        reply = ((content[0] as Record<string, string>)["text"]).slice(0, 240);
      }
      // OpenAI chat-completion: choices[0].message.content
      const choices = parsed["choices"];
      if (Array.isArray(choices) && choices[0]) {
        const msg = (choices[0] as Record<string, Record<string, string>>)["message"];
        if (msg && typeof msg["content"] === "string") reply = msg["content"].slice(0, 240);
      }
      // OpenAI responses: output[0].content[0].text
      const output = parsed["output"];
      if (Array.isArray(output) && output[0] && !reply) {
        const contentArr = (output[0] as Record<string, unknown[]>)["content"];
        if (Array.isArray(contentArr) && contentArr[0]) {
          const txt = (contentArr[0] as Record<string, string>)["text"];
          if (typeof txt === "string") reply = txt.slice(0, 240);
        }
      }
      const u = parsed["usage"];
      if (u && typeof u === "object") {
        // Anthropic reports input_tokens/output_tokens; OpenAI reports
        // prompt_tokens/completion_tokens. Normalize so the dialog has one shape.
        const raw = u as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        const prompt = num(raw["prompt_tokens"]) ?? num(raw["input_tokens"]);
        const completion = num(raw["completion_tokens"]) ?? num(raw["output_tokens"]);
        const total = num(raw["total_tokens"]) ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
        if (prompt !== undefined || completion !== undefined || total !== undefined) {
          usage = {
            ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
            ...(completion !== undefined ? { completion_tokens: completion } : {}),
            ...(total !== undefined ? { total_tokens: total } : {}),
          };
        }
      }
    } catch {
      // ignore parse error, still report ok if status was 200
    }
    return { ok: true, status: res.status, latencyMs, reply, usage };
    } catch (err) {
    const latencyMs = Date.now() - started;
    const name = err instanceof Error ? err.name : String(err);
    return {
      ok: false,
      status: name === "AbortError" || name === "TimeoutError" ? "timeout" : "error",
      latencyMs,
      error: name === "AbortError" || name === "TimeoutError"
        ? `请求超时 (${Math.round(timeoutMs / 1000)}s)`
        : (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
    }
  }
  return {
    ok: false,
    status: lastAuthError?.status ?? "error",
    latencyMs: Date.now() - started,
    error: `认证被拒（试了 ${strategies.join(", ")}）${lastAuthError ? `: ${lastAuthError.error}` : ""}`,
  };
}

/**
 * Send a real chat completion using the matrix-selected (adapter, auth) combo for
 * the provider. Adapter decides URL path, modelListAuth decides headers. The model is
 * taken from `opts.model` first, then `provider.testModel`, then `provider.defaultModel`.
 */
export async function chatTestProvider(
  provider: OcxProviderConfig,
  opts: ChatTestOpts = {},
): Promise<ChatTestResult> {
  // Pick the key to test
  let key: string | undefined;
  if (opts.id && provider.apiKeyPool) {
    const entry = provider.apiKeyPool.find((e) => e.id === opts.id);
    if (entry) key = entry.key;
  }
  if (!key) key = provider.apiKey;
  if (!key) return { ok: false, status: "error", latencyMs: 0, error: "no API key configured" };

  return runChatProbe(provider, key, {
    model: opts.model ?? provider.testModel ?? provider.defaultModel ?? "",
    prompt: opts.prompt ?? "hi",
    maxTokens: 100,
  });
}
