import type { OcxConfig } from "../types";

export const DEFAULT_PROVIDER_CONTEXT_CAP = 350_000;
/**
 * Sentinel key inside `contextCapValue` records that holds the per-config global default. When
 * `contextCapValue` was a single number (legacy form), the transform in src/config.ts promotes it
 * to `{ __default: <n> }` so a single number can be queried uniformly.
 */
export const DEFAULT_CONTEXT_CAP_KEY = "__default";

export type CapSource = "override_value" | "override_exempt" | "provider" | "none";

export interface ResolvedContextCap {
  /** Effective context window the model will advertise to Codex. */
  effective: number | undefined;
  /** Catalog-native context window (pre-cap). */
  native: number | undefined;
  /** Which priority-chain branch produced the effective value. */
  source: CapSource;
  /** True when the effective value differs from the catalog-native value because of a cap. */
  capped: boolean;
  /** Numeric cap value when one applies, else undefined. */
  cap: number | undefined;
}

function isValidContextCap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidContextCapValue(v: unknown): v is number {
  return isValidContextCap(v);
}

/** Coerce a `contextCapValue` field into the per-provider record form. Returns {} when unset. */
export function contextCapValueRecord(value: OcxConfig["contextCapValue"]): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value === "number") return isValidContextCapValue(value) ? { [DEFAULT_CONTEXT_CAP_KEY]: Math.floor(value) } : {};
  if (typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isValidContextCapValue(v)) out[k] = Math.floor(v);
    }
    return out;
  }
  return {};
}

/**
 * Resolve the cap value for a specific provider: per-provider entry, falling back to
 * `__default`, then to DEFAULT_PROVIDER_CONTEXT_CAP. Pass `provider === null` (or omit) to
 * receive the global default only.
 */
export function providerCapValue(config: Pick<OcxConfig, "contextCapValue">, provider: string | null = null): number {
  const record = contextCapValueRecord(config.contextCapValue);
  if (provider && isValidContextCapValue(record[provider])) return record[provider];
  if (isValidContextCapValue(record[DEFAULT_CONTEXT_CAP_KEY])) return record[DEFAULT_CONTEXT_CAP_KEY];
  return DEFAULT_PROVIDER_CONTEXT_CAP;
}

export function providerContextCap(config: Pick<OcxConfig, "providerContextCaps" | "contextCapValue">, provider: string): number | undefined {
  const entry = config.providerContextCaps?.[provider];
  // Boolean toggle (new schema) or legacy number (in-memory config objects that bypassed the
  // schema transform) both count as "this provider wants a cap".
  if (entry === undefined) return undefined;
  return providerCapValue(config, provider);
}

export function providerContextCaps(config: Pick<OcxConfig, "providerContextCaps">): Record<string, boolean> {
  const caps = config.providerContextCaps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return {};
  const out: Record<string, boolean> = {};
  for (const [provider, value] of Object.entries(caps)) {
    if (value === true || value === false) out[provider] = value;
  }
  return out;
}

export function applyProviderContextCap(contextWindow: number | undefined, cap: number | undefined): number | undefined {
  if (!isValidContextCap(cap)) return contextWindow;
  if (!isValidContextCap(contextWindow)) return contextWindow;
  return contextWindow > cap ? cap : contextWindow;
}

/**
 * Effective global cap value: explicit per-provider or __default value, else the built-in
 * default. Backwards-compatible single-number callers (e.g. legacy tests) get the same value
 * they would have before the upgrade because the schema transform rewrites a single number to
 * `{ __default: n }`.
 */
export function globalContextCapValue(config: Pick<OcxConfig, "contextCapValue">): number {
  return providerCapValue(config, null);
}

/**
 * Resolve the *effective* context cap for a single model. The priority chain mirrors what the
 * Gemini-driven R1–R6 design produced, but every branch is `Math.min`-clamped against the
 * catalog-native window so a misconfigured cap can never advertise a window larger than the
 * upstream actually supports.
 */
export function resolveEffectiveContextCap(
  modelId: string | null,
  provider: string | null,
  catalogWindow: number | undefined,
  config: Pick<OcxConfig, "providerContextCaps" | "contextCapValue" | "modelContextOverrides">,
): ResolvedContextCap {
  const native = isValidContextCap(catalogWindow) ? catalogWindow : undefined;
  const overrides = config.modelContextOverrides;
  const namespaced = provider && modelId ? `${provider}/${modelId}` : null;

  if (namespaced && overrides) {
    const raw = Object.prototype.hasOwnProperty.call(overrides, namespaced) ? overrides[namespaced] : undefined;
    if (raw === false) {
      return { effective: native, native, source: "override_exempt", capped: false, cap: undefined };
    }
    if (isValidContextCap(raw)) {
      const cap = Math.min(Math.floor(raw), native ?? Math.floor(raw));
      return {
        effective: cap,
        native,
        source: "override_value",
        capped: native !== undefined && cap < native,
        cap,
      };
    }
  }

  if (provider && config.providerContextCaps?.[provider] === true) {
    const providerDefault = providerCapValue(config, provider);
    const cap = native !== undefined ? Math.min(providerDefault, native) : providerDefault;
    return {
      effective: cap,
      native,
      source: "provider",
      // The cap "actually lowered" the catalog window iff the configured cap (providerDefault) is
      // strictly less than the catalog-native window. After Math.min, effective always <= native.
      capped: native !== undefined && providerDefault < native,
      cap: providerDefault,
    };
  }

  return { effective: native, native, source: "none", capped: false, cap: undefined };
}

export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean): void {
  const next = providerContextCaps(config);
  if (enabled) next[provider] = true;
  else delete next[provider];
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}

/**
 * Set the global cap value. Accepts either a number (rewritten to the `__default` slot) or a
 * per-provider record (replaces the whole map). All currently-enabled providers are repointed
 * to the new global default; per-provider overrides in the record are preserved.
 */
export function setGlobalContextCapValue(config: OcxConfig, value: number | Record<string, number>): void {
  const record = contextCapValueRecord(value);
  if (Object.keys(record).length === 0) return;
  config.contextCapValue = record;
  const caps = providerContextCaps(config);
  const globalDefault = record[DEFAULT_CONTEXT_CAP_KEY] ?? DEFAULT_PROVIDER_CONTEXT_CAP;
  // Repoint providers without their own record entry to the new global default.
  for (const provider of Object.keys(caps)) {
    if (caps[provider] !== true) continue;
    // Per-provider cap values live in contextCapValue; the providerContextCaps map is boolean
    // only, so no mutation needed beyond refreshing contextCapValue (already done above).
  }
  if (Object.keys(caps).length > 0 && !record[DEFAULT_CONTEXT_CAP_KEY] && globalDefault === DEFAULT_PROVIDER_CONTEXT_CAP) {
    // nothing else to repoint
  }
}

/** Set a per-provider cap value (preserves other providers, refreshes the `__default` slot too). */
export function setProviderCapValue(config: OcxConfig, provider: string, value: number | null): void {
  const record = contextCapValueRecord(config.contextCapValue);
  if (value === null) delete record[provider];
  else record[provider] = Math.floor(value);
  config.contextCapValue = record;
}

/** Enable or clear the cap for every named provider at the current global value, or clear all. */
export function setAllProviderContextCaps(config: OcxConfig, providerNames: string[], enabled: boolean): void {
  if (!enabled) {
    delete config.providerContextCaps;
    return;
  }
  const next: Record<string, boolean> = {};
  for (const name of providerNames) next[name] = true;
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}

/** Set or clear a single per-model override. Pass `null` to clear the entry. */
export function setModelContextOverride(
  config: OcxConfig,
  namespacedModelId: string,
  value: number | false | null,
): void {
  const next: Record<string, number | false> = { ...(config.modelContextOverrides ?? {}) };
  if (value === null) delete next[namespacedModelId];
  else next[namespacedModelId] = value;
  if (Object.keys(next).length > 0) config.modelContextOverrides = next;
  else delete config.modelContextOverrides;
}

/** Read-only view of the per-model override map, normalised. */
export function modelContextOverrides(config: Pick<OcxConfig, "modelContextOverrides">): Record<string, number | false> {
  const src = config.modelContextOverrides;
  if (!src || typeof src !== "object" || Array.isArray(src)) return {};
  const out: Record<string, number | false> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === false || isValidContextCap(v)) out[k] = v === false ? false : Math.floor(v);
  }
  return out;
}
