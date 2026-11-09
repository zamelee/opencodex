/**
 * Normalize a NON-JSON upstream error body into one readable line.
 *
 * Why this exists: `captureUpstreamError` only understands JSON error envelopes
 * (`{"error":{"message":...}}`). When an upstream returns an nginx/ALB HTML
 * error page, a plain-text reset notice, or an empty body, the JSON parse
 * fails and NOTHING is recorded, so /api/logs shows a bare "502" with no
 * reason, and the same raw HTML is echoed straight back to Codex as
 * "Provider error 502: <html>...".
 *
 * The goal is NOT to reproduce the body (it can be huge and can leak an
 * internal hostname). The goal is to name WHAT the upstream said in one line:
 * the status phrase if the body carries one, plus the content type and size so
 * "empty body" and "1 KB of HTML" stay distinguishable.
 */

const MAX_SUMMARY_CHARS = 200;

/** Content types whose body is a human-facing document, not a protocol payload. */
function isMarkup(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

/** Pull the most human-meaningful line out of an HTML error page. */
function summarizeHtml(text: string): string | null {
  // Prefer the <title>, then the first <h1>: gateway error pages put the
  // status phrase ("502 Bad Gateway", "504 Gateway Timeout") in exactly one
  // of those two.
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(text);
  if (title?.[1]) {
    const value = title[1].replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  const h1 = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i.exec(text);
  if (h1?.[1]) {
    const value = h1[1].replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return null;
}

/** Collapse markup to a bare-text fragment (used when there is no title/h1). */
function stripMarkup(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface UpstreamErrorBodySummary {
  /** One line naming what the upstream said. Empty when the body carried nothing usable. */
  summary: string;
  /** The raw body, flattened and truncated for the request log. */
  sample: string;
}

/**
 * Build a one-line description of a non-JSON upstream error body.
 *
 * `status` is the upstream HTTP status; `contentType` its response content
 * type; `text` the raw body (may be empty).
 */
export function summarizeUpstreamErrorBody(
  text: string,
  status: number,
  contentType: string | null | undefined,
): UpstreamErrorBodySummary {
  const raw = text ?? "";
  const trimmed = raw.trim();
  const ct = (contentType ?? "").toLowerCase();
  const bytes = Buffer.byteLength(raw, "utf-8");

  if (!trimmed) {
    return {
      summary: `Upstream returned an empty body (${describeType(ct, bytes)})`,
      sample: "",
    };
  }

  const summary = isMarkup(ct)
    ? summarizeHtml(trimmed) ?? stripMarkup(trimmed)
    : summarizePlainText(trimmed);

  if (!summary) {
    return {
      summary: `Upstream returned an unreadable body (${describeType(ct, bytes)})`,
      sample: truncateSample(raw),
    };
  }

  return {
    summary: `${summary} (${describeType(ct, bytes)})`,
    sample: truncateSample(raw),
  };
}

/** First meaningful line of a plain-text body (gateway notices are one-liners). */
function summarizePlainText(text: string): string | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const first = lines[0]!;
  // A body that is one huge blob (e.g. a minified stack trace) is not a line.
  if (first.length > MAX_SUMMARY_CHARS) return `${first.slice(0, MAX_SUMMARY_CHARS)}...`;
  return first;
}

function describeType(contentType: string, bytes: number): string {
  const type = contentType ? contentType.split(";")[0]!.trim() : "unknown content-type";
  const size = bytes === 0 ? "0 bytes" : `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${type}, ${size}`;
}

function truncateSample(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}...` : flat;
}
