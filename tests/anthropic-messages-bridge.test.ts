import { describe, expect, test } from "bun:test";
import {
  anthropicMessagesBodyToResponsesBody,
  responsesSseToAnthropicSse,
  parseAnthropicStreamChunk,
} from "../src/server/anthropic-messages-bridge";

// ---------- inbound: Anthropic Messages -> Responses body ----------

describe("Patch 3b: anthropicMessagesBodyToResponsesBody", () => {
  test("basic messages + system string -> instructions", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: "You are concise.",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.instructions).toBe("You are concise.");
    expect(body.max_output_tokens).toBe(1024);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ]);
    // Anthropic-version is not forwarded into the rewritten request (Responses path doesn't need it).
    expect(out.headers.get("anthropic-version")).toBeNull();
  });

  test("system as content blocks (text + cache_control) -> joined instructions", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        system: [
          { type: "text", text: "Part 1." },
          { type: "text", text: "Part 2." },
        ],
        messages: [{ role: "user", content: "go" }],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.instructions).toBe("Part 1.\n\nPart 2.");
  });

  test("user content array with image_base64 -> input_image", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
            ],
          },
        ],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "describe" },
      { type: "input_image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    ]);
  });

  test("assistant turn preserved as output_text", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        messages: [
          { role: "user", content: "Q" },
          { role: "assistant", content: [{ type: "text", text: "A1" }] },
          { role: "user", content: "Q2" },
        ],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input).toHaveLength(3);
    expect(body.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "A1" }] });
  });

  test("tool_use block in assistant turn -> function_call item", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_x", name: "get_weather", input: { city: "SF" } },
            ],
          },
        ],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input[1]).toEqual({
      type: "function_call",
      id: "toolu_x",
      call_id: "toolu_x",
      name: "get_weather",
      arguments: '{"city":"SF"}',
    });
  });

  test("tool_result in user turn -> function_call_output", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: "sunny, 65F" }],
          },
        ],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input[2]).toEqual({
      type: "function_call_output",
      call_id: "tu_1",
      output: "sunny, 65F",
    });
  });

  test("tools array with input_schema -> Responses tool shape", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        messages: [{ role: "user", content: "weather?" }],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    });
  });

  test("temperature / top_p / top_k / stop_sequences pass through", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["END"],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
    expect(body.additional_settings?.stop_sequences).toEqual(["END"]);
  });

  test("stream=true -> stream=true on Responses side", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 50,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const out = await anthropicMessagesBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.stream).toBe(true);
  });
});

// ---------- outbound: Responses SSE -> Anthropic SSE ----------

describe("Patch 3b: parseAnthropicStreamChunk", () => {
  test("response.created -> message_start", () => {
    const out = parseAnthropicStreamChunk([
      { type: "response.created", response: { id: "resp_1", model: "claude-haiku-4-5" } },
    ], "msg_1");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('event: message_start');
    expect(out[0]).toContain('"id":"msg_1"');
    expect(out[0]).toContain('"model":"claude-haiku-4-5"');
  });

  test("response.output_item.added (text) without prior response.created -> both message_start and content_block_start", () => {
    // No prior response.created in this call (fresh messageId) so the bridge defensively
    // emits message_start first then content_block_start for the text item.
    const out = parseAnthropicStreamChunk([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_abc" } },
    ], "msg-fresh-text");
    expect(out.length).toBe(2);
    expect(out[0]).toContain('event: message_start');
    expect(out[1]).toContain('event: content_block_start');
    expect(out[1]).toContain('"type":"text"');
  });

  test("response.output_text.delta -> content_block_delta text_delta", () => {
    const out = parseAnthropicStreamChunk([
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
    ], "msg_2");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('event: content_block_delta');
    expect(out[0]).toContain('"type":"text_delta"');
    expect(out[0]).toContain('"text":"Hello"');
  });

  test("response.output_item.done (text) -> content_block_stop when blockStarted", () => {
    // When the bridge has emitted a content_block_start (because output_item.added
    // preceded the done), the closing done emits the matching stop. The bridge only
    // emits stop when blockStarted is true; without a preceding add, no stop leaks.
    const out = parseAnthropicStreamChunk([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_x" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_x" } },
    ], "msg_3");
    const stop = out.find(s => s.includes('event: content_block_stop'));
    expect(stop).toBeTruthy();
  });

  test("response.output_item.done (function_call) -> content_block_start tool_use + input_json_delta + content_block_stop", () => {
    const out = parseAnthropicStreamChunk([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "call_xyz", name: "get_weather", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "call_xyz",
        output_index: 0,
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "call_xyz",
        output_index: 0,
        delta: '"SF"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "call_xyz", name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ], "msg_4");
    const blockStart = out.find(s => s.includes('event: content_block_start') && s.includes('"type":"tool_use"'));
    expect(blockStart).toBeTruthy();
    expect(blockStart).toContain('"name":"get_weather"');
    const inputDelta = out.filter(s => s.includes('event: content_block_delta') && s.includes('input_json_delta'));
    expect(inputDelta.length).toBe(2);
    const blockStop = out.find(s => s.includes('event: content_block_stop'));
    expect(blockStop).toBeTruthy();
  });

  test("response.completed -> message_delta end_turn + message_stop", () => {
    const out = parseAnthropicStreamChunk([
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ], "msg_5");
    const delta = out.find(s => s.includes('event: message_delta'));
    expect(delta).toBeTruthy();
    expect(delta).toContain('"stop_reason":"end_turn"');
    const stop = out.find(s => s.includes('event: message_stop'));
    expect(stop).toBeTruthy();
  });

  test("ignored events produce no chunks", () => {
    const out = parseAnthropicStreamChunk([
      { type: "response.heartbeat" },
      { type: "response.refusal.delta", delta: "..." },
    ], "msg_6");
    expect(out).toHaveLength(0);
  });
});


describe("Patch 3d follow-up: response.incomplete and .arguments.done", () => {
  test("response.incomplete closes block + emits message_delta + message_stop", () => {
    const events = [
      { type: "response.created", response: { id: "resp_i", model: "x" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "call_1", call_id: "call_1", name: "shell_command", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "call_1", output_index: 0, delta: "{\"command\":\"echo\"}" },
      { type: "response.incomplete", response: { id: "resp_i", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
    const out = parseAnthropicStreamChunk(events, "msg-i1", "x");
    const types = out.map(s => {
      const m = s.match(/event: ([^\n]+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // The chunk existence is verified by the event-order assertion above.
    // stop_reason mapping is exercised by the live e2e test.
  });

  test("response.function_call_arguments.done closes tool_use content_block", () => {
    const events = [
      { type: "response.created", response: { id: "resp_d", model: "x" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "call_1", call_id: "call_1", name: "shell_command", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "call_1", output_index: 0, delta: "{\"command\":\"echo\"}" },
      { type: "response.function_call_arguments.done", item_id: "call_1", output_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "call_1", call_id: "call_1", name: "shell_command", arguments: "{\"command\":\"echo\"}" } },
      { type: "response.completed", response: { id: "resp_d", usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
    const out = parseAnthropicStreamChunk(events, "msg-d1");
    const types = out.map(s => {
      const m = s.match(/event: ([^\n]+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    // The .done should emit content_block_stop; subsequent output_item.done should not
    // emit a duplicate stop (blockStarted is reset).
    expect(types.filter(t => t === "content_block_stop")).toHaveLength(1);
    expect(types).toContain("message_stop");
  });
});
