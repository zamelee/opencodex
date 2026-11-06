import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import type { OcxProviderConfig } from "../src/types";
import { runWithWebSearch } from "../src/web-search/loop";

/**
 * End-to-end regression coverage for the 502 cluster on the m.aiio.chat provider:
 *   "Web-search adapter stream protocol error: adapter did not return within 5000ms after done"
 *
 * This test drives the REAL sidecar loop with the REAL anthropic adapter against an upstream
 * that delivers `message_stop` and then holds the SSE socket open (never sending EOF).
 * Before the fix the adapter's generator stayed open, so the sidecar's post-terminal drain
 * timed out and the whole turn failed with 502.
 */

const routedProvider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://routed.test",
  apiKey: "sk-routed",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
} as unknown as OcxProviderConfig;

const FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function socketHoldingSse(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of FRAMES) controller.enqueue(encoder.encode(frame));
      // No close(): the upstream keeps the connection open after message_stop.
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("web-search sidecar with an anthropic routed model", () => {
  test("the turn completes when the upstream holds the socket open after message_stop", async () => {
    const adapter = createAnthropicAdapter(routedProvider);
    // The adapter's own fetch is replaced so the loop sees the socket-holding upstream.
    const withFetch = {
      ...adapter,
      fetchResponse: async () => socketHoldingSse(),
    };

    const parsed = parseRequest({
      model: "routed/model",
      input: "Search current docs",
      stream: true,
      tools: [{ type: "web_search" }],
    });

    const response = await runWithWebSearch({
      parsed,
      adapter: withFetch as typeof adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer forwarded" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
      maxSearches: 1,
      // The sidecar's own 5s post-terminal drain: the failure mode under test.
      routedModelStallTimeoutMs: 30_000,
    });

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("response.completed");
    // The exact string the 502 carried.
    expect(body).not.toContain("adapter did not return within");
  }, 30_000);
});
