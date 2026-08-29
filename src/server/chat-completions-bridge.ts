// Patch 3a: Chat Completions <-> Responses protocol bridge.
//
// Two pure functions plus a parser exposed for unit testing:
//   chatCompletionsBodyToResponsesBody(req) -> { body: string, headers: Headers }
//     Takes a Chat Completions POST request, returns the equivalent Responses
//     POST request body (and forwards headers). Used to route Chat Completions
//     through the existing handleResponses pipeline.
//
//   responsesSseToChatCompletionsSse(responsesBodyStream) -> ReadableStream<Uint8Array>
//     Wraps a Responses-format SSE byte stream and emits Chat Completions-
//     format SSE chunks. Uses parseChatCompletionsStreamChunk for translation.
//
//   parseChatCompletionsStreamChunk(events, completionId, model?) -> string[]
//     Maps an array of Responses events to zero or more Chat Completions SSE
//     chunk payloads (without the "data: " / "\\n\\n" framing — the caller wraps).
//
// Scope (MVP): basic messages, system -> instructions, single text/image content
// parts, function tools, temperature/top_p/max_tokens, stream=true mapping.
// Out of scope for this patch: tool_choice enum, multi-choice (n>1),
// logprobs, audio modality, parallel tool call streaming.

import { randomUUID } from "node:crypto";

type ChatRole = "system" | "user" | "assistant" | "tool" | "function";
type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };
type ChatMessage =
  | { role: ChatRole; content: string | ChatContentPart[]; name?: string; tool_call_id?: string };

interface ChatCompletionsTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionsBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ChatCompletionsTool[];
  tool_choice?: unknown;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

interface ResponsesBody {
  model: string;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  // Chat Completions clients (especially with stream_include_usage) expect usage in
  // every chunk + a final usage block; Responses needs this flag to emit usage events.
  stream_include_usage?: boolean;
  metadata?: Record<string, string>;
  user?: string;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
}

function chatContentPartToInput(part: ChatContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "input_text", text: part.text };
  // image_url -> input_image. Responses expects image_url as a string (or file id).
  if (part.type === "image_url") return { type: "input_image", image_url: part.image_url.url };
  // Unknown future types: best-effort pass-through.
  return { type: "input_text", text: JSON.stringify(part) };
}

function chatMessageToInputItem(msg: ChatMessage): Record<string, unknown> | null {
  if (msg.role === "system") return null; // promoted to instructions
  if (msg.role === "tool" || msg.role === "function") {
    // tool message: Responses uses a function_call_output item keyed by call_id.
    const item: Record<string, unknown> = {
      type: "function_call_output",
      output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    };
    if (msg.tool_call_id) item["call_id"] = msg.tool_call_id;
    return item;
  }
  const role = msg.role === "assistant" ? "assistant" : "user";
  const content = Array.isArray(msg.content)
    ? msg.content.map(chatContentPartToInput)
    : [{ type: role === "assistant" ? "output_text" : "input_text", text: msg.content }];
  return { role, content };
}

/**
 * Read a Chat Completions POST request and produce the equivalent Responses body.
 * Pure: no upstream I/O. The returned `body` is JSON-encoded; pass it to a new
 * Request() aimed at the Responses endpoint.
 */
export async function chatCompletionsBodyToResponsesBody(
  req: Request,
): Promise<{ body: string; headers: Headers; responsesBody: ResponsesBody }> {
  const raw = await req.text();
  let parsed: ChatCompletionsBody;
  try {
    parsed = JSON.parse(raw) as ChatCompletionsBody;
  } catch {
    throw new Error("invalid JSON in Chat Completions request body");
  }

  const instructionsParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of parsed.messages ?? []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (text) instructionsParts.push(text);
      continue;
    }
    const item = chatMessageToInputItem(msg);
    if (item) input.push(item);
  }

  const out: ResponsesBody = {
    model: parsed.model,
    input,
  };
  if (instructionsParts.length > 0) out.instructions = instructionsParts.join("\n\n");
  if (parsed.temperature !== undefined) out.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) out.top_p = parsed.top_p;
  if (parsed.max_tokens !== undefined) out.max_output_tokens = parsed.max_tokens;
  if (parsed.stream) {
    out.stream = true;
    out.stream_include_usage = true;
  }
  if (parsed.tools?.length) {
    out.tools = parsed.tools.map(t => ({
      type: t.type,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
  if (parsed.user) out.user = parsed.user;
  if (parsed.stop !== undefined) out.stop = parsed.stop;
  if (parsed.presence_penalty !== undefined) out.presence_penalty = parsed.presence_penalty;
  if (parsed.frequency_penalty !== undefined) out.frequency_penalty = parsed.frequency_penalty;

  const headers = new Headers();
  // Forward content-type (we always emit JSON) + best-effort client identity.
  for (const [k, v] of req.headers) {
    if (k === "content-length" || k === "host") continue;
    headers.set(k, v);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return { body: JSON.stringify(out), headers, responsesBody: out };
}

// ---------- outbound: Responses SSE -> Chat Completions SSE ----------

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

interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Translate Responses events into Chat Completions SSE chunk payloads (just the JSON,
 * without the "data: " prefix or trailing newlines — caller wraps).
 * Returns 0+ strings. Order is preserved.
 */
// Track completionIds for which we have already emitted the role:assistant chunk.
// Without dedup, a chunk boundary that splits response.created and response.in_progress
// across two parseChatCompletionsStreamChunk calls would emit the role twice, which
// is invalid Chat Completions shape.
const _roleEmittedFor = new Set<string>();

/** Test-only: clear the role-emitted dedup set between cases. Production code never
 *  needs to call this; the Set grows monotonically per completionId. */
export function __resetRoleEmittedForTesting(): void {
  _roleEmittedFor.clear();
}

export function parseChatCompletionsStreamChunk(
  events: ResponsesStreamEvent[],
  completionId: string,
  model = "opencodex",
): string[] {
  const out: string[] = [];
  const ts = nowSec();
  const roleAlreadySent = _roleEmittedFor.has(completionId);
  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string => {
    const c: ChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created: ts,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return JSON.stringify(c);
  };

  for (const ev of events) {
    switch (ev.type) {
      case "response.created":
        if (!roleAlreadySent) {
          _roleEmittedFor.add(completionId);
          out.push(makeChunk({ role: "assistant", content: "" }));
        }
        break;
      case "response.in_progress":
        // Informational; role chunk already emitted on response.created.
        break;
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type === "message") {
          out.push(makeChunk({ role: "assistant", content: "" }));
        } else if (item.type === "function_call") {
          // Tool call begins: emit the metadata (id, name) as the first tool_calls delta.
          const delta: Record<string, unknown> = {
            tool_calls: [{
              index: 0,
              id: (item.call_id as string) ?? (item.id as string) ?? `call_${ev.output_index ?? 0}`,
              type: "function",
              function: {
                name: item.name as string,
                arguments: "",
              },
            }],
          };
          out.push(makeChunk(delta));
        }
        break;
      }
      case "response.content_part.added":
        out.push(makeChunk({ content: "" }));
        break;
      case "response.output_text.delta":
        if (typeof ev.delta === "string" && ev.delta.length > 0) {
          out.push(makeChunk({ content: ev.delta }));
        }
        break;
      case "response.function_call_arguments.delta":
        if (typeof ev.delta === "string" && ev.delta.length > 0) {
          out.push(makeChunk({
            tool_calls: [{
              index: 0,
              function: { arguments: ev.delta },
            }],
          }));
        }
        break;
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          // Close out the tool call with finish_reason=tool_calls. We also include the
          // full arguments string in case the client missed the deltas.
          out.push(makeChunk(
            {
              tool_calls: [{
                index: 0,
                id: (item.call_id as string) ?? (item.id as string) ?? `call_${ev.output_index ?? 0}`,
                type: "function",
                function: {
                  name: item.name as string,
                  arguments: (item.arguments as string) ?? "",
                },
              }],
            },
            "tool_calls",
          ));
        }
        break;
      }
      case "response.output_text.done":
        // finish_reason=stop delivered on response.completed. This event alone
        // doesn't close the stream in Chat Completions semantics.
        break;
      case "response.completed": {
        const resp = ev.response ?? {};
        const usage = resp.usage as Record<string, number> | undefined;
        const chunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: ts,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        if (usage) {
          chunk.usage = {
            prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          };
        }
        out.push(JSON.stringify(chunk));
        break;
      }
      // Ignored: response.heartbeat, response.refusal.*, response.error, etc.
      default:
        break;
    }
  }
  return out;
}

/**
 * Wrap a Responses-format SSE byte stream and emit Chat Completions SSE chunks.
 * First emits a [DONE] terminator after the final chunk so the client knows the
 * stream is closed.
 */
export function responsesSseToChatCompletionsSse(
  responsesSseStream: ReadableStream<Uint8Array>,
  options: { completionId?: string; model?: string } = {},
): ReadableStream<Uint8Array> {
  const completionId = options.completionId ?? `cmpl_${randomUUID().replace(/-/g, "")}`;
  const model = options.model ?? "opencodex";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = responsesSseStream.getReader();
  let buffer = "";
  let firstChunkSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Drain any trailing partial line.
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(flushBuffer(buffer, completionId, model, /*finalize*/ true)));
            buffer = "";
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // Process complete SSE events (terminated by \n\n).
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const out = flushBuffer(block, completionId, model, false);
          if (out) controller.enqueue(encoder.encode(out));
          firstChunkSent = true;
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

function flushBuffer(
  block: string,
  completionId: string,
  model: string,
  finalize: boolean,
): string {
  // Each SSE event in Responses has the shape:
  //   event: <type>\n
  //   data: <json>\n
  // (some may be comments starting with ":"; ignore those).
  let evType = "";
  let evData = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) evType = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) {
      const piece = line.slice("data:".length).trimStart();
      evData = evData ? `${evData}\n${piece}` : piece;
    }
  }
  if (!evType || !evData) return "";
  if (evData === "[DONE]") {
    // Caller will send its own [DONE] terminator; skip.
    return "";
  }
  let parsed: ResponsesStreamEvent;
  try {
    parsed = JSON.parse(evData) as ResponsesStreamEvent;
  } catch {
    return "";
  }
  const chunks = parseChatCompletionsStreamChunk([parsed], completionId, model);
  if (chunks.length === 0) return "";
  return chunks.map(c => `data: ${c}\n\n`).join("");
}
