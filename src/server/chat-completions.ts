// Patch 3a: /v1/chat/completions endpoint.
//
// Wraps the existing Responses pipeline (handleResponses + bridgeToResponsesSSE)
// with a small protocol adapter on each side:
//
//   Chat Completions POST req
//     -> chatCompletionsBodyToResponsesBody(req)
//     -> new Request at /v1/responses
//     -> handleResponses(...)
//     -> Response with Responses SSE body
//     -> responsesSseToChatCompletionsSse(body) re-wraps chunks
//     -> final Response with Chat Completions SSE body
//
// MVP scope: streaming + non-streaming; messages + system + image_url + function tools.
// Out of scope (deferred to Patch 3a-followup): tool_choice, n>1, logprobs, audio.

import {
  chatCompletionsBodyToResponsesBody,
  responsesSseToChatCompletionsSse,
} from "./chat-completions-bridge";
import { handleResponses } from "./responses";
import type { CodexAuthContext } from "../codex/auth-context";
import { resolveCodexAuthContext } from "../codex/auth-context";
import type { OcxConfig } from "../types";

export async function handleChatCompletions(
  req: Request,
  config: OcxConfig,
): Promise<Response> {
  let upstreamReq: Request;
  let completionId: string;
  let model: string;
  try {
    const conv = await chatCompletionsBodyToResponsesBody(req);
    upstreamReq = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: conv.headers,
      body: conv.body,
    });
    completionId = `cmpl_${conv.responsesBody.model.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    model = conv.responsesBody.model;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid request body";
    return new Response(JSON.stringify({ error: { message: msg, type: "invalid_request_error", code: "bad_request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Build auth context the same way handleResponses would. We piggy-back on the
  // existing routing by handing the rewritten request to handleResponses — auth
  // resolution happens inside there based on the rewritten body (which still carries
  // the original Authorization header).
  let authContext: CodexAuthContext | undefined;
  try {
    authContext = await resolveCodexAuthContext(upstreamReq.headers, config);
  } catch {
    authContext = undefined;
  }

  // Call into the canonical Responses handler. We pass a minimal RequestLogContext
  // (matching the shape used at /v1/responses index.ts:390). The "unknown" placeholders
  // are overwritten by handleResponses as soon as it routes the model.
  const logCtx: { model: string; provider: string; [k: string]: unknown } = {
    model: "unknown",
    provider: "unknown",
  };
  const responsesResp = await handleResponses(upstreamReq, config, logCtx, {
    authContext,
  });

  // Non-streaming: JSON body in Responses shape. Translate to Chat Completions JSON.
  const isStream = (upstreamReq.headers.get("accept")?.includes("text/event-stream") ?? false)
    || (model && (await upstreamReq.clone().text()).includes('"stream":true'));
  // The accept-based stream detection above is fragile; instead use the originally
  // parsed body to decide (model already holds the parsed Responses body).
  // Simpler: re-parse the inbound body to learn the original `stream` flag.
  // We already had it in chatCompletionsBodyToResponsesBody's responsesBody.stream.
  // (Slightly leaky: we passed the flag via the rewritten upstream request. Look
  // at upstreamReq.body? Too costly. Instead, ask the upstream response itself.)
  // If responsesResp.headers.get("content-type") includes text/event-stream we know
  // the upstream was streaming; otherwise it is JSON.
  const ct = responsesResp.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream") || !responsesResp.body) {
    // Translate the JSON Responses body to Chat Completions JSON.
    const rawText = await responsesResp.text();
    const json = safeJson(rawText);
    if (!json) {
      // Pass-through if upstream body wasn't parseable.
      return new Response(rawText, {
        status: responsesResp.status,
        headers: withContentType(responsesResp.headers, "application/json"),
      });
    }
    const cc = responsesJsonToChatCompletionsJson(json, completionId, model);
    return new Response(JSON.stringify(cc), {
      status: responsesResp.status,
      headers: withContentType(responsesResp.headers, "application/json"),
    });
  }

  // Streaming: pipe through the SSE chunk re-wrapper.
  const chatSse = responsesSseToChatCompletionsSse(responsesResp.body, {
    completionId,
    model,
  });
  const outHeaders = withContentType(responsesResp.headers, "text/event-stream");
  outHeaders.set("cache-control", "no-cache");
  return new Response(chatSse, {
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

/** Translate a non-streaming Responses JSON body to a Chat Completions JSON body. */
function responsesJsonToChatCompletionsJson(
  r: Record<string, unknown>,
  completionId: string,
  model: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: completionId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [] as Array<Record<string, unknown>>,
  };
  const usage = r.usage as Record<string, number> | undefined;
  if (usage) {
    out.usage = {
      prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    };
  }
  const output = (r.output as Array<Record<string, unknown>>) ?? [];
  const msgItem = output.find(item => item.type === "message");
  if (msgItem) {
    const content = msgItem.content as Array<Record<string, unknown>> | undefined;
    const text = content?.map(c => (c.type === "output_text" ? (c.text as string) : "")).join("") ?? "";
    out.choices = [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }];
  } else {
    // No message — could be tool calls or refusal. Best-effort: empty content + stop.
    out.choices = [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }];
  }
  return out;
}
