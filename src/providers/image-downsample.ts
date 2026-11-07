/**
 * Image downsampling settings: a provider default plus a per-model override.
 *
 * WHY this shape: it mirrors the context-cap settings exactly (`providerContextCaps` +
 * `modelContextOverrides`), so the same three-state control (follow the provider / force on /
 * force off) works for both and the UI reuses one component. The operator needs the
 * granularity because the answer depends on the model: a screenshot fed to a vision-native
 * model is worth keeping sharp, while the same screenshot on a text-only relay is dead
 * weight that should be shrunk (or dropped) rather than billed at full size.
 *
 * The default is OFF: downsampling changes what the upstream sees, so it is an explicit
 * operator decision, never a silent default.
 */

import type { OcxConfig } from "../types";

export interface ImageDownsampleSettings {
  /** The global default (unset = off). */
  defaultEnabled: boolean;
  /** Per-provider override. `undefined` = inherit the global default. */
  providers: Record<string, boolean>;
  /** Per-model override, keyed by the routed id ("<provider>/<model>"). */
  models: Record<string, boolean>;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === true || entry === false) out[key] = entry;
  }
  return out;
}

/** The full settings picture, for the management API and the GUI. */
export function imageDownsampleSettings(
  config: Pick<OcxConfig, "imageDownsample" | "providerImageDownsample" | "modelImageDownsample">,
): ImageDownsampleSettings {
  return {
    defaultEnabled: config.imageDownsample === true,
    providers: booleanRecord(config.providerImageDownsample),
    models: booleanRecord(config.modelImageDownsample),
  };
}

/**
 * Resolve the effective switch for one request.
 *
 * Priority: the model override wins, then the provider override, then the global default.
 * A routed model id may already be namespaced ("provider/model") or bare; both forms are
 * accepted so the caller does not have to know which one the router produced.
 */
export function resolveImageDownsampleEnabled(
  config: Pick<OcxConfig, "imageDownsample" | "providerImageDownsample" | "modelImageDownsample">,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): boolean {
  const settings = imageDownsampleSettings(config);
  const model = modelId ?? "";
  const provider_ = provider ?? "";
  const namespaced = provider_ && model ? `${provider_}/${model}` : null;
  const candidates = [namespaced, model.includes("/") ? model : null];
  for (const key of candidates) {
    if (!key) continue;
    const override = settings.models[key];
    if (override !== undefined) return override;
  }
  if (provider_ && settings.providers[provider_] !== undefined) {
    return settings.providers[provider_];
  }
  return settings.defaultEnabled;
}

/** Set (or clear) a provider-level override. */
export function setProviderImageDownsample(
  config: OcxConfig,
  provider: string,
  enabled: boolean | null,
): void {
  const next = booleanRecord(config.providerImageDownsample);
  if (enabled === null) delete next[provider];
  else next[provider] = enabled;
  if (Object.keys(next).length > 0) config.providerImageDownsample = next;
  else delete config.providerImageDownsample;
}

/** Set (or clear) a model-level override. */
export function setModelImageDownsample(
  config: OcxConfig,
  modelId: string,
  enabled: boolean | null,
): void {
  const next = booleanRecord(config.modelImageDownsample);
  if (enabled === null) delete next[modelId];
  else next[modelId] = enabled;
  if (Object.keys(next).length > 0) config.modelImageDownsample = next;
  else delete config.modelImageDownsample;
}

/** Set (or clear) the global default. */
export function setGlobalImageDownsample(config: OcxConfig, enabled: boolean | null): void {
  if (enabled === null) delete config.imageDownsample;
  else config.imageDownsample = enabled;
}
