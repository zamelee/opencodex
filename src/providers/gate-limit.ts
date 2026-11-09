/**
 * The per-model MANUAL gate: the ceiling the proxy brakes at before a request goes upstream.
 *
 * WHY a manual knob at all: the gate we can LEARN is only what the upstream bothered to tell
 * us, and plenty of upstreams refuse with a bare error code ("context window exceeds limit
 * (2013)") that names no ceiling. An operator who knows the real number - or who has measured
 * a bracket - can write it down here.
 *
 * THREE STATES per model:
 *   - a number:     our brake ceiling. The proxy degrades images / trims the request so the
 *                   upstream never has to refuse it.
 *   - "upstream":   NO local gate. The request goes out as it is; the upstream's own 400 is
 *                   the truth, and the anti-loop circuit keeps a refusal from becoming an
 *                   endless compaction cycle.
 *   - unset:       follow what we know (the learned gate, else the declared window).
 *
 * The manual value WINS over the learned one: the learned number is a historical observation,
 * this is the operator's current decision.
 */

import type { OcxConfig } from "../types";

/** What an operator can set for one model. */
export type GateLimitSetting = number | "upstream";

export interface GateLimitSettings {
  /** Per-model overrides, keyed by the routed id ("<provider>/<model>"). */
  models: Record<string, GateLimitSetting>;
}

/** How the gate is decided for one route. */
export interface ResolvedGateLimit {
  /** "manual" = the operator set a number; "upstream" = no local gate; "auto" = follow what we know. */
  mode: "manual" | "upstream" | "auto";
  /** The manual ceiling, when mode is "manual". */
  limit?: number;
}

function gateRecord(value: unknown): Record<string, GateLimitSetting> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, GateLimitSetting> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === "upstream") out[key] = "upstream";
    else if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = Math.floor(entry);
  }
  return out;
}

/** The full settings picture, for the management API and the GUI. */
export function gateLimitSettings(
  config: Pick<OcxConfig, "modelGateLimits">,
): GateLimitSettings {
  return { models: gateRecord(config.modelGateLimits) };
}

/**
 * Resolve the gate for one route.
 *
 * The model id may be namespaced ("provider/model") or bare; both forms are accepted, because
 * the router and the GUI do not always agree on which one they hold.
 */
export function resolveGateLimit(
  config: Pick<OcxConfig, "modelGateLimits">,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): ResolvedGateLimit {
  const settings = gateLimitSettings(config);
  const model = modelId ?? "";
  const providerName = provider ?? "";
  const namespaced = providerName && model ? `${providerName}/${model}` : null;
  const candidates = [namespaced, model.includes("/") ? model : null];
  for (const key of candidates) {
    if (!key) continue;
    const override = settings.models[key];
    if (override === undefined) continue;
    if (override === "upstream") return { mode: "upstream" };
    return { mode: "manual", limit: override };
  }
  return { mode: "auto" };
}

/** Set (or clear, with null) the manual gate for one model. */
export function setModelGateLimit(
  config: OcxConfig,
  key: string,
  value: GateLimitSetting | null,
): void {
  const next = gateRecord(config.modelGateLimits);
  if (value === null) delete next[key];
  else next[key] = value;
  config.modelGateLimits = next;
}
