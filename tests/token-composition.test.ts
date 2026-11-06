import { describe, expect, test } from "bun:test";
import {
  detectWireShape,
  measureAnthropicWireComposition,
  measureResponsesWireComposition,
  measureWireComposition,
  summarizeComposition,
  summarizeRequestBody,
} from "../src/lib/token-composition";

/**
 * The measurement hook that makes the "Codex counted X, the upstream counted Y" gap
 * observable instead of a guess. Thread 01a18ae2 failed with the upstream reporting
 * 2,225,110 tokens while Codex's own meter said 340,260 — a 6.5x divergence that only the
 * upstream's view of the outgoing body can explain.
 */

describe("anthropic wire composition", () => {
  test("each content class is measured separately", () => {
    const composition = measureAnthropicWireComposition({
      system: [{ type: "text", text: "system prompt" }],
      tools: [{ name: "exec_command", description: "run a command" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello there" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering", signature: "sig" },
            { type: "tool_use", id: "t1", name: "exec_command", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file1\nfile2" }] },
          ],
        },
      ],
    });

    expect(composition.classes.system?.chars).toBe(13);
    expect(composition.classes.tool_schema?.count).toBe(1);
    expect(composition.classes.text?.chars).toBe(11);
    expect(composition.classes.thinking?.chars).toBe("pondering".length);
    expect(composition.classes.thinking_signature?.chars).toBe(3);
    expect(composition.classes.tool_call_args?.chars).toBeGreaterThan(0);
    expect(composition.classes.tool_result_text?.chars).toBe(11);
    expect(composition.totalChars).toBeGreaterThan(0);
    expect(composition.estimatedTokens).toBeGreaterThan(0);
  });

  test("a native image block is measured as vision, not as base64 text", () => {
    const composition = measureAnthropicWireComposition({
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) } },
        ],
      }],
    });

    // 100K base64 chars would be ~70K tokens if billed as text. As a native image block it
    // is billed as vision, so the estimate stays in the thousands.
    expect(composition.classes.image_native?.chars).toBe(100_000);
    expect(composition.classes.image_native?.estimatedTokens).toBeLessThan(5_000);
    expect(composition.classes.base64_in_text).toBeUndefined();
  });

  test("base64 that leaked into a text block is measured at the text rate", () => {
    const composition = measureAnthropicWireComposition({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "screenshot: data:image/png;base64," + "A".repeat(100_000) }],
      }],
    });

    // The billing hazard: this payload is counted as TEXT upstream (~1.4 chars/token),
    // which is what turns a screenshot into a 70K-token prompt.
    expect(composition.classes.base64_in_text?.chars).toBeGreaterThan(100_000);
    expect(composition.classes.base64_in_text!.estimatedTokens)
      .toBeGreaterThan(composition.classes.image_native?.estimatedTokens ?? 0);
  });

  test("a base64 payload inside a tool_result text is measured the same way", () => {
    const composition = measureAnthropicWireComposition({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "data:image/png;base64," + "B".repeat(50_000) }],
        }],
      }],
    });
    expect(composition.classes.base64_in_text?.chars).toBeGreaterThan(50_000);
  });
});

describe("responses wire composition", () => {
  test("measures the responses input shape", () => {
    const composition = measureResponsesWireComposition({
      instructions: "you are a coding agent",
      tools: [{ name: "exec_command" }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", summary: [{ text: "thinking" }], encrypted_content: "enc" },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "result" },
      ],
    });

    expect(composition.classes.system?.chars).toBe(22);
    expect(composition.classes.text?.chars).toBe(2);
    expect(composition.classes.thinking?.chars).toBe("thinking".length);
    expect(composition.classes.tool_call_args?.count).toBe(1);
    expect(composition.classes.tool_result_text?.chars).toBe(6);
  });
});

describe("wire shape dispatch", () => {
  test("detects the anthropic and responses shapes", () => {
    expect(detectWireShape({ messages: [] })).toBe("anthropic");
    expect(detectWireShape({ input: [] })).toBe("responses");
    expect(detectWireShape({ nothing: true })).toBe("unknown");
  });

  test("measureWireComposition picks the right measurer", () => {
    const anthropic = measureWireComposition({ messages: [{ role: "user", content: "hi" }] });
    expect(anthropic.classes.text?.chars).toBe(2);
    const responses = measureWireComposition({ input: [{ type: "message", role: "user", content: "hi" }] });
    expect(responses.totalChars).toBeGreaterThan(0);
  });
});

describe("summaries", () => {
  test("summarizeComposition sorts by estimated tokens, largest first", () => {
    const composition = measureAnthropicWireComposition({
      messages: [
        { role: "user", content: [{ type: "text", text: "x".repeat(1000) }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(100) }] },
      ],
    });
    const summary = summarizeComposition(composition);
    expect(summary[0].name).toBe("text");
    expect(summary[0].estimatedTokens).toBeGreaterThan(summary[1].estimatedTokens);
  });

  test("summarizeRequestBody parses a JSON body string", () => {
    const summary = summarizeRequestBody(JSON.stringify({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }));
    expect(summary?.classes[0].name).toBe("text");
    expect(summary?.estimatedTokens).toBeGreaterThan(0);
  });

  test("summarizeRequestBody returns undefined for an unusable body instead of throwing", () => {
    expect(summarizeRequestBody("not json")).toBeUndefined();
    expect(summarizeRequestBody("")).toBeUndefined();
    expect(summarizeRequestBody(undefined)).toBeUndefined();
  });
});
