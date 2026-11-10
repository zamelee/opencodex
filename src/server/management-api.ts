import { readFileSync } from "node:fs";
import type { CatalogModel } from "../codex/catalog";
import { invalidateCodexModelsCache, nativeModelRows, resolveAutoCompactRatio } from "../codex/catalog";
import { isLauncherModeEnabled } from "../codex/launcher-mode";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
} from "../config";
import {
  clearLoginState,
  getLoginStatus,
  isOAuthProvider,
  listOAuthProviders,
  listOAuthProviderDescriptors,
  startLoginFlow,
  upsertOAuthProvider,
} from "../oauth";
import { removeCredential } from "../oauth/store";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../oauth/key-providers";
import { deriveProviderPresets } from "../providers/derive";
import { fetchProviderQuotaReports } from "../providers/quota";
import { DEFAULT_CONTEXT_CAP_KEY, DEFAULT_PROVIDER_CONTEXT_CAP, contextCapValueRecord, globalContextCapValue, modelContextOverrides, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setModelContextOverride, setProviderCapValue, setProviderContextCap } from "../providers/context-cap";
import { gateLimitSettings } from "../providers/gate-limit";
import { readUsageEntries } from "../usage/log";
import { getUsageDebugLogEntries } from "../usage/debug";
import { getConsoleLogEntries } from "../lib/console-log-buffer";
import { parseRange, summarizeUsage } from "../usage/summary";
import { stripCodexRuntimeProviderFields } from "../codex/auth-context";
import { getDebugLogEntries } from "../lib/debug-log-buffer";
import { UPSTREAM_BUDGET_MARGIN } from "../lib/upstream-prompt-budget";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../lib/debug-settings";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { drainAndShutdown } from "./lifecycle";
import { clearRequestLog, filterRequestLogs, getRequestLogEntries } from "./request-log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "./auth-cors";

import { markActivity } from "../lib/sidecar-tracker";
// Single source of truth = package.json (../ from src/), so /healthz + the GUI badge match the
// installed npm version instead of a stale hardcode.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

function parseDebugLogQuery(url: URL): { after: number; limit: number } {
  const after = Number(url.searchParams.get("after") ?? url.searchParams.get("since") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "500");
  return {
    after: Number.isFinite(after) && after > 0 ? after : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500,
  };
}

/**
 * Query for the console-log mirror.
 *
 * `levels` filters to specific console methods (log/info/warn/error/debug) so
 * the GUI can offer "errors only" without shipping every line.
 */
function parseConsoleLogQuery(url: URL): { after: number; limit: number; levels: string[] } {
  const base = parseDebugLogQuery(url);
  const raw = url.searchParams.get("levels") ?? "";
  const levels = raw.split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
  return { ...base, levels };
}

export async function handleManagementAPI(req: Request, url: URL, config: OcxConfig, sourceIp: string | null = null): Promise<Response | null> {
  if (!isAllowedRequestOrigin(req, config)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
  }
  // Management bodies are small JSON (provider names, key ids, settings). Reject oversized
  // payloads before any handler buffers them — the data plane has its own decompression cap.
  if (req.method === "POST" || req.method === "PUT") {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: "request body too large" }, 413, req, config);
    }
  }
  // Fire-and-forget: the on-disk catalog refresh must NEVER block a management API
  // response. A slow or unreachable upstream (DNS hiccup, broken provider URL) used to
  // hang DELETE / POST / PATCH for up to the AbortSignal timeout because callers awaited
  // this. The catalog is just a sync hint for Codex's next poll -- it is not part of
  // the operation's contract. The inner try/catch keeps the returned promise resolved,
  // so callers can fire it without await and there are no unhandled-rejection warnings.
  async function refreshCodexCatalogBestEffort(): Promise<void> {
    try {
      const { refreshCodexModelCatalog } = await import("../codex/refresh");
      await refreshCodexModelCatalog(config);
    } catch {
      /* catalog absent */
    }
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(safeConfigDTO(config));
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return jsonResponse({
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
    });
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    let body: { codexAutoStart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    config.codexAutoStart = body.codexAutoStart;
    saveConfig(config);
    return jsonResponse({ ok: true, codexAutoStart: codexAutoStartEnabled(config) });
  }

  // Phase 5: opencodex-only launcher-mode settings. Read returns the current effective values;
  // write returns updated values. The endpoint never exposes providers / api keys / headers /
  // cookie tokens — only the four launcher-related fields. Default values are mirrored back
  // so the GUI can render switches in their effective state.
  if (url.pathname === "/api/opencodex/config" && req.method === "GET") {
    return jsonResponse({
      // Effective values, not raw config: launcher mode is ON only when explicitly
      // enabled, so a hand-written config that omits the field reports "off" instead
      // of "on" (the old `!== false` reading made a missing field mean ENABLED).
      enableCodexLauncherMode: isLauncherModeEnabled(config),
      syncRoutedModels: config.syncRoutedModels !== false,
      syncNativeOpenaiModels: config.syncNativeOpenaiModels !== false,
      preset: config.preset ?? null,
    });
  }

  if (url.pathname === "/api/opencodex/config" && req.method === "PUT") {
    let body: {
      enableCodexLauncherMode?: unknown;
      syncRoutedModels?: unknown;
      syncNativeOpenaiModels?: unknown;
      preset?: unknown;
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const ALLOWED_PRESETS = new Set(["launcher", "proxy-only", "full-pass-through"]);
    const updates: Partial<typeof config> = {};
    let conflictReason: string | null = null;
    const presetProvided = body.preset !== undefined && body.preset !== null;
    const boolProvided = body.enableCodexLauncherMode !== undefined
      || body.syncRoutedModels !== undefined
      || body.syncNativeOpenaiModels !== undefined;
    if (presetProvided) {
      if (typeof body.preset !== "string" || !ALLOWED_PRESETS.has(body.preset)) {
        return jsonResponse({ error: "preset must be one of: launcher, proxy-only, full-pass-through (or null to clear)" }, 400);
      }
      if (boolProvided) {
        conflictReason = "preset must not be combined with the three boolean fields; pick one shape";
      } else {
        updates.preset = body.preset as "launcher" | "proxy-only" | "full-pass-through";
      }
    }
    if (!conflictReason) {
      for (const [k, raw] of [
        ["enableCodexLauncherMode", body.enableCodexLauncherMode],
        ["syncRoutedModels", body.syncRoutedModels],
        ["syncNativeOpenaiModels", body.syncNativeOpenaiModels],
      ] as const) {
        if (raw === undefined) continue;
        if (typeof raw !== "boolean") {
          conflictReason = `${k} must be a boolean`;
          break;
        }
        (updates as Record<string, unknown>)[k] = raw;
      }
    }
    if (conflictReason) {
      return jsonResponse({ error: conflictReason }, 400);
    }
    // Apply atomically. saveConfig uses atomicWriteFile under the hood.
    Object.assign(config, updates);
    saveConfig(config);
    return jsonResponse({
      ok: true,
      enableCodexLauncherMode: isLauncherModeEnabled(config),
      syncRoutedModels: config.syncRoutedModels !== false,
      syncNativeOpenaiModels: config.syncNativeOpenaiModels !== false,
      preset: config.preset ?? null,
    });
  }

  // Phase-7: POST /api/proxy/restart — spawns detached `ocx restart` subprocess,
  // returns immediately with {ok, initiated, pid}. The child does handleStop + handleEnsure;
  // by the time it actually kills the proxy, this response has already been flushed.
  // Falls back gracefully if Bun spawn fails (we keep the current proxy up and surface the error).
  if (url.pathname === "/api/proxy/restart" && req.method === "POST") {
    try {
      const { spawn } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const { dirname, resolve } = await import("node:path");
      const here = dirname(fileURLToPath(import.meta.url));
      const projectRoot = resolve(here, "../..");
      const spawnOpts: Record<string, unknown> = {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore" as const,
        env: process.env,
      };
      if (process.platform === "win32") {
        spawnOpts.windowsHide = true;
      }
      // Tiny grace delay so the parent proxy flushes this response before the child stops it.
      const child = spawn("bun", ["run", "src/cli/index.ts", "restart"], spawnOpts);
      child.unref();
      return jsonResponse({
        ok: true,
        initiated: true,
        pid: child.pid,
        note: "Restart scheduled; this proxy will stop momentarily. The GUI will reconnect after the new instance comes up on the same port.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ ok: false, error: `failed to spawn restart: ${msg}` }, 500);
    }
  }

  if (url.pathname === "/api/diagnostics/project-config" && req.method === "GET") {
    const { getCachedProjectConfigDiagnostics } = await import("../codex/project-config-warnings");
    const { warnings, grouped } = getCachedProjectConfigDiagnostics();
    return jsonResponse({ warnings, grouped });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const { syncModelsToCodex } = await import("../codex/sync");
    const result = await syncModelsToCodex(undefined, config, null);
    return jsonResponse({
      ...result,
      staleAppServerHint: "If Codex App still shows an older model list, restart its long-lived app-server process after sync.",
    }, result.ok ? 200 : 500);
  }

  if (url.pathname === "/api/update/check" && req.method === "GET") {
    const { checkForUpdate, normalizeUpdateChannel } = await import("../update/job");
    const rawTag = url.searchParams.get("tag");
    if (rawTag && rawTag !== "latest" && rawTag !== "preview") {
      return jsonResponse({ error: "tag must be latest or preview" }, 400);
    }
    return jsonResponse(checkForUpdate(normalizeUpdateChannel(rawTag)));
  }

  if (url.pathname === "/api/update/run" && req.method === "POST") {
    const { normalizeUpdateChannel, startUpdateJob, UpdateJobError } = await import("../update/job");
    let body: { tag?: unknown; restart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.tag !== undefined && body.tag !== "latest" && body.tag !== "preview") {
      return jsonResponse({ error: "tag must be latest or preview" }, 400);
    }
    if (body.restart !== undefined && typeof body.restart !== "boolean") {
      return jsonResponse({ error: "restart boolean is required" }, 400);
    }
    try {
      return jsonResponse({ ok: true, job: startUpdateJob(normalizeUpdateChannel(body.tag as string | undefined), body.restart !== false) });
    } catch (err) {
      if (err instanceof UpdateJobError) {
        return jsonResponse({ error: err.message, code: err.code }, err.status);
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (url.pathname === "/api/update/status" && req.method === "GET") {
    const { readUpdateJob } = await import("../update/job");
    const job = readUpdateJob(url.searchParams.get("jobId"));
    if (!job) return jsonResponse({ error: "update job not found" }, 404);
    return jsonResponse({ ok: true, job });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      webSearch: { model: ws.model ?? "gpt-5.6-luna", reasoning: ws.reasoning ?? "low" },
      vision: { model: vs.model ?? "gpt-5.6-luna" },
    });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
    let body: { webSearch?: { model?: string; reasoning?: string }; vision?: { model?: string } };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.webSearch) {
      config.webSearchSidecar = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") config.webSearchSidecar.model = body.webSearch.model;
      if (typeof body.webSearch.reasoning === "string") config.webSearchSidecar.reasoning = body.webSearch.reasoning;
    }
    if (body.vision) {
      config.visionSidecar = { ...config.visionSidecar };
      if (typeof body.vision.model === "string") config.visionSidecar.model = body.vision.model;
    }
    saveConfig(config);
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      ok: true,
      webSearch: { model: ws.model ?? "gpt-5.6-luna", reasoning: ws.reasoning ?? "low" },
      vision: { model: vs.model ?? "gpt-5.6-luna" },
    });
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    return jsonResponse(filterRequestLogs(getRequestLogEntries(), url.searchParams));
  }

  if (url.pathname === "/api/logs" && req.method === "DELETE") {
    clearRequestLog();
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/debug" && req.method === "GET") {
    return jsonResponse(getDebugSettings());
  }

  if (url.pathname === "/api/debug/logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug/usage-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getUsageDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug/console-logs" && req.method === "GET") {
    const { after, limit, levels } = parseConsoleLogQuery(url);
    return jsonResponse(getConsoleLogEntries({ after, limit, levels }));
  }

  if (url.pathname === "/api/debug" && req.method === "PUT") {
    let body: { debug?: unknown; usage?: unknown; injection?: unknown; reset?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.reset === true) return jsonResponse(clearDebugSettings());
    if (body.reset === "debug" || body.reset === "provider") return jsonResponse(clearDebugSetting("debug"));
    if (body.reset === "usage") return jsonResponse(clearDebugSetting("usage"));
    if (body.reset === "injection") return jsonResponse(clearDebugSetting("injection"));
    const partial: Partial<Record<DebugFlag, boolean>> = {};
    for (const key of ["debug", "usage", "injection"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return jsonResponse({ error: `${key} must be a boolean` }, 400);
      partial[key] = body[key];
    }
    if (Object.keys(partial).length === 0) {
      return jsonResponse({ error: "provide debug/usage/injection booleans or reset:true" }, 400);
    }
    return jsonResponse(setDebugSettings(partial));
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    const range = parseRange(url.searchParams.get("range"));
    const now = Date.now();
    try {
      return jsonResponse(summarizeUsage(readUsageEntries(), range, now));
    } catch {
      return jsonResponse({
        range,
        since: null,
        generatedAt: now,
        summary: {
          requests: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          coverageRatio: 0,
        },
        days: [],
        models: [],
        providers: [],
        error: "read_failed",
      });
    }
  }

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      testModel: p.testModel,
      modelCount: Array.isArray(p.models) ? p.models.length : 0,
      hasApiKey: !!p.apiKey,
      disabled: p.disabled === true,
    })));
  }

  // Provider custom headers carry whatever the operator put in them (often an
  // Authorization or X-Api-Key value). They are therefore NOT part of the
  // general config DTO — that endpoint is fetched by the dashboard shell and
  // rendered into a raw-JSON textarea, so shipping values there would put
  // them in a plaintext view (and in any screenshot of it). This endpoint
  // returns the values for ONE named provider so the edit modal can prefill
  // them; it sits behind the same management auth as the rest of /api/*.
  if (url.pathname === "/api/providers/headers" && req.method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    return jsonResponse({ name, headers: config.providers[name].headers ?? {} });
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: string; provider?: OcxProviderConfig; setDefault?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = body.name?.trim();
    const prov = body.provider ? stripCodexRuntimeProviderFields(body.provider) : undefined;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const providerError = providerManagementConfigError(name, prov);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfig: save } = await import("../config");
    // Overwriting an existing provider must not drop its multi-key pool: carry it over, then
    // let the (possibly new) apiKey join the pool as the active entry.
    const existingPool = config.providers[name]?.apiKeyPool;
    if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
    config.providers[name] = prov;
    if (body.setDefault) config.defaultProvider = name;
    save(config);
    if (prov.apiKey && prov.apiKeyPool) {
      const { addProviderApiKey } = await import("../providers/api-keys");
      addProviderApiKey(config, name, prov.apiKey);
    }
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let body: { disabled?: unknown; setDefault?: unknown; provider?: unknown; renameTo?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const wantDisabled = typeof body.disabled === "boolean" ? body.disabled : undefined;
    const wantSetDefault = body.setDefault === true;
    const hasProviderEdit = body.provider !== undefined && body.provider !== null && typeof body.provider === "object";
    if (wantDisabled === undefined && !wantSetDefault && !hasProviderEdit) return jsonResponse({ error: "at least one of `disabled`, `setDefault`, or `provider` is required" }, 400);
    if (body.disabled && name === config.defaultProvider) {
      return jsonResponse({ error: "cannot disable the default provider; set another default first" }, 400);
    }
    // Build a merged provider config from a safe subset of fields. We never let the edit
    // path overwrite API keys, OAuth metadata, or any runtime state — those flows have
    // dedicated endpoints (or are read-only). The whitelist below is the only surface.
    let mergedProvider: OcxProviderConfig | null = null;
    if (hasProviderEdit) {
      const candidate = body.provider as Record<string, unknown>;
      const current = config.providers[name];
      const next: OcxProviderConfig = { ...current };
      // adapter: required non-empty string
    if (candidate.adapter !== undefined) {
      if (typeof candidate.adapter !== "string" || !candidate.adapter.trim()) {
        return jsonResponse({ error: "provider.adapter must be a non-empty string" }, 400);
      }
      next.adapter = candidate.adapter.trim();
    }
    // label: optional display string; empty string clears it (revert to using the map key).
    if (candidate.label !== undefined) {
      if (candidate.label === null || candidate.label === "") {
        delete next.label;
      } else if (typeof candidate.label === "string") {
        const trimmed = candidate.label.trim();
        if (trimmed) next.label = trimmed;
        else delete next.label;
      } else {
        return jsonResponse({ error: "provider.label must be a string or empty" }, 400);
      }
    }
    // baseUrl: required non-empty string (validate below)
      if (candidate.baseUrl !== undefined) {
        if (typeof candidate.baseUrl !== "string" || !candidate.baseUrl.trim()) {
          return jsonResponse({ error: "provider.baseUrl must be a non-empty string" }, 400);
        }
        next.baseUrl = candidate.baseUrl.trim();
      }
      // defaultModel: optional string, empty string clears it
      if (candidate.defaultModel !== undefined) {
        if (candidate.defaultModel === null || candidate.defaultModel === "") {
          delete next.defaultModel;
        } else if (typeof candidate.defaultModel === "string") {
          next.defaultModel = candidate.defaultModel.trim() || undefined;
        } else {
          return jsonResponse({ error: "provider.defaultModel must be a string or empty" }, 400);
        }
      }
      // liveModels: boolean (defaults to true when undefined)
      if (candidate.liveModels !== undefined) {
        if (typeof candidate.liveModels !== "boolean") {
          return jsonResponse({ error: "provider.liveModels must be a boolean" }, 400);
        }
        next.liveModels = candidate.liveModels;
      }
      // supportsSearchTool: boolean (opt-in; the hosted web_search tool is OFF by default)
      if (candidate.supportsSearchTool !== undefined) {
        if (typeof candidate.supportsSearchTool !== "boolean") {
          return jsonResponse({ error: "provider.supportsSearchTool must be a boolean" }, 400);
        }
        if (candidate.supportsSearchTool) next.supportsSearchTool = true;
        else delete next.supportsSearchTool;
      }
      // quotaRetry: how the proxy recovers when the upstream says the balance is
      // empty ("剩余额度: ¥0.000000", HTTP 403). Layer 1 is an instant switch to
      // another key in the pool; layer 2 waits intervalMs and retries, up to
      // maxAttempts extra attempts. The wait is bounded server-side.
      if (candidate.quotaRetry !== undefined) {
        if (candidate.quotaRetry === null) {
          delete next.quotaRetry;
        } else {
          const raw = candidate.quotaRetry as Record<string, unknown>;
          if (typeof raw !== "object" || raw === null) {
            return jsonResponse({ error: "provider.quotaRetry must be an object" }, 400);
          }
          const quotaRetry: { enabled?: boolean; intervalMs?: number; maxAttempts?: number } = {};
          if (raw.enabled !== undefined) {
            if (typeof raw.enabled !== "boolean") {
              return jsonResponse({ error: "provider.quotaRetry.enabled must be a boolean" }, 400);
            }
            quotaRetry.enabled = raw.enabled;
          }
          if (raw.intervalMs !== undefined) {
            if (typeof raw.intervalMs !== "number" || !Number.isFinite(raw.intervalMs)
              || raw.intervalMs < 1000 || raw.intervalMs > 30000) {
              return jsonResponse({ error: "provider.quotaRetry.intervalMs must be between 1000 and 30000" }, 400);
            }
            quotaRetry.intervalMs = Math.round(raw.intervalMs);
          }
          if (raw.maxAttempts !== undefined) {
            if (typeof raw.maxAttempts !== "number" || !Number.isFinite(raw.maxAttempts)
              || raw.maxAttempts < 0 || raw.maxAttempts > 5) {
              return jsonResponse({ error: "provider.quotaRetry.maxAttempts must be between 0 and 5" }, 400);
            }
            quotaRetry.maxAttempts = Math.round(raw.maxAttempts);
          }
          next.quotaRetry = quotaRetry;
        }
      }
      // contextWindow: the context window we advertise for this provider's models. Set it
      // BELOW the upstream's real ceiling so the client's auto-compact brake fires before the
      // upstream would reject a request (Codex counts the prompt in its own tokenizer, which
      // under-counts a CJK/JSON/tool-output mix by ~25%).
      if (candidate.contextWindow !== undefined) {
        if (candidate.contextWindow === null || candidate.contextWindow === 0) {
          delete next.contextWindow;
        } else if (typeof candidate.contextWindow === "number"
          && Number.isFinite(candidate.contextWindow) && candidate.contextWindow > 0) {
          next.contextWindow = Math.floor(candidate.contextWindow);
        } else {
          return jsonResponse({ error: "provider.contextWindow must be a positive number" }, 400);
        }
      }
      // autoCompactRatio: at which fraction of the window Codex should compact (0.5 - 0.95).
      if (candidate.autoCompactRatio !== undefined) {
        if (candidate.autoCompactRatio === null) {
          delete next.autoCompactRatio;
        } else if (typeof candidate.autoCompactRatio === "number"
          && Number.isFinite(candidate.autoCompactRatio)
          && candidate.autoCompactRatio >= 0.5 && candidate.autoCompactRatio <= 0.95) {
          next.autoCompactRatio = candidate.autoCompactRatio;
        } else {
          return jsonResponse({ error: "provider.autoCompactRatio must be between 0.5 and 0.95" }, 400);
        }
      }
      // modelAutoCompactRatios: per-model compact fractions, keyed by "<provider>/<model>".
      // They win over the provider-wide autoCompactRatio. A null value clears the pin so the
      // model falls back to the provider-wide ratio again.
      if (candidate.modelAutoCompactRatios !== undefined) {
        const raw = candidate.modelAutoCompactRatios;
        if (raw === null) {
          delete next.modelAutoCompactRatios;
        } else if (typeof raw === "object" && !Array.isArray(raw)) {
          const table: Record<string, number> = { ...(next.modelAutoCompactRatios ?? {}) };
          for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
            const key = rawKey.trim();
            if (!key) return jsonResponse({ error: "modelAutoCompactRatios key must not be empty" }, 400);
            if (rawValue === null) {
              delete table[key];
              continue;
            }
            if (typeof rawValue === "number"
              && Number.isFinite(rawValue)
              && rawValue >= 0.5 && rawValue <= 0.95) {
              table[key] = rawValue;
              continue;
            }
            return jsonResponse({
              error: `modelAutoCompactRatios["${key}"] must be between 0.5 and 0.95, or null to clear it`,
            }, 400);
          }
          if (Object.keys(table).length === 0) delete next.modelAutoCompactRatios;
          else next.modelAutoCompactRatios = table;
        } else {
          return jsonResponse({ error: "provider.modelAutoCompactRatios must be an object" }, 400);
        }
      }
      // headers: optional Record<string,string>; an empty object clears them
      if (candidate.headers !== undefined) {
        if (candidate.headers === null) {
          delete next.headers;
        } else if (typeof candidate.headers === "object" && !Array.isArray(candidate.headers)) {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(candidate.headers as Record<string, unknown>)) {
            if (typeof v !== "string") {
              return jsonResponse({ error: `provider.headers.${k} must be a string` }, 400);
            }
            h[k] = v;
          }
          if (Object.keys(h).length === 0) delete next.headers;
          else next.headers = h;
        } else {
          return jsonResponse({ error: "provider.headers must be an object" }, 400);
        }
      }
      const validationError = providerManagementConfigError(name, next);
      if (validationError) return jsonResponse({ error: validationError }, 400);
      mergedProvider = next;
    }
    // renameTo: move this provider under a new key (used to be display label, but the user wanted
    // the actual identifier renamed so the GUI shows the human-readable name in the URL too).
    // The apiKeyPool is nested, so it moves with the provider. OAuth accounts are keyed by OAuth
    // provider id (e.g. "anthropic"), not by OpenCodex provider name, so they survive untouched.
    // Codex's model cache must be cleared for the OLD name so stale namespaced ids don't linger.
    let renameTo: string | null = null;
    if (typeof body.renameTo === "string" && body.renameTo.trim() !== "") {
      const candidate = body.renameTo.trim();
      if (candidate === name) {
        // no-op rename; ignore silently
      } else if (!isValidProviderName(candidate)) {
        return jsonResponse({ error: "renameTo must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
      } else if (hasOwnProvider(config.providers, candidate)) {
        return jsonResponse({ error: `provider \"${candidate}\" already exists` }, 409);
      } else {
        renameTo = candidate;
      }
    }
    // setDefault=true means "make this provider the new default". Previously only POST /api/providers
    // supported this (for newly added providers); extending PATCH lets the GUI switch default on
    // an existing provider without the add/remove round-trip.
    if (wantSetDefault) {
      config.defaultProvider = name;
    }
    const { saveConfig: save } = await import("../config");
    if (mergedProvider !== null) {
      config.providers[name] = mergedProvider;
    } else if (wantDisabled !== undefined) {
      config.providers[name] = { ...config.providers[name], disabled: wantDisabled };
    }
    // Apply the rename LAST so any other patch fields are validated against the OLD name's
    // config but written under the NEW name. Deep-copy via JSON to detach nested objects
    // (apiKeyPool, headers, modelContextWindows, etc.) from the old reference.
    let effectiveName = name;
    if (renameTo !== null) {
      const oldName = name;
      const copied = JSON.parse(JSON.stringify(config.providers[oldName])) as OcxProviderConfig;
      config.providers[renameTo] = copied;
      delete config.providers[oldName];
      if (config.defaultProvider === oldName) config.defaultProvider = renameTo;
      effectiveName = renameTo;
    }
    save(config);
    if (renameTo !== null) {
      const { clearModelCache: clearCache } = await import("../codex/model-cache");
      // Clear cache entries that may still hold the OLD namespaced id (provider/model). The
      // new name's cache slot is fresh by definition, but stale entries keyed by the old
      // provider id can linger in codex's local state_5.sqlite until restart otherwise.
      clearCache(renameTo);
      clearCache(name); // `name` is still the original query-param value here (const)
    }
    refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name: effectiveName, renamed: renameTo !== null, disabled: wantDisabled, defaultProvider: config.defaultProvider });
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (name === config.defaultProvider) return jsonResponse({ error: "cannot delete the default provider; set another default first" }, 400);
    const { saveConfig: save } = await import("../config");
    delete config.providers[name];
    setProviderContextCap(config, name, false);
    save(config);
    const { clearModelCache: clearCache } = await import("../codex/model-cache");
    clearCache(name);
    refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Per-model context-cap override map (number = hard cap, false = opt-out of provider cap).
    // Surfaced on each routed row so the GUI Models page can render a per-row Select without
    // joining with /api/provider-context-caps. Native rows have no override (provider cap never
    // applies to the openai passthrough).
    const overrides = modelContextOverrides(config);
    // Per-model manual gates (the proxy-side brake ceiling), keyed by the routed id.
    const manualGates = gateLimitSettings(config).models;
    // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
    // from the static supported set so a disabled model stays listed and re-enableable.
    const native = nativeModelRows(config).map(row => ({
      provider: "openai",
      id: row.slug,
      namespaced: row.slug,
      disabled: row.disabled,
      native: true,
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    }));
    return jsonResponse([...native, ...models.map(m => {
      const namespaced = `${m.provider}/${m.id}`;
      const contextCap = providerContextCap(config, m.provider);
      const override = overrides[namespaced];
      // Whether this row has its OWN compact ratio, or follows the provider-wide one.
      // The GUI needs the distinction to show "跟随 Provider" vs a pinned value.
      const prov = config.providers[m.provider];
      const ratioTable = prov?.modelAutoCompactRatios;
      const ratioPinned = !!ratioTable && typeof ratioTable === "object"
        && (Object.prototype.hasOwnProperty.call(ratioTable, namespaced)
          || Object.prototype.hasOwnProperty.call(ratioTable, m.id));
      return {
        ...m,
        namespaced,
        disabled: disabled.has(namespaced),
        ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
        ...(override !== undefined ? { modelOverride: override } : {}),
        autoCompactRatioPinned: ratioPinned,
        // The operator's manual gate for this row (a number, or "upstream" for no local gate).
        ...(manualGates[namespaced] !== undefined ? { manualGateLimit: manualGates[namespaced] } : {}),
        providerAutoCompactRatio: resolveAutoCompactRatio(prov?.autoCompactRatio),
        // The token count at which Codex should auto-compact: the effective window times the
        // provider's ratio. Surfaced so whoever writes the catalog can publish the brake point
        // instead of a hardcoded 90%.
        // The EFFECTIVE fraction (per-model pin > provider ratio > 0.9), so the GUI slider shows
        // the ratio that is actually in force for this row.
        autoCompactRatio: resolveAutoCompactRatio(m.autoCompactRatio),
        ...(typeof m.effectiveContextWindow === "number" && m.effectiveContextWindow > 0
          ? {
            autoCompactTokenLimit: Math.floor(
              m.effectiveContextWindow * resolveAutoCompactRatio(m.autoCompactRatio),
            ),
          }
          : {}),
      };
    })]);
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    const record = contextCapValueRecord(config.contextCapValue);
    return jsonResponse({
      cap: DEFAULT_PROVIDER_CONTEXT_CAP,
      value: record[DEFAULT_CONTEXT_CAP_KEY] ?? DEFAULT_PROVIDER_CONTEXT_CAP,
      values: record,
      caps: providerContextCaps(config),
      modelOverrides: modelContextOverrides(config),
    });
  }

  if (url.pathname === "/api/provider-context-caps/probe" && req.method === "GET") {
    // "How big is the upstream's window, really?" — the declared value is what the upstream's
    // metadata claims, the learned value is the ceiling the upstream actually enforced (from
    // its own "prompt is too long: N > M maximum" error). The suggestion is the number we
    // should advertise so the client's brake fires before the ceiling.
    const provider = (url.searchParams.get("provider") ?? "").trim();
    const model = (url.searchParams.get("model") ?? "").trim();
    if (!provider || !model) return jsonResponse({ error: "provider and model are required" }, 400);
    const models = await fetchAllModels(config);
    // Scope the lookup to THIS provider: the same bare model id can exist under several
    // providers, and a foreign row would report another provider's window (or none at all).
    const row = models.find((m) => m.provider === provider && m.id === model)
      ?? models.find((m) => `${m.provider}/${m.id}` === model)
      ?? models.find((m) => m.id === model);
    const { probeContextWindow, catalogDeclaredWindow, PROBE_SAFETY_MARGIN } = await import("./context-window-probe");
    const { gateRejectionRecord } = await import("../lib/upstream-gate-circuit");
    // The catalog stores namespaced slugs ("provider/model"); the GUI sends the bare model id.
    const fromCatalog = catalogDeclaredWindow(`${provider}/${model}`) ?? catalogDeclaredWindow(model);
    const rowDeclared = typeof row?.upstreamContextWindow === "number" ? row.upstreamContextWindow : undefined;
    // The declaration chain is deliberately narrow: the upstream's own metadata, or the number
    // the Codex catalog currently publishes for this model. `nativeContextWindow` is NOT a
    // declaration - it is our capped window - and quoting it here would let the probe answer
    // "the upstream says 700k" with a number WE chose.
    const declared = fromCatalog ?? rowDeclared;
    // "The upstream refused us for being too long, but named no ceiling" is worth showing even
    // when it carries no number: it is the difference between "never observed" and "observed,
    // and it told us nothing".
    const refusal = gateRejectionRecord(provider, model);
    const declaredSource = fromCatalog !== undefined ? "codex-catalog"
      : rowDeclared !== undefined ? "upstream-metadata"
        : undefined;
    const probe = probeContextWindow(provider, model, {
      // The upstream's own declaration, before our caps (our provider-level contextWindow
      // would otherwise mask it and make the probe echo back what we already advertise).
      ...(typeof declared === "number" ? { declared } : {}),
      ...(typeof row?.effectiveContextWindow === "number" ? { current: row.effectiveContextWindow } : {}),
    });
    // The trace: every input the answer came from, in the order it was consulted, so the GUI can
    // render the reasoning instead of a bare number. `null` means "this input was unavailable".
    const steps = [
      {
        key: "declared",
        label: "upstream declaration",
        value: typeof probe.declared === "number" ? probe.declared : null,
        source: declaredSource ?? "unavailable",
      },
      {
        key: "learned",
        label: "enforced ceiling (learned from the upstream's own rejection)",
        value: typeof probe.learned === "number" ? probe.learned : null,
        source: typeof probe.learned === "number" ? "upstream-error" : "not-observed-yet",
        // When we saw it, and what the upstream said the request was. The GUI renders this
        // in the operator's language, so the facts travel as fields, not as prose.
        ...(probe.learnedObservedAt ? { observedAt: probe.learnedObservedAt } : {}),
        ...(typeof probe.learnedObservedInputTokens === "number"
          ? { observedInputTokens: probe.learnedObservedInputTokens }
          : {}),
      },
      {
        key: "confirmed",
        label: "confirmed over limit (the upstream refused, but named no ceiling)",
        // No number: the upstream never said one. The count is the evidence we do have.
        value: null,
        ...(refusal ? { valueText: `${refusal.confirmedCount}x` } : {}),
        source: refusal ? "upstream-rejection" : "not-observed-yet",
        ...(refusal ? { refusalCount: refusal.confirmedCount } : {}),
        ...(refusal ? { refusalWithoutLimitCount: refusal.withoutLimitCount } : {}),
        ...(refusal ? { refusalLastSeenAt: refusal.lastSeenAt } : {}),
      },
      {
        key: "current",
        label: "advertised today (after our caps)",
        value: typeof probe.current === "number" ? probe.current : null,
        source: row?.capSource ?? "unknown",
      },
      {
        key: "brake",
        label: "our brake (what the proxy enforces before sending)",
        value: typeof probe.learned === "number"
          ? Math.floor(probe.learned * UPSTREAM_BUDGET_MARGIN)
          : null,
        source: "proxy-side",
      },
      {
        key: "suggestion",
        label: "suggested window (safety margin applied, for whoever compiles the Codex profile)",
        value: typeof probe.suggestion === "number" ? probe.suggestion : null,
        source: probe.source,
      },
    ];
    // Server-side trace: the proxy's stdout (ocx.out.log / ocx.err.log) is the durable record,
    // so the probe is never a black box even if the browser tab is closed.
    console.log(
      `[ocx:probe] ${provider}/${model} declared=${probe.declared ?? "-"}`
      + ` learned=${probe.learned ?? "-"} current=${probe.current ?? "-"}`
      + ` suggestion=${probe.suggestion ?? "-"} source=${probe.source}`,
    );
    return jsonResponse({ ...probe, safetyMargin: PROBE_SAFETY_MARGIN, steps });
  }

  if (url.pathname === "/api/provider-context-caps/probe-live" && req.method === "POST") {
    // The ACTIVE probe: spend one request to make the upstream name its ceiling. The
    // read-only probe above only rearranges what we already know; this one asks.
    let body: { provider?: unknown; model?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!provider || !model) return jsonResponse({ error: "provider and model are required" }, 400);
    const providerConfig = config.providers?.[provider];
    if (!providerConfig) return jsonResponse({ error: `unknown provider: ${provider}` }, 400);
    // The probe talks to the upstream DIRECTLY (it is a diagnostic, not a relayed turn),
    // so it needs a usable key of its own. The configured primary key wins; otherwise we
    // take the first pool entry. A key the upstream refuses
    // (401) or that has no balance (403) is reported as-is - we do not go shopping
    // through the pool, because every attempt is another request upstream.
    const pool = Array.isArray(providerConfig.apiKeyPool) ? providerConfig.apiKeyPool : [];
    const key = providerConfig.apiKey
      ?? pool.find((k) => !!k?.key)?.key
      ?? pool[0]?.key;
    if (!key) return jsonResponse({ error: "the provider has no API key" }, 400);

    const { probeUpstreamGate } = await import("../providers/context-gate-probe");
    const { learnedUpstreamPromptLimit, noteUpstreamPromptLimit, saveLearnedLimits } =
      await import("../lib/upstream-prompt-budget");
    const { catalogDeclaredWindow } = await import("./context-window-probe");
    const learned = learnedUpstreamPromptLimit(provider, model);
    const declared = catalogDeclaredWindow(`${provider}/${model}`) ?? catalogDeclaredWindow(model);
    const { appendDebugLogLine } = await import("../lib/debug-log-buffer");
    appendDebugLogLine(`[ocx:gate-probe] ${provider}/${model} start (known ceiling: ${learned ?? "-"}, declared: ${declared ?? "-"})`);

    const result = await probeUpstreamGate({
      provider: providerConfig,
      modelId: model,
      apiKey: key,
      ...(learned !== undefined ? { learnedLimit: learned } : {}),
      ...(declared !== undefined ? { declaredLimit: declared } : {}),
    });

    for (const attempt of result.attempts) {
      appendDebugLogLine(
        `[ocx:gate-probe] ${provider}/${model} target=${attempt.targetTokens} status=${attempt.status ?? "-"}`
        + ` outcome=${attempt.outcome} limit=${attempt.limit ?? "-"} ${attempt.detail ?? ""}`,
      );
    }
    if (result.limit !== undefined) {
      // A learned ceiling is the only thing worth keeping: it is what the upstream
      // actually enforced. Store it against this provider+model.
      noteUpstreamPromptLimit(provider, result.limit, { modelId: model });
      saveLearnedLimits();
      appendDebugLogLine(`[ocx:gate-probe] ${provider}/${model} learned ceiling ${result.limit}`);
    }
    if (result.error) appendDebugLogLine(`[ocx:gate-probe] ${provider}/${model} ${result.error}`);
    console.log(
      `[ocx:gate-probe] ${provider}/${model} ok=${result.ok}`
      + ` limit=${result.limit ?? "-"} lowerBound=${result.lowerBound ?? "-"}`
      + ` ${result.error ?? ""}`,
    );
    return jsonResponse(result);
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let body: { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown; providerValue?: unknown; modelOverrides?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { saveConfig: save } = await import("../config");
    const { clearModelCache } = await import("../codex/model-cache");
    const respond = () => {
      const record = contextCapValueRecord(config.contextCapValue);
      return jsonResponse({
        ok: true,
        cap: DEFAULT_PROVIDER_CONTEXT_CAP,
        value: record[DEFAULT_CONTEXT_CAP_KEY] ?? DEFAULT_PROVIDER_CONTEXT_CAP,
        values: record,
        caps: providerContextCaps(config),
        modelOverrides: modelContextOverrides(config),
      });
    };

    // Branch 1: set the global cap value and re-point every enabled provider to it.
    if (body.value !== undefined) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value <= 0) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const affected = Object.keys(providerContextCaps(config));
      setGlobalContextCapValue(config, body.value);
      save(config);
      for (const provider of affected) clearModelCache(provider);
      refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 2: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 3: per-model cap override (number sets cap, false opts out, null clears).
    if (body.modelOverrides !== undefined) {
      if (!body.modelOverrides || typeof body.modelOverrides !== "object" || Array.isArray(body.modelOverrides)) {
        return jsonResponse({ error: "modelOverrides must be an object" }, 400);
      }
      const affected = new Set<string>();
      for (const [rawModelId, raw] of Object.entries(body.modelOverrides as Record<string, unknown>)) {
        const modelId = rawModelId.trim();
        if (!modelId) return jsonResponse({ error: "modelOverrides key must be a non-empty namespaced model id" }, 400);
        if (raw === null) {
          setModelContextOverride(config, modelId, null);
        } else if (raw === false) {
          setModelContextOverride(config, modelId, false);
        } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
          setModelContextOverride(config, modelId, Math.floor(raw));
        } else {
          return jsonResponse({ error: `modelOverrides["${modelId}"] must be a positive number, false, or null` }, 400);
        }
        const slash = modelId.indexOf("/");
        if (slash > 0) affected.add(modelId.slice(0, slash));
      }
      save(config);
      for (const provider of affected) clearModelCache(provider);
      refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 4: per-provider cap value (write to contextCapValue[provider]).
    if (body.providerValue !== undefined) {
      if (typeof body.provider !== "string") {
        return jsonResponse({ error: "provider string is required with providerValue" }, 400);
      }
      const provider = body.provider.trim();
      if (!isValidProviderName(provider)) {
        return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
      }
      if (!hasOwnProvider(config.providers, provider)) {
        return jsonResponse({ error: "unknown provider" }, 404);
      }
      if (body.providerValue === null) {
        setProviderCapValue(config, provider, null);
      } else if (typeof body.providerValue !== "number" || !Number.isFinite(body.providerValue) || body.providerValue <= 0) {
        return jsonResponse({ error: "providerValue must be a positive number or null" }, 400);
      } else {
        setProviderCapValue(config, provider, body.providerValue);
      }
      save(config);
      clearModelCache(provider);
      refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 5: existing per-provider toggle (enable writes the current global value).
    if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
    }
    const provider = body.provider.trim();
    if (!isValidProviderName(provider)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    if (!hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    setProviderContextCap(config, provider, body.enabled);
    save(config);
    clearModelCache(provider);
    refreshCodexCatalogBestEffort();
    return respond();
  }

  // Enable/disable models: which routed models Codex sees. PUT hides them from the catalog +
  // /v1/models and invalidates Codex's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;
    const { saveConfig: save } = await import("../config");
    save(config);
    refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, disabled });
  }

  // The per-model MANUAL gate: a number is the proxy-side brake ceiling, "upstream" hands the
  // decision to the upstream (no local gate at all).
  if (url.pathname === "/api/gate-limits" && req.method === "GET") {
    const { gateLimitSettings } = await import("../providers/gate-limit");
    return jsonResponse(gateLimitSettings(config));
  }

  // The learned token-scale factors: how many upstream tokens our estimate is worth, per
  // provider. They come from the upstream's OWN counts (its refusal names the size it was
  // asked to handle), so they are the closest thing to the upstream's ruler we have.
  if (url.pathname === "/api/token-scales" && req.method === "GET") {
    const { allLearnedScales } = await import("../lib/upstream-token-scale");
    return jsonResponse({ scales: allLearnedScales() });
  }

  if (url.pathname === "/api/gate-limits" && req.method === "PUT") {
    let body: { model?: unknown; value?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.model !== "string" || !body.model.trim()) {
      return jsonResponse({ error: "model string is required" }, 400);
    }
    const key = body.model.trim();
    let value: number | "upstream" | null;
    if (body.value === null) {
      value = null;
    } else if (body.value === "upstream") {
      value = "upstream";
    } else if (typeof body.value === "number" && Number.isFinite(body.value) && body.value > 0) {
      value = Math.floor(body.value);
    } else {
      return jsonResponse({ error: "value must be a positive number, \"upstream\", or null" }, 400);
    }
    const { setModelGateLimit, gateLimitSettings } = await import("../providers/gate-limit");
    setModelGateLimit(config, key, value);
    const { saveConfig: save } = await import("../config");
    save(config);
    return jsonResponse({ ok: true, ...gateLimitSettings(config) });
  }

  // Image downsampling switch: a global default plus a per-provider and per-model override.
  // Same three-state shape as the context caps (follow the provider / force on / force off).
  if (url.pathname === "/api/image-downsample" && req.method === "GET") {
    const { imageDownsampleSettings } = await import("../providers/image-downsample");
    return jsonResponse(imageDownsampleSettings(config));
  }

  if (url.pathname === "/api/image-downsample" && req.method === "PUT") {
    let body: { scope?: unknown; provider?: unknown; model?: unknown; enabled?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { setGlobalImageDownsample, setModelImageDownsample, setProviderImageDownsample } =
      await import("../providers/image-downsample");
    const enabled = body.enabled === null ? null : body.enabled === true ? true : body.enabled === false ? false : undefined;
    if (enabled === undefined) {
      return jsonResponse({ error: "enabled must be a boolean or null" }, 400);
    }
    const scope = typeof body.scope === "string" ? body.scope : "";
    if (scope === "global") {
      setGlobalImageDownsample(config, enabled);
    } else if (scope === "provider") {
      if (typeof body.provider !== "string" || !body.provider.trim()) {
        return jsonResponse({ error: "provider string is required for scope=provider" }, 400);
      }
      const provider = body.provider.trim();
      if (!isValidProviderName(provider)) {
        return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
      }
      setProviderImageDownsample(config, provider, enabled);
    } else if (scope === "model") {
      if (typeof body.model !== "string" || !body.model.trim()) {
        return jsonResponse({ error: "model string is required for scope=model" }, 400);
      }
      setModelImageDownsample(config, body.model.trim(), enabled);
    } else {
      return jsonResponse({ error: "scope must be global, provider, or model" }, 400);
    }
    const { saveConfig: save } = await import("../config");
    save(config);
    const { imageDownsampleSettings } = await import("../providers/image-downsample");
    return jsonResponse({ ok: true, ...imageDownsampleSettings(config) });
  }

  // multi_agent_v2 surface toggle. GET reports the flag + the agents.max_threads
  // boot conflict; PUT flips it via the official `codex features` CLI and RESYNCS
  // the catalog so multi-agent surface metadata stays fresh. The catalog build
  // itself never writes config — this endpoint is the only server-side mutation
  // surface for the flag.
  if (url.pathname === "/api/v2" && req.method === "GET") {
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getMaxConcurrentThreads } = await import("../codex/features");
    return jsonResponse({
      enabled: isMultiAgentV2Enabled(),
      agentsMaxThreadsConflict: hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getMaxConcurrentThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
    });
  }
  if (url.pathname === "/api/v2" && req.method === "PUT") {
    let body: { enabled?: unknown; maxConcurrentThreadsPerSession?: unknown; multiAgentMode?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const wantsFlag = body.enabled !== undefined;
    const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
    const wantsMode = body.multiAgentMode !== undefined;
    if (!wantsFlag && !wantsThreads && !wantsMode) return jsonResponse({ error: "body must set enabled, multiAgentMode, and/or maxConcurrentThreadsPerSession" }, 400);
    if (wantsFlag && typeof body.enabled !== "boolean") return jsonResponse({ error: "body.enabled must be a boolean" }, 400);
    if (wantsMode && body.multiAgentMode !== "v1" && body.multiAgentMode !== "default" && body.multiAgentMode !== "v2") {
      return jsonResponse({ error: "body.multiAgentMode must be 'v1', 'default', or 'v2'" }, 400);
    }
    if (wantsThreads && (typeof body.maxConcurrentThreadsPerSession !== "number" || !Number.isInteger(body.maxConcurrentThreadsPerSession) || body.maxConcurrentThreadsPerSession < 1)) {
      return jsonResponse({ error: "body.maxConcurrentThreadsPerSession must be an integer >= 1" }, 400);
    }
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getMaxConcurrentThreads, setMaxConcurrentThreads } = await import("../codex/features");
    const warnings: string[] = [];
    if (wantsFlag && isMultiAgentV2Enabled() !== body.enabled) {
      const { execFileSync } = await import("node:child_process");
      const command = process.env.CODEX_CLI_PATH?.trim() || "codex";
      try {
        execFileSync(command, ["features", body.enabled ? "enable" : "disable", "multi_agent_v2"],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true });
      } catch (err) {
        return jsonResponse({ error: `codex features ${body.enabled ? "enable" : "disable"} failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
      }
      refreshCodexCatalogBestEffort();
    }
    if (wantsThreads) {
      // setMaxConcurrentThreads is idempotent (equal value -> no write) and refuses
      // when the [features.multi_agent_v2] table is missing, so a threads-only PUT
      // against a never-enabled config fails loudly instead of inventing state.
      const result = setMaxConcurrentThreads(body.maxConcurrentThreadsPerSession as number);
      if (!result.ok) return jsonResponse({ error: result.error }, 409);
      if (result.changed) warnings.push("Thread limit applies to new sessions.");
    }
    if (wantsMode) {
      const mode = body.multiAgentMode as "v1" | "default" | "v2";
      if (mode === "default") delete config.multiAgentMode;
      else config.multiAgentMode = mode;
      saveConfig(config);
      refreshCodexCatalogBestEffort();
      warnings.push(`Multi-agent mode set to '${mode}'. Applies to new sessions.`);
    }
    if ((wantsFlag ? body.enabled === true : isMultiAgentV2Enabled()) && hasAgentsMaxThreads()) {
      warnings.push("[agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled; remove it (features.multi_agent_v2.max_concurrent_threads_per_session replaces it).");
    }
    if (wantsFlag) warnings.push("Applies to new sessions; restart the Codex app or wait out its picker cache to see the ladder change.");
    return jsonResponse({
      ok: true,
      enabled: isMultiAgentV2Enabled(),
      maxConcurrentThreadsPerSession: getMaxConcurrentThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
      warnings,
    });
  }

  // Which providers support real OAuth login (drives the GUI's "Log in with …" buttons).
  if (url.pathname === "/api/oauth/providers" && req.method === "GET") {
    return jsonResponse({ providers: listOAuthProviderDescriptors() });
  }

  // API-key "login" providers (open dashboard → paste key). Drives the GUI's key-provider picker.
  if (url.pathname === "/api/key-providers" && req.method === "GET") {
    return jsonResponse({ providers: listKeyLoginProviders() });
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  // Subagent prompt injection model: single native or routed model whose info is
  // dynamically injected into the v1 proactive prompt, plus an optional reasoning
  // effort the prompt tells the agent to pass to spawn_agent. GET returns the current
  // picks + available models/efforts; PUT sets or clears them.
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter(slug => !disabled.has(slug))
      .map(slug => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = models
      .map(m => ({ provider: m.provider, model: m.id, namespaced: `${m.provider}/${m.id}` }))
      .filter(m => !disabled.has(m.namespaced));
    return jsonResponse({
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
      available: [...nativeModels, ...routedModels],
    });
  }
  if (url.pathname === "/api/injection-model" && req.method === "PUT") {
    let body: { model?: unknown; effort?: unknown; prompt?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../reasoning-effort");
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
    let effort = config.injectionEffort;
    // `effort` key semantics: absent -> unchanged; null/"" -> clear; ladder value -> set;
    // anything else -> 400. Clearing the model always clears the effort (it is meaningless alone).
    if ("effort" in body) {
      const requestedEffort = typeof body.effort === "string" && body.effort.length > 0 ? body.effort : undefined;
      if (requestedEffort !== undefined && !isCodexReasoningEffort(requestedEffort)) {
        return jsonResponse({ error: `unknown reasoning effort "${requestedEffort}"` }, 400);
      }
      effort = requestedEffort;
    }
    if (!model) effort = undefined;
    if (model) config.injectionModel = model;
    else delete config.injectionModel;
    if (effort) config.injectionEffort = effort;
    else delete config.injectionEffort;
    // `prompt` key semantics mirror `effort`: absent -> unchanged; null/"" -> clear;
    // non-empty string -> set (custom <multi_agent_mode> body, {{model}}/{{effort}}/{{roster}} placeholders).
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0) config.injectionPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "") delete config.injectionPrompt;
      else return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    saveConfig(config);
    return jsonResponse({ ok: true, model: config.injectionModel ?? null, effort: config.injectionEffort ?? null, prompt: config.injectionPrompt ?? null });
  }

  // Hard reasoning-effort caps (devlog/260710_subagent_effort_intercept): a global ceiling and a
  // sub-agent-only ceiling, enforced per-request in handleResponses (src/server/effort-policy.ts).
  // Key semantics per field: absent -> unchanged; null/"" -> clear; ladder value -> set; else 400.
  if (url.pathname === "/api/effort-caps" && req.method === "GET") {
    const { CODEX_REASONING_LEVELS } = await import("../reasoning-effort");
    return jsonResponse({
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
    });
  }
  if (url.pathname === "/api/effort-caps" && req.method === "PUT") {
    let body: { effortCap?: unknown; subagentEffortCap?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../reasoning-effort");
    for (const key of ["effortCap", "subagentEffortCap"] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value === null || value === "") { delete config[key]; continue; }
      if (typeof value !== "string" || !isCodexReasoningEffort(value)) {
        return jsonResponse({ error: `unknown reasoning effort "${String(value)}"` }, 400);
      }
      config[key] = value;
    }
    saveConfig(config);
    return jsonResponse({ ok: true, effortCap: config.effortCap ?? null, subagentEffortCap: config.subagentEffortCap ?? null });
  }

  // Subagent model picker: which ≤5 routed models Codex's spawn_agent advertises (it shows the
  // first 5 routed catalog entries). PUT reorders the injected catalog so the chosen ones lead.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const available = [
      ...listCatalogNativeSlugs(),
      ...models.map(m => `${m.provider}/${m.id}`),
    ].filter(ns => !disabled.has(ns));
    return jsonResponse({ chosen: config.subagentModels ?? [], available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 5) : [];
    config.subagentModels = chosen;
    const { saveConfig: save } = await import("../config");
    save(config);
    refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // Per-provider catalog allowlist (issue #52): when a provider has a non-empty selectedModels list,
  // only those ids ship to Codex's catalog / /v1/models. GET returns the CURRENT selection plus the
  // FULL available set per provider (unfiltered — the picker needs everything to choose from).
  if (url.pathname === "/api/selected-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const available: Record<string, string[]> = {};
    for (const m of models) (available[m.provider] ??= []).push(m.id);
    const selected: Record<string, string[]> = {};
    for (const [name, prov] of Object.entries(config.providers)) {
      if (Array.isArray(prov.selectedModels) && prov.selectedModels.length > 0) selected[name] = [...prov.selectedModels];
    }
    return jsonResponse({ selected, available });
  }
  if (url.pathname === "/api/selected-models" && req.method === "PUT") {
    let body: { provider?: unknown; models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!provider || !hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, provider ? 404 : 400);
    }
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.filter((m): m is string => typeof m === "string"))]
      : [];
    // Empty list clears the allowlist (provider reverts to exposing all models).
    if (models.length > 0) config.providers[provider].selectedModels = models;
    else delete config.providers[provider].selectedModels;
    const { saveConfig: save } = await import("../config");
    save(config);
    refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, provider, selected: models });
  }

  // OAuth login (xai now; anthropic/kimi in cycle 2). Starts the flow and returns the auth URL;
  // the provider's loopback callback server (inside this process) captures the redirect in the
  // background, then the credential is persisted. The GUI opens the URL and polls /api/oauth/status.
  if (url.pathname === "/api/oauth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; addAccount?: boolean };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    try {
      // addAccount forces a fresh browser identity (skips local-CLI token import) so a
      // SECOND account can be added instead of re-importing the first one.
      const { url: authUrl, instructions } = await startLoginFlow(provider, body.addAccount ? { forceLogin: true } : undefined);
      upsertOAuthProvider(config, provider); // mutate LIVE config — routing sees it without restart
      if (authUrl) {
        // Open the browser server-side (the proxy runs on the user's machine) — the GUI's
        // window.open is popup-blocked because it runs after an await, not a direct click.
        const { openUrl } = await import("../lib/open-url");
        openUrl(authUrl);
      }
      return jsonResponse({ url: authUrl, instructions });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    return jsonResponse(getLoginStatus(provider));
  }

  if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    removeCredential(provider);
    clearLoginState(provider);
    return jsonResponse({ success: true });
  }

  // Multiauth account management: list a provider's logged-in accounts, switch the active
  // one, or remove one. Emails are masked; tokens never leave the store.
  if (url.pathname === "/api/oauth/accounts" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const status = getLoginStatus(provider);
    return jsonResponse({ activeAccountId: status.activeAccountId ?? null, accounts: status.accounts ?? [] });
  }
  if (url.pathname === "/api/oauth/accounts/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { provider?: string; accountId?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!body.accountId) return jsonResponse({ error: "missing accountId" }, 400);
    const { setActiveAccount } = await import("../oauth/store");
    if (!setActiveAccount(provider, body.accountId)) return jsonResponse({ error: "account not found" }, 404);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true, provider, activeAccountId: body.accountId });
  }
  if (url.pathname === "/api/oauth/accounts" && req.method === "DELETE") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    const id = url.searchParams.get("id") ?? "";
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeAccount, getAccountSet } = await import("../oauth/store");
    if (!removeAccount(provider, id)) return jsonResponse({ error: "account not found" }, 404);
    if (!getAccountSet(provider)) clearLoginState(provider);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true });
  }

  // Multi-key pool for API-key providers (same GUI dropdown as OAuth multiauth): list masked
  // keys, add one (upserts + activates), switch the active key, or remove one. `apiKey` always
  // mirrors the active entry so routing is untouched.
  if (url.pathname === "/api/providers/keys" && req.method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const { listProviderApiKeys } = await import("../providers/api-keys");
    return jsonResponse(listProviderApiKeys(config, name));
  }
  if (url.pathname === "/api/providers/keys" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { name?: string; key?: string; label?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (typeof body.key !== "string" || !body.key.trim()) return jsonResponse({ error: "key is required" }, 400);
    const { addProviderApiKey } = await import("../providers/api-keys");
    const result = addProviderApiKey(config, name, body.key, body.label);
    if ("error" in result) return jsonResponse({ error: result.error }, 400);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    const { clearKeyScheduleState } = await import("../providers/key-scheduler");
    clearKeyScheduleState(name); // manual key management resets scheduler probe/local state
    return jsonResponse({ ok: true, id: result.id }, 201);
  }
  if (url.pathname === "/api/providers/keys/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { name?: string; id?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!body.id) return jsonResponse({ error: "missing id" }, 400);
    const { setActiveProviderApiKey } = await import("../providers/api-keys");
    if (!setActiveProviderApiKey(config, name, body.id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    const { clearKeyScheduleState } = await import("../providers/key-scheduler");
    clearKeyScheduleState(name); // manual key management resets scheduler probe/local state
    return jsonResponse({ ok: true, name, activeId: body.id });
  }
  if (url.pathname === "/api/providers/keys/auto-switch" && req.method === "PUT") {
    // Opt a pool entry in / out of the automatic key rotation. Persisted user intent —
    // independent from the derived "expired" state (a renewed key returns on its own).
    const body = await req.json().catch(() => ({})) as { name?: string; id?: string; enabled?: boolean };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!body.id) return jsonResponse({ error: "missing id" }, 400);
    if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
    const { setProviderApiKeyAutoSwitch } = await import("../providers/api-keys");
    if (!setProviderApiKeyAutoSwitch(config, name, body.id, body.enabled)) return jsonResponse({ error: "key not found" }, 404);
    const { clearProviderQuotaCache, clearKeyExpiryRegistry } = await import("../providers/quota");
    clearProviderQuotaCache();
    clearKeyExpiryRegistry(name);
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name);
    const { clearKeyScheduleState } = await import("../providers/key-scheduler");
    clearKeyScheduleState(name);
    return jsonResponse({ ok: true, name, id: body.id, autoSwitch: body.enabled });
  }
  if (url.pathname === "/api/providers/keys" && req.method === "DELETE") {
    const name = (url.searchParams.get("name") ?? "").trim();
    const id = url.searchParams.get("id") ?? "";
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeProviderApiKey } = await import("../providers/api-keys");
    if (!removeProviderApiKey(config, name, id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache, clearKeyExpiryRegistry } = await import("../providers/quota");
    clearProviderQuotaCache();
    clearKeyExpiryRegistry(name);
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    const { clearKeyScheduleState } = await import("../providers/key-scheduler");
    clearKeyScheduleState(name); // manual key management resets scheduler probe/local state
    return jsonResponse({ ok: true });
  }
  // Reveal the full value of a single pool entry. Mirrors /api/keys/reveal: full key content is
  // returned in the response body but never written to logs/audit — the audit line only names
  // the provider + key id so an operator can tell which entry was exposed.
  if (url.pathname === "/api/providers/keys/reveal" && req.method === "POST") {
    let rb: { name?: string; id?: string };
    try { rb = await req.json() as { name?: string; id?: string }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    const id = (rb.id ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { revealProviderApiKey } = await import("../providers/api-keys");
    const revealed = revealProviderApiKey(config, name, id);
    if (!revealed) return jsonResponse({ error: "key not found" }, 404);
    const ts = new Date().toISOString();
    const from = sourceIp ?? "unknown";
    console.log(`[opencodex-audit] revealed providerApiKey provider=${name} id=${id} label=${revealed.label ?? ""} from=${from} at=${ts}`);
    markActivity(`revealed providerApiKey provider=${name} id=${id} from=${from}`);
    return jsonResponse({ id: revealed.id, label: revealed.label, masked: revealed.masked, key: revealed.key });
  }
  // Probe a pool entry's key against the provider's upstream. Read-only — does not persist,
  // Quota-aware key scheduler state: threshold, next-up candidate, and recent rotation
  // events for the provider card UI (src/providers/key-scheduler.ts). Read-only.
  if (url.pathname === "/api/providers/key-schedule" && req.method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    // Warm the probe first so nextUpId is meaningful on a fresh server (page load
    // before any request has run the gate).
    const { warmKeyScheduleProbe, getKeyScheduleState } = await import("../providers/key-scheduler");
    await warmKeyScheduleProbe(config, name);
    const state = getKeyScheduleState(config, name);
    if (!state) return jsonResponse({ error: "unknown provider" }, 404);
    return jsonResponse(state);
  }

  // Update the proactive 5h-threshold for a provider's key scheduler. Accepts a partial
  // body so the GUI can patch just `threshold` (or `enabled`) without re-uploading the full
  // provider config. The 5h gate (default 0.85) is the user's main lever for tuning when
  // opencodex proactively rotates away from a hot key.
  if (url.pathname === "/api/providers/key-schedule" && req.method === "PATCH") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let body: { threshold?: unknown; enabled?: unknown };
    try { body = await req.json() as { threshold?: unknown; enabled?: unknown }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const prov = config.providers[name]!;
    let updated = false;
    if (body.threshold !== undefined) {
      const t = Number(body.threshold);
      if (!Number.isFinite(t) || t < 0.5 || t > 0.99) {
        return jsonResponse({ error: "threshold must be a number in [0.5, 0.99]" }, 400);
      }
      prov.keySchedule = { ...(prov.keySchedule ?? {}), threshold: t };
      updated = true;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
      prov.keySchedule = { ...(prov.keySchedule ?? {}), enabled: body.enabled };
      updated = true;
    }
    if (!updated) return jsonResponse({ error: "at least one of `threshold` or `enabled` is required" }, 400);
    const { saveConfig: save } = await import("../config");
    save(config);
    const { getKeyScheduleState } = await import("../providers/key-scheduler");
    return jsonResponse(getKeyScheduleState(config, name));
  }

  // Probe a pool entry's key against the provider's upstream. Read-only — does not persist,
  // does not rotate the active key, and does not touch cooldowns.
  if (url.pathname === "/api/providers/keys/test" && req.method === "POST") {
    let rb: { name?: string; id?: string };
    try { rb = await req.json() as { name?: string; id?: string }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    const id = (rb.id ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { testProviderApiKey } = await import("../providers/api-keys");
    const result = await testProviderApiKey(config, name, id);
    if ("error" in result) return jsonResponse({ error: result.error }, result.error === "key not found" ? 404 : 400);
    return jsonResponse(result);
  }

  // Real chat completion test - sends a minimal /v1/messages or /v1/chat/completions
  // request using the matrix-selected adapter + auth. Body: { name, id?, model? }.
  if (url.pathname === "/api/providers/keys/chat-test" && req.method === "POST") {
    let rb: { name?: string; id?: string; model?: string; prompt?: string };
    try { rb = await req.json() as { name?: string; id?: string; model?: string; prompt?: string }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const provider = config.providers[name]!;
    const { chatTestProvider } = await import("../providers/api-keys");
    const result = await chatTestProvider(provider, { id: rb.id, model: rb.model, prompt: rb.prompt });
    return jsonResponse(result, "ok" in result && result.ok ? 200 : 400);
  }

  // Concurrent probe of all three adapters. Returns ordered results for the
  // user to pick from; never persists anything (read-only diagnostic).
  if (url.pathname === "/api/providers/probe-adapters" && req.method === "POST") {
    let rb: { name?: string };
    try { rb = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    const prov = config.providers[name]!;
    try {
      const { probeAllAdapters } = await import("../providers/catalog-models");
      const result = await probeAllAdapters(prov);
      return jsonResponse(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: msg }, 400);
    }
  }

  // Fetch the provider's live model list (or return cached `provider.models`). Used by the
  // Providers-page "拉取模型" button to populate the per-key test-model dropdown. Read-only,
  // does not touch cooldowns, does not rotate the active key, and only refreshes `provider.models`
  // when `?refresh=1` is set so the periodic catalog sync's cache is not churned.
  if (url.pathname === "/api/providers/models" && req.method === "POST") {
    let rb: { name?: string; refresh?: boolean };
    try { rb = await req.json() as { name?: string; refresh?: boolean }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const refresh = rb.refresh === true;
    const provider = config.providers[name];
    const cached = provider.models;
    if (!refresh && cached && cached.length > 0) {
      return jsonResponse({ models: cached, source: "cached" });
    }
    const pool: Array<{ key: string }> = [];
    if (provider.apiKeyPool && provider.apiKeyPool.length > 0) {
      for (const entry of provider.apiKeyPool) pool.push({ key: entry.key });
    } else if (provider.apiKey) {
      pool.push({ key: provider.apiKey });
    }
    if (pool.length === 0) return jsonResponse({ error: "no keys configured" }, 400);
    const { fetchProviderModels } = await import("../providers/catalog-models");
    const result = await fetchProviderModels(provider, pool);
    if ("error" in result) {
      const body: { error: string; hint?: string } = { error: result.error };
      if (result.hint) body.hint = result.hint;
      return jsonResponse(body, 400);
    }
    provider.models = result.models;
    saveConfig(config);
    return jsonResponse({ models: result.models, source: "live" });
  }

  // Persist the user's pick for the per-key test model. Body `{ model: string | null }`.
  // `null` clears the override so the probe falls back to defaultModel / hardcoded default.
  if (url.pathname === "/api/providers/test-model" && req.method === "POST") {
    let rb: { name?: string; model?: string | null };
    try { rb = await req.json() as { name?: string; model?: string | null }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const provider = config.providers[name];
    const raw = rb.model;
    if (raw === null || raw === "") {
      delete provider.testModel;
    } else {
      if (typeof raw !== "string") return jsonResponse({ error: "model must be a string or null" }, 400);
      provider.testModel = raw;
    }
    saveConfig(config);
    return jsonResponse({ testModel: provider.testModel ?? null });
  }

  // Probe all auth strategies for one provider (matrix UI). Body `{ name }`. Returns
  // per-strategy probe results so the dashboard can show the user which auth header
  // combination actually works at /v1/models. Read-only - does NOT modify config.
  if (url.pathname === "/api/providers/auth-matrix" && req.method === "POST") {
    let rb: { name?: string };
    try { rb = await req.json() as { name?: string }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const provider = config.providers[name];
    const pool: Array<{ key: string }> = [];
    if (provider.apiKeyPool && provider.apiKeyPool.length > 0) {
      for (const entry of provider.apiKeyPool) pool.push({ key: entry.key });
    } else if (provider.apiKey) {
      pool.push({ key: provider.apiKey });
    }
    if (pool.length === 0) return jsonResponse({ error: "no keys configured" }, 400);
    const { probeAuthMatrix, AUTH_STRATEGIES, defaultStrategiesFor, SUPPORTED_ADAPTERS } = await import("../providers/auth-matrix");
    const key = pool[0].key;
    const matrix = await probeAuthMatrix(provider, name, key);
    return jsonResponse({
      name,
      current: provider.modelListAuth ?? null,
      currentAdapter: matrix.currentAdapter,
      recommended: matrix.recommended,
      probeTimeoutMs: matrix.probeTimeoutMs,
      adapters: SUPPORTED_ADAPTERS,
      strategies: AUTH_STRATEGIES,
      rows: matrix.rows.map((r) => ({
        adapter: r.adapter,
        cells: Object.fromEntries(
          AUTH_STRATEGIES.map((s) => [s, r.cells[s]]),
        ),
      })),
    });
  }

  // Persist the user's choice of auth strategy for one provider. Body
  // `{ name, strategy }`. Pass `strategy: null` to clear the explicit override and
  // fall back to auto-detection.
  if (url.pathname === "/api/providers/auth" && req.method === "POST") {
    let rb: { name?: string; strategy?: string | null; adapter?: string | null };
    try { rb = await req.json() as { name?: string; strategy?: string | null; adapter?: string | null }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = (rb.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const { AUTH_STRATEGIES } = await import("../providers/auth-matrix");
    const provider = config.providers[name];
    const raw = rb.strategy;
    if (raw === null || raw === "") {
      delete provider.modelListAuth;
    } else if (typeof raw !== "string" || !AUTH_STRATEGIES.includes(raw as typeof AUTH_STRATEGIES[number])) {
      return jsonResponse({ error: `strategy must be one of: ${AUTH_STRATEGIES.join(", ")}, or null to clear` }, 400);
    } else {
      provider.modelListAuth = raw as typeof AUTH_STRATEGIES[number];
    }
    if (rb.adapter !== undefined) {
      const { SUPPORTED_ADAPTERS } = await import("../providers/auth-matrix");
      if (rb.adapter !== null && rb.adapter !== "" && (typeof rb.adapter !== "string" || !(SUPPORTED_ADAPTERS as readonly string[]).includes(rb.adapter))) {
        return jsonResponse({ error: `adapter must be one of: ${SUPPORTED_ADAPTERS.join(", ")}, or null` }, 400);
      }
      if (typeof rb.adapter === "string" && rb.adapter !== "") {
        provider.adapter = rb.adapter;
      }
    }
    saveConfig(config);
    return jsonResponse({ adapter: provider.adapter, modelListAuth: provider.modelListAuth ?? null });
  }

  // ---------------------------------------------------------------------------
  // API Keys management
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/keys" && req.method === "GET") {
    const keys = config.apiKeys ?? [];
    const port = config.port ?? 10100;
    const bind = config.hostname ?? "127.0.0.1";
    const { listLanHosts } = await import("../lib/local-addresses");
    // The LAN variants are what a colleague can actually paste; `bind` may be 0.0.0.0
    // (meaning "all interfaces", not a usable address) so it is never shown as one.
    const lanHosts = listLanHosts();
    return jsonResponse({
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 8) + "...", createdAt: k.createdAt })),
      endpoint: `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}/v1/responses`,
      bindHostname: bind,
      port,
      lanHosts,
      altEndpoints: lanHosts.map(host => `http://${host}:${port}/v1/responses`),
    }, 200, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "POST") {
    const body = await req.json() as { name?: string };
    const name = (body.name ?? "").trim() || "default";
    // Generate key from provider keys hash + random salt
    const providerKeys = Object.values(config.providers).map(p => p.apiKey ?? "").filter(Boolean).join("|");
    const salt = crypto.randomUUID();
    const hashInput = `${providerKeys}|${salt}|${Date.now()}`;
    const hashBuf = new Bun.CryptoHasher("sha256").update(hashInput).digest();
    const key = "ocx_" + Buffer.from(hashBuf).toString("hex").slice(0, 40);
    const entry = { id: crypto.randomUUID(), name, key, createdAt: new Date().toISOString() };
    config.apiKeys = [...(config.apiKeys ?? []), entry];
    saveConfig(config);
    return jsonResponse({ id: entry.id, name: entry.name, key: entry.key, createdAt: entry.createdAt }, 201, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await req.json() as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    saveConfig(config);
    return jsonResponse({ success: true }, 200, req, config);
  }
  if (url.pathname === "/api/keys/reveal" && req.method === "POST") {
    let rb: { id?: string };
    try { rb = await req.json() as { id?: string }; }
    catch { return jsonResponse({ error: "invalid JSON body" }, 400, req, config); }
    const rid = rb.id?.trim();
    if (!rid) return jsonResponse({ error: "id required" }, 400, req, config);
    const entry = (config.apiKeys ?? []).find(k => k.id === rid);
    if (!entry) return jsonResponse({ error: "api key not found" }, 404, req, config);
    // Audit: log who revealed which key. Key NAME is included (admin ops needs to
    // know which human-readable key got exposed); full KEY CONTENT is never logged.
    const ts = new Date().toISOString();
    const from = sourceIp ?? "unknown";
    console.log(`[opencodex-audit] revealed apiKey name=${entry.name} id=${rid} from=${from} at=${ts}`);
    markActivity(`revealed apiKey name=${entry.name} id=${rid} from=${from}`);
    return jsonResponse({ id: entry.id, name: entry.name, key: entry.key }, 200, req, config);
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { restoreNativeCodex } = await import("../codex/inject");
    const { stopServiceIfInstalled } = await import("../service");
    stopServiceIfInstalled();
    const restore = restoreNativeCodex();
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    return jsonResponse(restore.success
      ? { success: true, message: "Proxy stopping, native Codex restored." }
      : { success: false, message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.` });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("../codex/auth-api");
    return handleCodexAuthAPI(req, url, config);
  }

  return null;
}

/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/codex endpoints
 * share the same fetch, the same per-provider cache (dedups Codex's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
export async function fetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("../codex/catalog");
  return gatherRoutedModels(config);
}
