/**
 * One normalized reading of an upstream error body.
 *
 * WHY: on 2026-11-16 a batch of 400s came back from `m.aiio.chat` carrying
 *
 *   {"error":{"type":"prompt_too_long","message":"{\"code\":11115,\"msg\":\"prompt is too long:
 *    5010629 tokens \\u003e 1048576 maximum\"}"}}
 *
 * The upstream had told us BOTH numbers, but the old parser read the RAW body with a regex
 * after a single round of `\uXXXX` unescaping. The body is encoded TWICE (the inner error
 * object is a JSON string inside a JSON string), so one unescape left a stray backslash in
 * front of ">" and the pattern `(\d+)\s*tokens?\s*>\s*(\d+)\s+maximum` never matched. The
 * ASCII phrase "prompt is too long" survived the escaping, so the proxy knew the request was
 * rejected for being too long but never learned the ceiling: six refusals, six
 * "rejected without limit", no learned gate, no learned token scale.
 *
 * WHAT: peel the JSON layers with BOUNDS, then read the numbers and the family from the
 * DECODED text. Decoding is the part that was broken, so it gets the guards; the reading
 * stays deterministic.
 *
 * The bounds exist because an error body is attacker- and accident-reachable input: it may be
 * huge, may be malformed, may be nested far deeper than any real upstream goes. Nothing in
 * here may throw, loop forever, or allocate without limit.
 */

/** How many JSON layers we are willing to peel off one body. */
export const ERROR_DECODE_MAX_DEPTH = 4;

/** A body larger than this is not parsed; only its head is read. */
export const ERROR_DECODE_MAX_BODY_CHARS = 64 * 1024;

/** Upper bound on the strings we keep from one body. */
export const ERROR_DECODE_MAX_STRINGS = 256;

/** Upper bound on the total characters we keep from one body. */
export const ERROR_DECODE_MAX_TOTAL_CHARS = 64 * 1024;

/** The message we keep for display/logging is capped well below the body size. */
export const ERROR_DECODE_MAX_MESSAGE_CHARS = 2_000;

/**
 * The families the proxy reacts to differently.
 *
 * `prompt_too_long` and `context_length_exceeded` are deliberately NOT merged: the upstream
 * wording differs, and a route may quote one ceiling for one and not the other. They are kept
 apart until measurements show they behave identically.
 */
export type UpstreamErrorFamily =
  | "prompt_too_long"
  | "context_length_exceeded"
  | "quota_exhausted"
  | "content_policy"
  | "auth"
  | "unknown";

export interface NormalizedUpstreamError {
  /** Which family the upstream's refusal belongs to. */
  family: UpstreamErrorFamily;
  /** Whether the family came from a structured field, from the text, from the LLM assist, or from neither. */
  familySource: "structured" | "text" | "llm" | "none";
  /** The upstream's own `type` field, when it is not itself a family name. */
  providerType?: string;
  /** The upstream's own numeric `code` field, when it had one. */
  providerCode?: number;
  /** The HTTP status the refusal arrived with. */
  httpStatus?: number;
  /** The request size the upstream quoted, when it said one. */
  observedTokens?: number;
  /** The ceiling the upstream quoted, when it said one. */
  contextLimit?: number;
  /**
   * True when the structured fields and the message text point at DIFFERENT families.
   *
   * A conflict means one of the two is lying; the proxy keeps its own reading and flags the
   * conflict rather than silently learning from the wrong one.
   */
  classificationConflict: boolean;
  /** The message text the numbers/family were read from. */
  message?: string;
  /** How many JSON layers were peeled off the body. */
  decodedLayers: number;
  /** True when the body was too big or too deep to read completely. */
  truncated: boolean;
}

/**
 * The shapes an upstream uses to state a hard ceiling.
 *
 * The first one is the MiniMax / new-api shape and the only one that carries BOTH the request
 * size and the ceiling. The rest are single-number shapes: the ceiling alone.
 */
const TOKEN_GATE_SHAPE = /(\d+)\s*tokens?\s*>\s*(\d+)\s+maximum/i;

const GATE_SHAPES: RegExp[] = [
  /maximum\s+context\s+length(?:\s+is|:)\s*(\d+)/i,
  /context[_\s-]length[_\s-]exceeded[^\d]{0,60}(\d+)/i,
  /exceed(?:s|ed)?\s+(?:the\s+)?context\s+limit[^\d]{0,20}(\d+)/i,
  /(?:max(?:imum)?\s+)?(?:token\s+)?limit\s*(?:is|of|:)\s*(\d+)/i,
];

/**
 * Families a STRUCTURED field can name.
 *
 * A structured `type` is the upstream's own machine-readable verdict and outranks anything we
 * could infer from prose.
 */
const STRUCTURED_FAMILY: Array<{ re: RegExp; family: UpstreamErrorFamily }> = [
  { re: /prompt[_\s-]?too[_\s-]?long/i, family: "prompt_too_long" },
  { re: /context[_\s-]?(length|window)[_\s-]?exceeded/i, family: "context_length_exceeded" },
  { re: /insufficient[_\s-]?quota|quota[_\s-]?(exhausted|exceeded)/i, family: "quota_exhausted" },
  { re: /content[_\s-]?(policy|filter|moderation)/i, family: "content_policy" },
  { re: /authentication|invalid[_\s-]?api[_\s-]?key|unauthorized/i, family: "auth" },
];

/**
 * Families the MESSAGE TEXT can name.
 *
 * These are the phrases the upstreams we have actually seen use, plus the historical ones the
 * old parser already recognised (a refusal we used to count must not stop counting).
 */
const TEXT_FAMILY: Array<{ re: RegExp; family: UpstreamErrorFamily }> = [
  { re: /prompt\s+is\s+too\s+long/i, family: "prompt_too_long" },
  // The machine spelling shows up in plain-text bodies too (a body that is not JSON at all,
  // or one that was truncated before it could be parsed).
  { re: /prompt[_\s-]?too[_\s-]?long/i, family: "prompt_too_long" },
  { re: /input\s+(?:is\s+)?too\s+long/i, family: "prompt_too_long" },
  { re: /too\s+many\s+tokens/i, family: "prompt_too_long" },
  { re: /context\s+window\s+exceeds?\s+limit/i, family: "context_length_exceeded" },
  { re: /context[_\s-]length[_\s-]exceeded/i, family: "context_length_exceeded" },
  { re: /maximum\s+context\s+length/i, family: "context_length_exceeded" },
  { re: /exceeds?\s+the\s+(?:maximum|context)/i, family: "context_length_exceeded" },
  { re: /not\s+allowed\s+in\s+your\s+plan/i, family: "quota_exhausted" },
  { re: /insufficient[_\s-]?quota|quota[_\s-]?(exhausted|exceeded)/i, family: "quota_exhausted" },
  { re: /content\s+policy|content\s+filter/i, family: "content_policy" },
  { re: /invalid[_\s-]?api[_\s-]?key|authentication|unauthorized/i, family: "auth" },
];

/** Keys whose values are the upstream's own machine-readable verdict. */
const STRUCTURED_KEYS = new Set(["type", "code", "errcode", "error_code", "errtype"]);

/**
 * Decode the JSON string escapes that hide an upstream's numbers from a pattern.
 *
 * A body whose innermost text was never JSON-wrapped can still arrive escaped (the upstream
 * built the message by hand), so this stays as a safety net under the JSON peeling. It is NOT
 * the primary decoder any more: peeling the layers is, because JSON.parse decodes escapes
 * correctly and for the right number of levels.
 */
export function decodeJsonEscapes(text: string): string {
  if (!text.includes("\\u")) return text;
  return text
    .replace(/\\u003[cC]/g, "<")
    .replace(/\\u003[eE]/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\u0027/g, "'")
    .replace(/\\u0060/g, "`")
    .replace(/\\u003[dD]/g, "=")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u000[aA]/g, "\n")
    .replace(/\\u000[dD]/g, "\r")
    .replace(/\\u000[tT]/g, "\t");
}

interface CollectedText {
  /** Every string we found, outermost first, deepest last. */
  strings: string[];
  /** The upstream's own `type`/`code` fields, wherever they were. */
  structured: Array<{ key: string; value: string }>;
  /** How many JSON layers were peeled. */
  layers: number;
  /** True when we hit a bound. */
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does this string plausibly hold a JSON document we could peel one more layer off? */
function looksLikeJson(text: string): boolean {
  const head = text.trimStart()[0];
  return head === "{" || head === "[" || head === '"';
}

/**
 * Peel JSON layers off a body and collect every string and verdict field we meet.
 *
 * Bounded on all four axes that a hostile body could attack: depth, body size, number of
 * strings, and total characters kept.
 */
function collect(value: unknown, depth: number, out: CollectedText, budget: { left: number }): void {
  if (out.strings.length >= ERROR_DECODE_MAX_STRINGS || budget.left <= 0) {
    out.truncated = true;
    return;
  }
  if (typeof value === "string") {
    if (value.length > budget.left) {
      out.truncated = true;
      return;
    }
    budget.left -= value.length;
    out.strings.push(value);
    if (depth < ERROR_DECODE_MAX_DEPTH && looksLikeJson(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        out.layers += 1;
        collect(parsed, depth + 1, out, budget);
      } catch {
        /* not JSON after all - a plain message, which is the normal ending */
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, depth, out, budget);
      if (out.truncated) return;
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (STRUCTURED_KEYS.has(key.toLowerCase())) {
        if (typeof child === "string") out.structured.push({ key, value: child });
        else if (typeof child === "number" && Number.isFinite(child)) {
          out.structured.push({ key, value: String(child) });
        }
      }
      collect(child, depth, out, budget);
      if (out.truncated) return;
    }
  }
}

/** Read the ceiling (and the request size, when the upstream quoted one) out of one text. */
function readGate(text: string): { limit?: number; observed?: number } {
  const both = text.match(TOKEN_GATE_SHAPE);
  if (both) {
    const limit = Number(both[2]);
    const observed = Number(both[1]);
    if (Number.isFinite(limit) && limit > 0) {
      return {
        limit,
        ...(Number.isFinite(observed) && observed > 0 ? { observed } : {}),
      };
    }
  }
  for (const shape of GATE_SHAPES) {
    const m = text.match(shape);
    if (!m) continue;
    const limit = Number(m[1]);
    if (Number.isFinite(limit) && limit > 0) return { limit };
  }
  return {};
}

function matchFamily(text: string, table: Array<{ re: RegExp; family: UpstreamErrorFamily }>):
  UpstreamErrorFamily | undefined {
  for (const { re, family } of table) {
    if (re.test(text)) return family;
  }
  return undefined;
}

/**
 * Normalize one upstream error body into a single reading.
 *
 * Never throws: a body that is malformed, enormous, or nested absurdly deep simply yields a
 * thinner reading.
 */
export function normalizeUpstreamError(
  raw: string,
  opts: { httpStatus?: number } = {},
): NormalizedUpstreamError {
  const result: NormalizedUpstreamError = {
    family: "unknown",
    familySource: "none",
    classificationConflict: false,
    decodedLayers: 0,
    truncated: false,
    ...(opts.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
  };
  if (!raw) return result;

  let body = raw;
  if (body.length > ERROR_DECODE_MAX_BODY_CHARS) {
    result.truncated = true;
    body = body.slice(0, ERROR_DECODE_MAX_BODY_CHARS);
  }

  const collected: CollectedText = { strings: [], structured: [], layers: 0, truncated: false };
  const budget = { left: ERROR_DECODE_MAX_TOTAL_CHARS };

  // The raw text is always a candidate: it is what the old parser read, and keeping it means
  // no body shape that used to parse stops parsing.
  collected.strings.push(body);

  let root: unknown = body;
  try {
    root = JSON.parse(body);
    collected.layers += 1;
  } catch {
    root = body;
  }
  collect(root, 1, collected, budget);

  result.decodedLayers = collected.layers;
  result.truncated = result.truncated || collected.truncated;

  // Deepest first: the innermost message is the upstream's own wording, while outer layers
  // may carry request ids and other numbers we must not read as token counts.
  const texts = collected.strings.slice().reverse().map(decodeJsonEscapes);
  // The human-readable text: the innermost string that is not itself a JSON document. This
  // has to exist even when nothing was recognized, because "we could not read this" is
  // exactly the case the optional LLM assist is there for.
  const plainText = texts.find((text) => !looksLikeJson(text)) ?? texts[0];

  let limit: number | undefined;
  let observed: number | undefined;
  let message: string | undefined = plainText;
  for (const text of texts) {
    const gate = readGate(text);
    if (gate.limit !== undefined) {
      limit = gate.limit;
      observed = gate.observed;
      message = text;
      break;
    }
  }

  let structuredFamily: UpstreamErrorFamily | undefined;
  for (const { key, value } of collected.structured) {
    const family = matchFamily(value, STRUCTURED_FAMILY);
    if (family) {
      structuredFamily = family;
      if (key.toLowerCase() === "type" && !matchFamily(value, STRUCTURED_FAMILY)) {
        result.providerType = value;
      }
      break;
    }
  }

  let textFamily: UpstreamErrorFamily | undefined;
  for (const text of texts) {
    const family = matchFamily(text, TEXT_FAMILY);
    if (family) {
      textFamily = family;
      if (message === undefined) message = text;
      break;
    }
  }

  const family = structuredFamily ?? textFamily ?? "unknown";
  result.family = family;
  result.familySource = structuredFamily ? "structured" : textFamily ? "text" : "none";
  result.classificationConflict = Boolean(structuredFamily && textFamily && structuredFamily !== textFamily);

  // A `type` that IS a family name is not a provider type - it is the family, already read.
  const typeEntry = collected.structured.find((s) => s.key.toLowerCase() === "type");
  if (typeEntry && !matchFamily(typeEntry.value, STRUCTURED_FAMILY)) {
    result.providerType = typeEntry.value;
  }
  const codeEntry = collected.structured.find((s) => s.key.toLowerCase() === "code" || s.key.toLowerCase() === "errcode" || s.key.toLowerCase() === "error_code");
  if (codeEntry) {
    const code = Number(codeEntry.value);
    if (Number.isFinite(code)) result.providerCode = code;
  }

  if (limit !== undefined) result.contextLimit = limit;
  if (observed !== undefined) result.observedTokens = observed;
  if (message !== undefined) {
    result.message = message.length > ERROR_DECODE_MAX_MESSAGE_CHARS
      ? message.slice(0, ERROR_DECODE_MAX_MESSAGE_CHARS)
      : message;
  }

  return result;
}

/** Is this family a refusal because the request did not fit the upstream's window? */
export function isSizeRejection(family: UpstreamErrorFamily): boolean {
  return family === "prompt_too_long" || family === "context_length_exceeded";
}

/** The gate a normalized reading carries, if the upstream named a ceiling. */
export interface NormalizedGate {
  limit: number;
  observedInputTokens?: number;
}

/** The ceiling this reading carries, if any. */
export function gateOf(normalized: NormalizedUpstreamError): NormalizedGate | undefined {
  if (normalized.contextLimit === undefined) return undefined;
  return {
    limit: normalized.contextLimit,
    ...(normalized.observedTokens !== undefined
      ? { observedInputTokens: normalized.observedTokens }
      : {}),
  };
}

/** The refusal this reading carries, with or without a usable ceiling. */
export function rejectionOf(normalized: NormalizedUpstreamError): {
  rejected: boolean;
  rejectedWithoutLimit: boolean;
  limit?: number;
  observedInputTokens?: number;
} {
  // A ceiling we could read IS a size refusal, even when the wording named no family.
  const rejected = isSizeRejection(normalized.family) || normalized.contextLimit !== undefined;
  if (!rejected) return { rejected: false, rejectedWithoutLimit: false };
  const gate = gateOf(normalized);
  return {
    rejected: true,
    rejectedWithoutLimit: gate === undefined,
    ...(gate?.limit !== undefined ? { limit: gate.limit } : {}),
    ...(gate?.observedInputTokens !== undefined
      ? { observedInputTokens: gate.observedInputTokens }
      : {}),
  };
}
