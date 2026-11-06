import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxProviderConfig } from "../src/types";

/**
 * Regression coverage for the 502 cluster seen on the m.aiio.chat provider:
 *   "Web-search adapter stream protocol error: adapter did not return within 5000ms after done"
 *
 * The web-search sidecar holds the terminal `done` event and then waits for the adapter's
 * generator to FINISH (its post-terminal drain). The anthropic adapter used to keep reading
 * after `message_stop`, so an upstream that holds the SSE socket open instead of closing it
 * left the generator open forever — and the drain timed out, failing the whole turn with 502.
 */

const provider = {
  adapter: "anthropic",
  baseUrl: "https://m.aiio.chat",
  apiKey: "sk-x",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

const FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function streamThatHoldsTheSocket(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of FRAMES) controller.enqueue(encoder.encode(frame));
      // Deliberately NO close(): the upstream keeps the connection open after message_stop.
    },
  });
}

/** Drive the adapter the way the sidecar does: pull with next(), then pull once more. */
async function drainAndWaitForFinish(): Promise<{ sawDone: boolean; finished: boolean }> {
  const adapter = createAnthropicAdapter(provider);
  const response = new Response(streamThatHoldsTheSocket(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const iterator = adapter.parseStream(response);

  let sawDone = false;
  while (!sawDone) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
    ]);
    if ("timeout" in next) return { sawDone: false, finished: false };
    if (next.done) return { sawDone: false, finished: true };
    if (next.value?.type === "done") sawDone = true;
  }

  const after = await Promise.race([
    iterator.next().then(() => "finished"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000)),
  ]);
  return { sawDone: true, finished: after === "finished" };
}

describe("anthropic stream termination after done", () => {
  test("the generator finishes after `done` even when the upstream holds the socket", async () => {
    const { sawDone, finished } = await drainAndWaitForFinish();
    expect(sawDone).toBe(true);
    // Before the fix this was false: the generator stayed open waiting for an EOF that never
    // came, and the sidecar's 5s post-terminal drain raised
    // "adapter did not return within 5000ms after done" -> 502.
    expect(finished).toBe(true);
  });

  test("exactly one terminal `done` event is emitted", async () => {
    const adapter = createAnthropicAdapter(provider);
    const response = new Response(streamThatHoldsTheSocket(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  test("usage is still carried on the terminal `done` event", async () => {
    const adapter = createAnthropicAdapter(provider);
    const response = new Response(streamThatHoldsTheSocket(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const events = [];
    for await (const event of adapter.parseStream(response)) events.push(event);
    const done = events.find((e) => e.type === "done") as { usage?: { inputTokens?: number } } | undefined;
    expect(done?.usage?.inputTokens).toBe(10);
  });
});
