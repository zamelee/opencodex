/**
 * Upstream-side token composition estimator.
 *
 * WHY: Codex counts its own prompt in ITS tokenizer and applies ITS auto-compact threshold
 * (window 1,000,000 / auto-compact 850,000). The upstream counts the request the PROXY
 * actually put on the wire, in the upstream's tokenizer. When those two disagree, Codex
 * never trips its brake and the upstream 400s with "prompt is too long: N tokens > M
 * maximum" — exactly the failure this module exists to make visible.
 *
 * The two known sources of divergence, both measurable here:
 *   1. Base64 image payloads. A native Anthropic image block is billed as VISION tokens
 *      (~1.6k tokens/image), but the same base64 that leaks into a TEXT block is billed as
 *      TEXT (~1.4 chars/token) — the shape that produced the observed
 *      "3,393,866 tokens > 1,048,576 maximum" 400. See anthropic-image-guard.ts.
 *   2. JSON wire overhead. The Responses-format history the client sent is re-serialized
 *      into the Anthropic wire format, so escaped newlines/quotes inflate the body.
 *
 * This estimator reports the CHAR composition of the outgoing wire body per content class
 * plus a per-class token estimate, so an operator can see WHICH class dominates instead of
 * guessing. It is deliberately a separate, opt-in measurement: nothing in the request path
 * depends on it.
 */

/** A data URL embedded in a text block — billed as TEXT upstream, not as vision. */
const DATA_URL_IN_TEXT = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/** Chars-per-token ratios used for the estimate. */
const PROSE_CHARS_PER_TOKEN = 4;
/** Base64 billed as text upstream: ~1.4 chars/token (documented in anthropic-image-guard.ts). */
const BASE64_TEXT_CHARS_PER_TOKEN = 1.4;
/** A native image block is billed as vision: ~1600 tokens for a typical screenshot. */
const VISION_TOKENS_PER_IMAGE = 1600;

export interface CompositionClass {
  /** Number of items of this class. */
  count: number;
  /** Total characters in this class (base64 measured by payload length). */
  chars: number;
  /** Estimated tokens for this class under upstream billing rules. */
  estimatedTokens: number;
}

export interface TokenComposition {
  /** Total characters across every class. */
  totalChars: number;
  /** Total estimated tokens across every class. */
  estimatedTokens: number;
  /** Per-class breakdown, keyed by class name. */
  classes: Record<string, CompositionClass>;
}

function emptyClass(): CompositionClass {
  return { count: 0, chars: 0, estimatedTokens: 0 };
}

/**
 * Measure the outgoing Anthropic wire body by content class.
 *
 * Pure: takes the already-built wire body (the exact JSON that goes upstream) and returns
 * the composition. Works on the wire format rather than the client's format because the
 * upstream only ever sees the wire body — measuring the client format would hide exactly
 * the inflation we are hunting.
 */
export function measureAnthropicWireComposition(wireBody: unknown): TokenComposition {
  const classes: Record<string, CompositionClass> = {};
  const add = (name: string, chars: number, tokens: number, count = 1): void => {
    const c = (classes[name] ??= emptyClass());
    c.count += count;
    c.chars += chars;
    c.estimatedTokens += tokens;
  };

  const body = (wireBody ?? {}) as {
    system?: unknown;
    tools?: unknown;
    messages?: Array<{ content?: unknown }>;
  };

  // system prompt
  if (Array.isArray(body.system)) {
    for (const block of body.system as Array<{ text?: unknown }>) {
      const text = String(block?.text ?? "");
      add("system", text.length, Math.ceil(text.length / PROSE_CHARS_PER_TOKEN));
    }
  } else if (typeof body.system === "string") {
    add("system", body.system.length, Math.ceil(body.system.length / PROSE_CHARS_PER_TOKEN));
  }

  // tool schemas
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const json = JSON.stringify(tool) ?? "";
      add("tool_schema", json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
    }
  }

  // message content blocks
  for (const msg of body.messages ?? []) {
    // A message may carry a plain string instead of a block array.
    if (typeof msg.content === "string") {
      const text = msg.content;
      const inlined = text.match(DATA_URL_IN_TEXT);
      let inlinedChars = 0;
      for (const m of inlined ?? []) inlinedChars += m.length;
      const plainChars = text.length - inlinedChars;
      add("text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
      if (inlinedChars > 0) {
        add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
      }
      continue;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      const type = String(block?.type ?? "unknown");
      switch (type) {
        case "text": {
          const text = String(block.text ?? "");
          const inlined = text.match(DATA_URL_IN_TEXT);
          let inlinedChars = 0;
          for (const m of inlined ?? []) inlinedChars += m.length;
          const plainChars = text.length - inlinedChars;
          add("text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
          if (inlinedChars > 0) {
            // Base64 that leaked into a TEXT block: billed as text upstream (~1.4 chars/token).
            add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
          }
          break;
        }
        case "thinking": {
          const thinking = String(block.thinking ?? "");
          const signature = String(block.signature ?? "");
          add("thinking", thinking.length, Math.ceil(thinking.length / PROSE_CHARS_PER_TOKEN));
          if (signature) {
            add("thinking_signature", signature.length, Math.ceil(signature.length / PROSE_CHARS_PER_TOKEN));
          }
          break;
        }
        case "tool_use": {
          const json = JSON.stringify(block.input ?? {}) ?? "";
          add("tool_call_args", json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
          break;
        }
        case "tool_result": {
          const inner = block.content;
          if (Array.isArray(inner)) {
            for (const item of inner as Array<Record<string, unknown>>) {
              if (String(item?.type) === "image") {
                // Native image block: billed as VISION tokens, not text.
                const source = item.source as { data?: unknown } | undefined;
                const data = typeof source?.data === "string" ? source.data : "";
                add("image_native", data.length, VISION_TOKENS_PER_IMAGE);
              } else {
                const text = String(item?.text ?? "");
                const inlined = text.match(DATA_URL_IN_TEXT);
                let inlinedChars = 0;
                for (const m of inlined ?? []) inlinedChars += m.length;
                const plainChars = text.length - inlinedChars;
                add("tool_result_text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
                if (inlinedChars > 0) {
                  add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
                }
              }
            }
          } else {
            const text = String(inner ?? "");
            const inlined = text.match(DATA_URL_IN_TEXT);
            let inlinedChars = 0;
            for (const m of inlined ?? []) inlinedChars += m.length;
            const plainChars = text.length - inlinedChars;
            add("tool_result_text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
            if (inlinedChars > 0) {
              add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
            }
          }
          break;
        }
        case "image": {
          // A native image block in a user turn: billed as VISION upstream.
          const source = block.source as { data?: unknown } | undefined;
          const data = typeof source?.data === "string" ? source.data : "";
          add("image_native", data.length, VISION_TOKENS_PER_IMAGE);
          break;
        }
        default: {
          const json = JSON.stringify(block) ?? "";
          add(type, json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
        }
      }
    }
  }

  let totalChars = 0;
  let estimatedTokens = 0;
  for (const c of Object.values(classes)) {
    totalChars += c.chars;
    estimatedTokens += c.estimatedTokens;
  }
  return { totalChars, estimatedTokens, classes };
}

/** Flatten a composition into a compact, log-friendly shape (sorted by estimated tokens, desc). */
export function summarizeComposition(composition: TokenComposition): Array<{
  name: string;
  count: number;
  chars: number;
  estimatedTokens: number;
}> {
  return Object.entries(composition.classes)
    .map(([name, c]) => ({ name, count: c.count, chars: c.chars, estimatedTokens: c.estimatedTokens }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
}

/** Wire-shape detection so the caller does not need to know which adapter built the body. */
export type WireShape = "anthropic" | "responses" | "unknown";

export function detectWireShape(wireBody: unknown): WireShape {
  if (!wireBody || typeof wireBody !== "object") return "unknown";
  const body = wireBody as { messages?: unknown; input?: unknown; contents?: unknown };
  if (Array.isArray(body.messages)) return "anthropic";
  if (Array.isArray(body.input)) return "responses";
  if (Array.isArray(body.contents)) return "responses";
  return "unknown";
}

/**
 * Measure a Responses-format wire body by content class (the OpenAI-shaped sibling of
 * `measureAnthropicWireComposition`). Used for providers whose adapter does not speak the
 * Anthropic wire format.
 */
export function measureResponsesWireComposition(wireBody: unknown): TokenComposition {
  const classes: Record<string, CompositionClass> = {};
  const add = (name: string, chars: number, tokens: number, count = 1): void => {
    const c = (classes[name] ??= emptyClass());
    c.count += count;
    c.chars += chars;
    c.estimatedTokens += tokens;
  };
  const body = (wireBody ?? {}) as { input?: unknown; instructions?: unknown; tools?: unknown };

  if (typeof body.instructions === "string" && body.instructions) {
    add("system", body.instructions.length, Math.ceil(body.instructions.length / PROSE_CHARS_PER_TOKEN));
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const json = JSON.stringify(tool) ?? "";
      add("tool_schema", json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
    }
  }
  for (const item of (Array.isArray(body.input) ? body.input : []) as Array<Record<string, unknown>>) {
    const type = String(item?.type ?? "unknown");
    if (type === "reasoning") {
      for (const part of (item.summary ?? []) as Array<{ text?: string }>) {
        const text = part?.text ?? "";
        add("thinking", text.length, Math.ceil(text.length / PROSE_CHARS_PER_TOKEN));
      }
      const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
      if (enc) add("thinking_signature", enc.length, Math.ceil(enc.length / PROSE_CHARS_PER_TOKEN));
      continue;
    }
    if (type === "message") {
      // Content may be a plain string rather than a part array.
      if (typeof item.content === "string") {
        const text = item.content;
        const inlined = text.match(DATA_URL_IN_TEXT);
        let inlinedChars = 0;
        for (const m of inlined ?? []) inlinedChars += m.length;
        const plainChars = text.length - inlinedChars;
        add("text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
        if (inlinedChars > 0) {
          add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
        }
        continue;
      }
      for (const part of (item.content ?? []) as Array<Record<string, unknown>>) {
        if (String(part?.type) === "input_image" || String(part?.type) === "image") {
          const url = String(part?.image_url ?? part?.url ?? "");
          add("image_native", url.length, VISION_TOKENS_PER_IMAGE);
          continue;
        }
        const text = String(part?.text ?? "");
        const inlined = text.match(DATA_URL_IN_TEXT);
        let inlinedChars = 0;
        for (const m of inlined ?? []) inlinedChars += m.length;
        const plainChars = text.length - inlinedChars;
        add("text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
        if (inlinedChars > 0) {
          add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
        }
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const json = JSON.stringify(item.arguments ?? item.input ?? "") ?? "";
      add("tool_call_args", json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const text = String(item.output ?? "");
      const inlined = text.match(DATA_URL_IN_TEXT);
      let inlinedChars = 0;
      for (const m of inlined ?? []) inlinedChars += m.length;
      const plainChars = text.length - inlinedChars;
      add("tool_result_text", plainChars, Math.ceil(plainChars / PROSE_CHARS_PER_TOKEN));
      if (inlinedChars > 0) {
        add("base64_in_text", inlinedChars, Math.ceil(inlinedChars / BASE64_TEXT_CHARS_PER_TOKEN));
      }
      continue;
    }
    const json = JSON.stringify(item) ?? "";
    add(type, json.length, Math.ceil(json.length / PROSE_CHARS_PER_TOKEN));
  }

  let totalChars = 0;
  let estimatedTokens = 0;
  for (const c of Object.values(classes)) {
    totalChars += c.chars;
    estimatedTokens += c.estimatedTokens;
  }
  return { totalChars, estimatedTokens, classes };
}

/** Measure any wire body, dispatching on its shape. */
export function measureWireComposition(wireBody: unknown): TokenComposition {
  switch (detectWireShape(wireBody)) {
    case "anthropic":
      return measureAnthropicWireComposition(wireBody);
    case "responses":
      return measureResponsesWireComposition(wireBody);
    default:
      return { totalChars: 0, estimatedTokens: 0, classes: {} };
  }
}

/**
 * Measure an adapter-built request body and return the log-friendly summary.
 *
 * `body` is whatever `adapter.buildRequest()` produced: a JSON string for most adapters.
 * Non-JSON bodies (or bodies too large to parse cheaply) yield an undefined result rather
 * than throwing — the measurement is diagnostic only and must never break a request.
 */
export function summarizeRequestBody(body: unknown): {
  totalChars: number;
  estimatedTokens: number;
  classes: Array<{ name: string; count: number; chars: number; estimatedTokens: number }>;
} | undefined {
  try {
    let parsed: unknown = body;
    if (typeof body === "string") {
      if (body.length === 0) return undefined;
      parsed = JSON.parse(body);
    }
    const composition = measureWireComposition(parsed);
    if (composition.totalChars === 0 && composition.estimatedTokens === 0) return undefined;
    return {
      totalChars: composition.totalChars,
      estimatedTokens: composition.estimatedTokens,
      classes: summarizeComposition(composition),
    };
  } catch {
    // A body we cannot parse tells us nothing; never let diagnostics break the request.
    return undefined;
  }
}
