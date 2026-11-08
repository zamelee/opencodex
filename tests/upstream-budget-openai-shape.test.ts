import { describe, expect, test } from "bun:test";
import { detectWireShape, measureChatCompletionsWireComposition } from "../src/lib/token-composition";
import { collectImageInventory } from "../src/image/image-inventory";
import { enforceUpstreamPromptBudget } from "../src/lib/upstream-prompt-budget";

/** A 1x1 PNG, base64. Small enough to keep the test fast, real enough to sniff. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function chatBody(imageUrl: string, text = "hello"): unknown {
  return {
    model: "some-model",
    max_tokens: 1024,
    messages: [
      { role: "system", content: "you are a helpful assistant" },
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  };
}

describe("the budget brake sees the OpenAI chat-completions wire shape", () => {
  test("a chat-completions body is not mistaken for an Anthropic one", () => {
    expect(detectWireShape(chatBody("data:image/png;base64," + PNG_1PX))).toBe("chat-completions");
    expect(detectWireShape({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: PNG_1PX } }] }],
    })).toBe("anthropic");
  });

  test("an image_url block is billed as vision, not as text", () => {
    const composition = measureChatCompletionsWireComposition(chatBody("data:image/png;base64," + PNG_1PX));
    expect(composition.classes.image_native?.count).toBe(1);
    expect(composition.classes.image_native?.estimatedTokens ?? 0).toBeGreaterThan(0);
    expect(composition.classes.image_unusable_as_text).toBeUndefined();
  });

  test("the inventory finds the image and records the shape it came from", () => {
    const body = chatBody("data:image/png;base64," + PNG_1PX) as { messages: Array<{ content: unknown[] }> };
    const inventory = collectImageInventory(body);
    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0].kind).toBe("native");
    expect(inventory.entries[0].shape).toBe("chat-completions");
  });

  test("an over-budget chat-completions body is degraded instead of being sent as-is", async () => {
    const body = chatBody("data:image/png;base64," + PNG_1PX, "x".repeat(50_000));
    const result = await enforceUpstreamPromptBudget(body, 1_000);
    expect(result.droppedImages).toBeGreaterThan(0);
    const out = result.body as { messages: Array<{ content: Array<{ type?: string; text?: string }> }> };
    const parts = out.messages[1].content;
    // The image is gone, replaced by a text placeholder the model can read.
    expect(parts.some(p => p.type === "image_url")).toBe(false);
    expect(parts.some(p => p.type === "text" && (p.text ?? "").includes("image omitted"))).toBe(true);
  });

  test("the Anthropic shape still works", async () => {
    const body = {
      model: "some-model",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "x".repeat(50_000) },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } },
        ],
      }],
    };
    const result = await enforceUpstreamPromptBudget(body, 1_000);
    expect(result.droppedImages).toBeGreaterThan(0);
  });

  test("a Responses body is left alone: we do not rewrite a protocol we do not own", async () => {
    const body = {
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "x".repeat(50_000) },
          { type: "input_image", image_url: "data:image/png;base64," + PNG_1PX },
        ],
      }],
    };
    const result = await enforceUpstreamPromptBudget(body, 1_000);
    expect(result.droppedImages).toBe(0);
    expect(result.body).toBe(body);
  });
});
