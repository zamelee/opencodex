/**
 * Probe the real context window for one model.
 *
 * "How big is the upstream's window, really?" has two possible answers, and we need both:
 *   - DECLARED: what the upstream's model metadata claims (often 1,000,000 for MiniMax).
 *   - LEARNED: the ceiling the upstream itself reported when it rejected a request
 *     ("prompt is too long: N tokens > M maximum"). M is the real hard limit and the only
 *     number the upstream actually enforces - a declared window is marketing. We learn it
 *     from the proxy's own error path, per provider.
 *
 * The suggestion is the learned ceiling when we have one, else the declared value, minus a
 * safety margin: Codex counts the prompt in its own tokenizer, which under-counts a
 * CJK/JSON/tool-output mix by ~25%, so the client's brake has to fire before the ceiling.
 */
import { learnedUpstreamPromptLimit } from "../lib/upstream-prompt-budget";

/** How much of the real ceiling we let the client believe it has. */
export const PROBE_SAFETY_MARGIN = 0.7;

export interface ContextWindowProbe {
  provider: string;
  model: string;
  /** What the upstream's metadata declares (may be missing). */
  declared?: number;
  /** The ceiling the upstream actually enforced, learned from its own error. */
  learned?: number;
  /** The number to advertise, already discounted by the safety margin. */
  suggestion?: number;
  /** Where `suggestion` came from. */
  source: "learned" | "declared" | "none";
  /** What we currently advertise for this model (provider cap / per-model override). */
  current?: number;
}

export function probeContextWindow(
  provider: string,
  model: string,
  opts: { declared?: number; current?: number } = {},
): ContextWindowProbe {
  const learned = learnedUpstreamPromptLimit(provider);
  const declared = typeof opts.declared === "number" && opts.declared > 0 ? opts.declared : undefined;
  const real = learned ?? declared;
  const source: ContextWindowProbe["source"] = learned !== undefined
    ? "learned"
    : declared !== undefined ? "declared" : "none";
  return {
    provider,
    model,
    ...(declared !== undefined ? { declared } : {}),
    ...(learned !== undefined ? { learned } : {}),
    ...(real !== undefined ? { suggestion: Math.floor(real * PROBE_SAFETY_MARGIN) } : {}),
    source,
    ...(typeof opts.current === "number" && opts.current > 0 ? { current: opts.current } : {}),
  };
}
