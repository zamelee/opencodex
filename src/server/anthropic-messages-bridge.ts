// Patch 3b: Anthropic Messages <-> Responses protocol bridge.
//
// Two pure functions plus a parser exposed for unit testing:
//   anthropicMessagesBodyToResponsesBody(req) -> { body, headers, responsesBody }
//     Maps Anthropic Messages shape to a Responses body that handleResponses can consume.
//   responsesSseToAnthropicSse(responsesBodyStream) -> ReadableStream<Uint8Array>
//     Wraps a Responses-format SSE byte stream and emits Anthropic-format SSE bytes.
//   parseAnthropicStreamChunk(events, messageId) -> string[]
//     Maps Responses events to zero or more Anthropic SSE event strings (with framing).
//
// MVP scope: messages + system + image_base64 source + tool_use + tool_result blocks,
// function tools with input_schema, temperature / top_p / top_k / max_tokens / stop_sequences.
// Out of scope (deferred to a follow-up): thinking blocks, redacted_thinking, server_tool_use,
// prompt caching, citations.

import { randomUUID } from "node:crypto";

type AnthropicRole = "user" | "assistant";
type AnthropicTextContent = { type: "text"; text: string; cache_control?: unknown };
type AnthropicImageContent = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
  cache_control?: unknown;
};
type AnthropicToolUseContent = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: unknown;
};
type AnthropicToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
  cache_control?: unknown;
};
type AnthropicContentPart =
  | AnthropicTextContent
  | AnthropicImageContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent;
type AnthropicSystemBlock = string | AnthropicTextContent[];
type AnthropicMessage =
  | { role: "user"; content: string | AnthropicContentPart[] }
  | { role: "assistant"; content: string | AnthropicContentPart[] };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessagesBody {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystemBlock;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

interface ResponsesBody {
  model: string;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_output_tokens?: number;
  stream?: boolean;
  stream_include_usage?: boolean;
  // stop_sequences has no native Responses field; stash under additional_settings so an
  // adapter that wants to honor it can. Default Chat/Responses adapters ignore unknown keys.
  additional_settings?: Record<string, unknown>;
}

function blockText(part: AnthropicTextContent): string {
  return part.text;
}

function userPartToInput(part: AnthropicContentPart): Record<string, unknown> | null {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") {
    // Responses expects image as either {image_url: "data:..."} or {source: ...} for base64.
    // We use {source: {...}} to keep the base64 payload opaque.
    return {
      type: "input_image",
      source: {
        type: part.source.type,
        media_type: part.source.media_type,
        data: part.source.data,
      },
    };
  }
  return null;
}

function assistantPartToInput(part: AnthropicContentPart): Record<string, unknown> | null {
  if (part.type === "text") return { type: "output_text", text: part.text };
  if (part.type === "tool_use") {
    return {
      type: "function_call",
      id: part.id,
      // Use the same id as call_id — Responses uses call_id for tool resolution.
      call_id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.input ?? {}),
    };
  }
  return null;
}

function toolResultToOutput(content: AnthropicToolResultContent): Record<string, unknown> {
  let output: string;
  if (typeof content.content === "string") {
    output = content.content;
  } else {
    output = content.content
      .filter((c): c is AnthropicTextContent => c.type === "text")
      .map(c => c.text)
      .join("");
  }
  return {
    type: "function_call_output",
    call_id: content.tool_use_id,
    output,
  };
}

function userMessageToInputItems(msg: Extract<AnthropicMessage, { role: "user" }>): Record<string, unknown>[] {
  const parts: AnthropicContentPart[] = Array.isArray(msg.content)
    ? msg.content
    : [{ type: "text", text: msg.content }];
  const content: Record<string, unknown>[] = [];
  const functionOutputs: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type === "tool_result") {
      functionOutputs.push(toolResultToOutput(part));
      continue;
    }
    const mapped = userPartToInput(part);
    if (mapped) content.push(mapped);
  }
  const out: Record<string, unknown>[] = [];
  // Anthropic user turns may contain both text/image AND tool_result items; emit them as
  // separate Responses input items (function_call_output cannot share a parent with role:user).
  if (content.length > 0) {
    out.push({ role: "user", content });
  }
  for (const fo of functionOutputs) out.push(fo);
  return out;
}

function assistantMessageToInputItems(msg: Extract<AnthropicMessage, { role: "assistant" }>): Record<string, unknown>[] {
  const parts: AnthropicContentPart[] = Array.isArray(msg.content)
    ? msg.content
    : [{ type: "text", text: msg.content }];
  const textContent: Record<string, unknown>[] = [];
  const functionCalls: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      textContent.push({ type: "output_text", text: part.text });
      continue;
    }
    if (part.type === "tool_use") {
      functionCalls.push({
        type: "function_call",
        id: part.id,
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      });
      continue;
    }
  }
  const out: Record<string, unknown>[] = [];
  if (textContent.length > 0) {
    out.push({ role: "assistant", content: textContent });
  }
  for (const fc of functionCalls) out.push(fc);
  return out;
}

function systemToInstructions(system: AnthropicSystemBlock | undefined): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  // system is AnthropicTextContent[].
  const joined = system.map(blockText).filter(t => t.length > 0).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

/**
 * Read an Anthropic Messages POST and produce an equivalent Responses body.
 * Pure: no upstream I/O. The caller wraps the returned body into a new Request.
 */
export async function anthropicMessagesBodyToResponsesBody(
  req: Request,
): Promise<{ body: string; headers: Headers; responsesBody: ResponsesBody }> {
  const raw = await req.text();
  let parsed: AnthropicMessagesBody;
  try {
    parsed = JSON.parse(raw) as AnthropicMessagesBody;
  } catch {
    throw new Error("invalid JSON in Anthropic Messages request body");
  }
  if (typeof parsed.max_tokens !== "number" || !Number.isFinite(parsed.max_tokens)) {
    throw new Error("max_tokens is required (Anthropic API contract)");
  }

  const input: Array<Record<string, unknown>> = [];
  for (const msg of parsed.messages ?? []) {
    if (msg.role === "user") {
      for (const item of userMessageToInputItems(msg)) input.push(item);
    } else {
      for (const item of assistantMessageToInputItems(msg)) input.push(item);
    }
  }

  const out: ResponsesBody = {
    model: parsed.model,
    input,
    max_output_tokens: parsed.max_tokens,
  };
  const instructions = systemToInstructions(parsed.system);
  if (instructions !== undefined) out.instructions = instructions;
  if (parsed.temperature !== undefined) out.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) out.top_p = parsed.top_p;
  if (parsed.top_k !== undefined) out.top_k = parsed.top_k;
  if (parsed.stop_sequences !== undefined) {
    out.additional_settings = { stop_sequences: parsed.stop_sequences };
  }
  if (parsed.tools?.length) {
    out.tools = parsed.tools.map(t => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }
  if (parsed.stream) {
    out.stream = true;
    out.stream_include_usage = true;
  }

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (k === "content-length" || k === "host" || k === "anthropic-version") continue;
    headers.set(k, v);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return { body: JSON.stringify(out), headers, responsesBody: out };
}

// ---------- outbound: Responses SSE -> Anthropic SSE ----------

interface ResponsesStreamEvent {
  type: string;
  sequence_number?: number;
  response?: Record<string, unknown>;
  output_index?: number;
  content_index?: number;
  item_id?: string;
  item?: Record<string, unknown>;
  part?: Record<string, unknown>;
  delta?: string;
  text?: string;
  [k: string]: unknown;
}

interface AnthropicMessageMeta {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

// Track per-messageId which block index we are emitting. Anthropic requires content blocks
// to have ascending indices. We also remember whether message_start + initial content_block_start
// have been emitted so the SSE stays valid.
interface AnthropicStreamState {
  messageStarted: boolean;
  blockStarted: boolean;
  blockIndex: number;
  sawToolUse: boolean;
  toolUseBlockEmitted: boolean;
}

const _msgState = new Map<string, AnthropicStreamState>();

function newMsgState(): AnthropicStreamState {
  return {
    messageStarted: false,
    blockStarted: false,
    blockIndex: 0,
    sawToolUse: false,
    toolUseBlockEmitted: false,
  };
}

/**
 * Map Responses events to 0+ Anthropic-format SSE event strings (each ending in \n\n).
 * Tracks per-message state in the module-level _msgState Map so the message_start event is
 * emitted exactly once and block indices stay in sync with the upstream item stream.
 */
export function parseAnthropicStreamChunk(
  events: ResponsesStreamEvent[],
  messageId: string,
  model = "opencodex",
): string[] {
  const out: string[] = [];
  let state = _msgState.get(messageId);
  if (!state) {
    state = newMsgState();
    _msgState.set(messageId, state);
  }
  const msgId = messageId;
  const msgModel = model;

  for (const ev of events) {
    switch (ev.type) {
      case "response.created": {
        // First emit message_start with the messageId + model. Anthropic requires this
        // before any content_block_* events. Pull the model out of the Responses payload
        // when present so the upstream model name propagates to the Anthropic client.
        if (!state.messageStarted) {
          const upstreamModel = (ev.response as { model?: string } | undefined)?.model ?? msgModel;
          out.push(sseEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: upstreamModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }));
          state.messageStarted = true;
        }
        break;
      }
      case "response.in_progress":
        // Equivalent to response.created — message_start already emitted.
        break;
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (!state.messageStarted) {
          // Defensive: emit message_start if upstream skips response.created.
          const upstreamModel = (ev.response as { model?: string } | undefined)?.model ?? msgModel;
          out.push(sseEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId, type: "message", role: "assistant", model: upstreamModel,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }));
          state.messageStarted = true;
        }
        if (item.type === "message") {
          if (!state.blockStarted) {
            out.push(sseEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            }));
            state.blockStarted = true;
          }
        } else if (item.type === "function_call") {
          // tool_use: emit content_block_start (tool_use) now, then we'll emit input_json_delta
          // events as argument deltas arrive.
          out.push(sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: (item.call_id as string) ?? (item.id as string) ?? `toolu_${ev.output_index ?? 0}`,
              name: item.name as string,
              input: {},
            },
          }));
          state.toolUseBlockEmitted = true;
          state.sawToolUse = true;
        }
        break;
      }
      case "response.output_text.delta": {
        if (typeof ev.delta === "string" && ev.delta.length > 0) {
          out.push(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: ev.delta },
          }));
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        if (typeof ev.delta === "string" && ev.delta.length > 0) {
          out.push(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: ev.delta },
          }));
        }
        break;
      }
      case "response.content_part.added":
        // text part preamble already emitted from response.output_item.added above.
        break;
      case "response.output_text.done":
        // informational; close is emitted via response.output_item.done for the parent.
        break;
      case "response.output_item.done": {
        const item = ev.item ?? {};
        // Close the open content block (text or tool_use).
        out.push(sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        }));
        if (item.type === "function_call") {
          state.toolUseBlockEmitted = false;
        }
        state.blockIndex += 1;
        state.blockStarted = false;
        break;
      }
      case "response.completed": {
        const resp = ev.response ?? {};
        const usage = resp.usage as Record<string, number> | undefined;
        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        out.push(sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }));
        out.push(sseEvent("message_stop", { type: "message_stop" }));
        // Cleanup per-message state so the same messageId isn't reused.
        _msgState.delete(msgId);
        break;
      }
      default:
        // Ignored: response.heartbeat, response.refusal.*, response.error, etc.
        break;
    }
  }
  return out;
}

/** Format one SSE event block (event: <type>\ndata: <json>\n\n). */
function sseEvent(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Wrap a Responses-format SSE byte stream and emit Anthropic-format SSE chunks.
 * Uses parseAnthropicStreamChunk for event translation. Does NOT emit a trailing
 * [DONE] — Anthropic SSE terminates with `event: message_stop`, which parseAnthropicStreamChunk
 * emits as part of response.completed.
 */
export function responsesSseToAnthropicSse(
  responsesSseStream: ReadableStream<Uint8Array>,
  options: { messageId?: string; model?: string } = {},
): ReadableStream<Uint8Array> {
  const messageId = options.messageId ?? `msg_${randomUUID().replace(/-/g, "")}`;
  const model = options.model ?? "opencodex";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = responsesSseStream.getReader();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(drainBuffer(buffer, messageId, model)));
            buffer = "";
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const out = drainBuffer(block, messageId, model);
          if (out) controller.enqueue(encoder.encode(out));
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      try { reader.cancel(); } catch { /* ignore */ }
    },
  });
}

function drainBuffer(block: string, messageId: string, model: string): string {
  let evType = "";
  let evData = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) evType = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) {
      const piece = line.slice("data:".length).trimStart();
      evData = evData ? `${evData}\n${piece}` : piece;
    }
  }
  if (!evType || !evData) return "";
  let parsed: ResponsesStreamEvent;
  try {
    parsed = JSON.parse(evData) as ResponsesStreamEvent;
  } catch {
    return "";
  }
  return parseAnthropicStreamChunk([parsed], messageId, model).join("");
}
