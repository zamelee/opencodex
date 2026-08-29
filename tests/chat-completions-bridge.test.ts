import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetRoleEmittedForTesting,
  chatCompletionsBodyToResponsesBody,
  responsesSseToChatCompletionsSse,
  parseChatCompletionsStreamChunk,
} from "../src/server/chat-completions-bridge";

// ---------- inbound: Chat Completions -> Responses body ----------

describe("Patch 3a: chatCompletionsBodyToResponsesBody", () => {
  test("basic messages with system + user -> input array", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Hi" },
        ],
      }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.model).toBe("gpt-5");
    expect(body.instructions).toBe("You are concise.");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ]);
    expect(out.headers.get("content-type")).toBe("application/json");
  });

  test("multi-turn messages preserve order", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1" },
          { role: "user", content: "Q2" },
        ],
      }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input).toHaveLength(3);
    expect(body.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "Q1" }] });
    expect(body.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "A1" }] });
    expect(body.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "Q2" }] });
  });

  test("user content array of text + image_url preserved", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "https://x/y.png" } },
            ],
          },
        ],
      }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "https://x/y.png" },
    ]);
  });

  test("tools array maps to Responses tools shape", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a city",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "Get weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
  });

  test("stream=true -> stream=true and stream_include_usage=true", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.stream).toBe(true);
    expect(body.stream_include_usage).toBe(true);
  });

  test("stream=false -> non-streaming Responses body", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.stream).toBeUndefined();
    expect(body.stream_include_usage).toBeUndefined();
  });

  test("temperature / top_p / max_tokens pass through", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 256,
      }),
    });
    const out = await chatCompletionsBodyToResponsesBody(req);
    const body = JSON.parse(out.body);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.max_output_tokens).toBe(256);
  });
});

// ---------- outbound: Responses SSE -> Chat Completions SSE ----------

describe("Patch 3a: parseChatCompletionsStreamChunk", () => {
  beforeEach(() => __resetRoleEmittedForTesting());
  test("response.created emits first chat chunk with role marker", () => {
    const out = parseChatCompletionsStreamChunk([
      { type: "response.created", sequence_number: 0, response: { id: "resp_1" } },
    ], "cmpl-role1", "gpt-5");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.id).toBe("cmpl-role1");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe("gpt-5");
    expect(chunk.choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunk.choices[0].index).toBe(0);
  });

  test("response.in_progress alone is a no-op (role chunk already sent)", () => {
    // response.in_progress by itself should not produce a chunk.
    const out = parseChatCompletionsStreamChunk([
      { type: "response.in_progress", sequence_number: 1, response: { id: "resp_1" } },
    ], "cmpl-progress1");
    expect(out).toHaveLength(0);
  });

  test("response.output_item.added for message -> role delta", () => {
    const out = parseChatCompletionsStreamChunk([
      { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
    ], "cmpl-1");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.choices[0].delta).toEqual({ role: "assistant", content: "" });
  });

  test("response.content_part.added text -> content delta", () => {
    const out = parseChatCompletionsStreamChunk([
      { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    ], "cmpl-1");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.choices[0].delta).toEqual({ content: "" });
  });

  test("response.output_text.delta -> content delta", () => {
    const out = parseChatCompletionsStreamChunk([
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
    ], "cmpl-1");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.choices[0].delta.content).toBe("Hello");
  });

  test("response.output_text.done is a no-op (close handled by response.completed)", () => {
    // response.output_text.done is informational; finish_reason=stop is sent on response.completed.
    const out = parseChatCompletionsStreamChunk([
      { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello world" },
    ], "cmpl-done1");
    expect(out).toHaveLength(0);
  });

  test("response.output_item.done with function_call -> tool_calls delta", () => {
    const out = parseChatCompletionsStreamChunk([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_xyz",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      },
    ], "cmpl-1");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.choices[0].finish_reason).toBe("tool_calls");
    expect(chunk.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "call_xyz",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SF"}' },
    });
  });

  test("response.completed -> final chunk with usage + finish_reason stop", () => {
    const out = parseChatCompletionsStreamChunk([
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      },
    ], "cmpl-1");
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]);
    expect(chunk.choices[0].finish_reason).toBe("stop");
    expect(chunk.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  test("ignored events produce no chunks", () => {
    const out = parseChatCompletionsStreamChunk([
      { type: "response.heartbeat" },
      { type: "response.refusal.delta", delta: "..." },
    ], "cmpl-1");
    expect(out).toHaveLength(0);
  });
});

describe("Patch 3a follow-up: responsesJsonToChatCompletionsJson function_call", () => {
  // buildResponsesJson is internal to the bridge module; we exercise it indirectly
  // through a fetch call. To keep the test pure, test the streaming translation via
  // parseChatCompletionsStreamChunk and trust the live e2e check for non-streaming.
  // (See tests/e2e-chat-completions-stream.test.ts / opencodex/tests/_test_try_bootstrap_bun.py
  // for the wire-level verification.)
  test("function_call event sequence translates to OpenAI tool_calls chunks", () => {
    const events = [
      { type: "response.created", response: { id: "resp_1", model: "x" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "call_1", call_id: "call_1", name: "shell_command", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "call_1", output_index: 0, delta: '{"command":"echo hi"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "call_1", call_id: "call_1", name: "shell_command", arguments: '{"command":"echo hi"}' } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
    const out = parseChatCompletionsStreamChunk(events, "cmpl-1");
    // Find the LAST tool_calls-bearing chunk (the final one carries finish_reason=tool_calls + complete args).
    const toolChunks = out.map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(c => c && c.choices && c.choices[0].delta && c.choices[0].delta.tool_calls);
    expect(toolChunks.length).toBeGreaterThan(0);
    const finalTool = toolChunks[toolChunks.length - 1];
    expect(finalTool.choices[0].finish_reason).toBe("tool_calls");
    const tc = finalTool.choices[0].delta.tool_calls[0];
    expect(tc.function.name).toBe("shell_command");
    expect(tc.function.arguments).toBe('{"command":"echo hi"}');
  });
});
