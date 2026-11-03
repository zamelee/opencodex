import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { enforceAnthropicImageLimits, stripBase64FromText } from "../src/adapters/anthropic-image-guard";
import { classifyError } from "../src/lib/errors";
import { parseRequest } from "../src/responses/parser";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * Regression coverage for the context-window blowup that killed threads
 * 01a17cf0 (2,307,450 tokens) and 01a19af4 (3,393,866 tokens):
 *
 *  - Codex's own meter showed ~507K tokens, so auto-compact (limit 850K)
 *    never fired and the turn ran straight into the upstream wall.
 *  - The upstream counted the request at 3.39M tokens because base64 image
 *    payloads were billed as TEXT (~1.4 chars/token) instead of as vision.
 *  - The upstream error ("prompt is too long: N tokens > M maximum") was
 *    classified as a generic invalid_request_error, so Codex never entered
 *    its ContextWindowExceeded path and never compacted.
 */

const provider = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-x",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

function parsed(messages: OcxMessage[]): OcxParsedRequest {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: {},
    context: { messages },
  };
}

function bodyOf(p: OcxParsedRequest): { messages: Array<{ role: string; content: unknown }> } {
  const { body } = createAnthropicAdapter(provider).buildRequest(p);
  return JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
    messages: Array<{ role: string; content: unknown }>;
  };
}

/** A 1x1 PNG data URL — small, but structurally identical to a screenshot. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface WireBlock { type?: string; text?: string; source?: { data?: string } }

function allBlocks(messages: Array<{ role: string; content: unknown }>): WireBlock[] {
  const out: WireBlock[] = [];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      out.push({ type: "text", text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content as WireBlock[]) {
      out.push(b);
      if (b.type === "tool_result") {
        const inner = (b as unknown as { content?: unknown }).content;
        if (Array.isArray(inner)) out.push(...(inner as WireBlock[]));
      }
    }
  }
  return out;
}

describe("anthropic context-overflow regression", () => {
  test("upstream 'prompt is too long' is classified as a context overflow", () => {
    // The exact upstream message that killed thread 01a19af4.
    const message =
      'Provider error 400: {"error":{"type":"prompt_too_long","message":{"code":11115,' +
      '"msg":"prompt is too long: 3393866 tokens > 1048576 maximum","requestId":"f2c3",' +
      '"retry_policy":{"retry":false},"extError":{"code":"invalid_request_error",' +
      '"message":"prompt is too long: 3393866 tokens > 1048576 maximum",' +
      '"type":"invalid_request_error"}}}';

    const classified = classifyError(400, "upstream_error", message);
    expect(classified.code).toBe("context_length_exceeded");
  });

  test("other relay overflow phrasings are also classified as context overflow", () => {
    for (const message of [
      "prompt_too_long",
      "input is too long: 500000 tokens",
      "context window exceeds limit (2013)",
      "Your input exceeds the context window of this model",
    ]) {
      expect(classifyError(400, "upstream_error", message).code).toBe("context_length_exceeded");
    }
  });

  test("an unrelated 400 stays a plain invalid_request_error", () => {
    // Guard against the keyword list swallowing non-overflow failures.
    expect(classifyError(400, "upstream_error", "invalid image content: decode failed").code)
      .toBe("invalid_request_error");
    expect(classifyError(400, "upstream_error", "model unavailable").code)
      .toBe("invalid_request_error");
  });

  test("an orphaned tool result never inlines base64 as text", () => {
    const body = bodyOf(parsed([
      { role: "user", content: "look", timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "unpaired-1",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        isError: false,
        timestamp: 0,
      },
    ]));

    for (const block of allBlocks(body.messages)) {
      expect(block.text ?? "").not.toContain("base64,");
    }
  });

  test("an orphaned tool result's image is still delivered as a native image block", () => {
    const body = bodyOf(parsed([
      { role: "user", content: "look", timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "unpaired-1",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        isError: false,
        timestamp: 0,
      },
    ]));

    const images = allBlocks(body.messages).filter((b) => b.type === "image");
    expect(images.length).toBe(1);
    expect(images[0].source?.data).toBeTruthy();
  });

  test("an orphaned tool result keeps its text content", () => {
    const body = bodyOf(parsed([
      { role: "user", content: "look", timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "unpaired-1",
        toolName: "exec_command",
        content: [{ type: "text", text: "hello from the tool" }],
        isError: false,
        timestamp: 0,
      },
    ]));

    const texts = allBlocks(body.messages).map((b) => b.text ?? "").join("\n");
    expect(texts).toContain("hello from the tool");
  });

  test("a paired tool result keeps its image inline in the tool_result", () => {
    const body = bodyOf(parsed([
      { role: "user", content: "look", timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "view_image", arguments: {} }], model: "claude", timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        isError: false,
        timestamp: 0,
      },
    ]));

    const images = allBlocks(body.messages).filter((b) => b.type === "image");
    expect(images.length).toBe(1);
  });

  test("stripBase64FromText removes a leaked data URL but keeps the surrounding text", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: `[tool_result without adjacent tool_use: view_image]\n${PNG_DATA_URL}` },
        ],
      },
    ];

    const stripped = stripBase64FromText(messages);
    expect(stripped).toBe(1);
    const text = (messages[0].content[0] as { text: string }).text;
    expect(text).not.toContain("base64,");
    expect(text).toContain("tool_result without adjacent tool_use");
  });

  test("stripBase64FromText also reaches base64 nested in tool_result content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: PNG_DATA_URL }] },
        ],
      },
    ];

    expect(stripBase64FromText(messages)).toBe(1);
    const inner = (messages[0].content[0] as { content: Array<{ text: string }> }).content;
    expect(inner[0].text).not.toContain("base64,");
  });

  test("enforceAnthropicImageLimits leaves native image blocks alone", () => {
    // Native image blocks are billed as vision, not text — the budget rule
    // must not drop them.
    const messages = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
      },
    ];
    enforceAnthropicImageLimits(messages);
    expect((messages[0].content[0] as { type?: string }).type).toBe("image");
  });

  test("a JSON-string content payload is parsed back into an image part", () => {
    const parsedRequest = parseRequest({
      model: "anthropic/claude-sonnet-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "look" }] },
        { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "c1",
          output: JSON.stringify([{ type: "input_image", image_url: PNG_DATA_URL, detail: "high" }]),
        },
      ],
    });

    const toolResult = parsedRequest.context.messages.find((m) => m.role === "toolResult") as
      | { content: unknown }
      | undefined;
    expect(Array.isArray(toolResult?.content)).toBe(true);
    const parts = toolResult?.content as Array<{ type?: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });

  test("a plain string tool output is left untouched", () => {
    const parsedRequest = parseRequest({
      model: "anthropic/claude-sonnet-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", "text": "look" }] },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "file1\nfile2" },
      ],
    });

    const toolResult = parsedRequest.context.messages.find((m) => m.role === "toolResult") as
      | { content: unknown }
      | undefined;
    expect(toolResult?.content).toBe("file1\nfile2");
  });
});
