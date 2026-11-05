import { redactSecretString } from "../lib/redact";

/**
 * Generic fallback for provider HTTP error bodies, used when an adapter does not implement the
 * optional `formatErrorBody` hook (only the Google family and Kiro do).
 *
 * Why this exists: the web-search sidecar loop is the ONLY place where a routed provider's
 * non-2xx body is read (src/web-search/loop.ts). Without a formatter, the body was discarded and
 * the client saw a bare `Provider error 400` — no reason, and crucially no
 * `context_length_exceeded` signal, so Codex could never enter its auto-compaction path and the
 * turn simply died. That is the blindness this module removes.
 *
 * Safety contract (mirrors google-errors.ts / kiro-errors.ts):
 * - The output is fully redacted (`redactSecretString`) and length-bounded.
 * - Only a known, allow-listed set of JSON fields is read; the raw body is never echoed.
 * - A body that is not JSON, or that carries no recognizable field, yields no detail at all.
 */

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;

/** Maximum characters of provider detail kept in a client-facing message. */
const DETAIL_LIMIT = 500;

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sanitizeDetail(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

/**
 * Read the human-readable detail out of a provider error body.
 *
 * Handles the two envelope shapes seen in the field:
 * - Anthropic-style: `{"error":{"type":"...","message":"..."}}`
 * - Relay/nested style: `{"error":{"type":"prompt_too_long","message":"{\"code\":11115,\"msg\":\"prompt is too long: ..."}}`
 *   where the inner `message` is itself a JSON string carrying the real detail.
 */
function extractDetail(payloadText: string): string | undefined {
  const trimmed = payloadText.trim();
  if (!trimmed) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON: an upstream may answer with plain text. Accept it only when it looks like a short
    // human message (no newlines, bounded) — never echo an arbitrary HTML page or stack trace.
    if (!trimmed.startsWith("<") && trimmed.length <= DETAIL_LIMIT && !trimmed.includes("\n")) {
      return trimmed;
    }
    return undefined;
  }

  if (typeof parsed === "string") return safeString(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const root = parsed as Record<string, unknown>;
  const errorNode = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? (root.error as Record<string, unknown>)
    : undefined;

  // Prefer the nested `error.message`, then top-level `message` / `msg` / `detail`.
  const candidates = [
    errorNode?.message,
    errorNode?.msg,
    root.message,
    root.msg,
    root.detail,
  ];

  for (const candidate of candidates) {
    const text = safeString(candidate);
    if (!text) continue;
    // Relay envelopes nest the real reason as a JSON STRING inside `message`. Unwrap one level
    // so the actual `msg` (e.g. "prompt is too long: N tokens > M maximum") is what surfaces.
    if (text.startsWith("{")) {
      try {
        const inner = JSON.parse(text) as Record<string, unknown>;
        const innerMsg = safeString(inner.msg) ?? safeString(inner.message) ?? safeString(inner.detail);
        if (innerMsg) return innerMsg;
      } catch {
        // Not nested JSON — fall through and use the raw text.
      }
    }
    return text;
  }

  return undefined;
}

/**
 * Client-safe detail for a provider HTTP error body, or undefined when the body carries nothing
 * safely extractable. Never returns raw body text that was not read from an allow-listed field.
 */
export function safeProviderErrorDetail(payloadText: string): string | undefined {
  const detail = extractDetail(payloadText);
  if (!detail) return undefined;
  const sanitized = sanitizeDetail(detail).slice(0, DETAIL_LIMIT).trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * A provider error message that always names the overflow case, because that is the one whose
 * signal the client needs to act on: `classifyError` keys off the message text to map it to
 * `context_length_exceeded`, which is what triggers Codex's auto-compaction.
 */
export function providerErrorMessage(status: number, detail: string | undefined): string {
  return detail ? `Provider error ${status}: ${detail}` : `Provider error ${status}`;
}
