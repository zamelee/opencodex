// Patch 3b: /v1/messages endpoint.
//
// Wraps the existing Responses pipeline (handleResponses + bridgeToResponsesSSE)
// with a small protocol adapter on each side:
//
//   Anthropic Messages POST req
//     -> anthropicMessagesBodyToResponsesBody(req)
//     -> new Request at /v1/responses
//     -> handleResponses(...)
//     -> Response with Responses SSE body
//     -> responsesSseToAnthropicSse(body) re-wraps chunks
//     -> final Response with Anthropic SSE body

import {
  anthropicMessagesBodyToResponsesBody,
  responsesSseToAnthropicSse,
} from "./anthropic-messages-bridge";
import { handleResponses } from "./responses";

import type { CodexAuthContext } from "../codex/auth-context";
import { resolveCodexAuthContext } from "../codex/auth-context";
import type { OcxConfig } from "../types";

export async function handleAnthropicMessages(
  req: Request,
  config: OcxConfig,
): Promise<Response> {
  let upstreamReq: Request;
  let messageId: string;
  let model: string;
  try {
    const conv = await anthropicMessagesBodyToResponsesBody(req);
    upstreamReq = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: conv.headers,
      body: conv.body,
    });
    model = conv.responsesBody.model;
    messageId = `msg_${model.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid request body";
    // Anthropic SDK parses error JSON; surface it as an anthropic-shaped error block.
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: msg },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let authContext: CodexAuthContext | undefined;
  try {
    authContext = await resolveCodexAuthContext(upstreamReq.headers, config);
  } catch {
    authContext = undefined;
  }

  const logCtx: { model: string; provider: string; [k: string]: unknown } = {
    model: "unknown",
    provider: "unknown",
  };
  const responsesResp = await handleResponses(upstreamReq, config, logCtx, {
    authContext,
  });

  // Decide streaming from upstream content-type (matches the prod /v1/responses flow).
  const ct = responsesResp.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream") || !responsesResp.body) {
    // Non-streaming path. Anthropic Messages JSON body shape.
    const rawText = await responsesResp.text();
    const json = safeJson(rawText);
    if (!json) {
      return new Response(rawText, {
        status: responsesResp.status,
        headers: withContentType(responsesResp.headers, "application/json"),
      });
    }
    const am = responsesJsonToAnthropicJson(json, messageId, model);
    return new Response(JSON.stringify(am), {
      status: responsesResp.status,
      headers: withContentType(responsesResp.headers, "application/json"),
    });
  }

  const anthropicSse = responsesSseToAnthropicSse(responsesResp.body, {
    messageId,
    model,
  });
  const outHeaders = withContentType(responsesResp.headers, "text/event-stream");
  outHeaders.set("cache-control", "no-cache");
  return new Response(anthropicSse, {
    status: responsesResp.status,
    headers: outHeaders,
  });
}

// ---------- helpers ----------

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function withContentType(h: Headers, ct: string): Headers {
  const out = new Headers(h);
  out.set("content-type", ct);
  return out;
}

/** Translate a non-streaming Responses JSON body to an Anthropic Messages JSON body. */
function responsesJsonToAnthropicJson(
  r: Record<string, unknown>,
  messageId: string,
  model: string,
): Record<string, unknown> {
  const usage = r.usage as Record<string, number> | undefined;
  const out: Record<string, unknown> = {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content: [] as Array<Record<string, unknown>>,
    stop_reason: "end_turn",
    stop_sequence: null,
  };
  if (usage) {
    out.usage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    };
  }
  const output = (r.output as Array<Record<string, unknown>>) ?? [];
  let sawToolUse = false;
  for (const item of output) {
    if (item.type === "message") {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const part of content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            (out.content as Array<Record<string, unknown>>).push({ type: "text", text: part.text });
          }
        }
      }
    } else if (item.type === "function_call") {
      (out.content as Array<Record<string, unknown>>).push({
        type: "tool_use",
        id: (item.call_id as string) ?? (item.id as string) ?? `toolu_${Math.random().toString(36).slice(2, 8)}`,
        name: item.name as string,
        input: parseArgs(item.arguments as string),
      });
      sawToolUse = true;
    }
  }
  if (sawToolUse) out.stop_reason = "tool_use";
  return out;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
