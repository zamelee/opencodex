import { describe, expect, test } from "bun:test";
import {
  COMPACTION_BUDGET_FACTOR,
  DROPPED_IMAGE_TEXT,
  effectiveUpstreamPromptLimit,
  enforceUpstreamPromptBudget,
  learnedUpstreamPromptLimit,
  noteUpstreamPromptLimit,
  parseUpstreamPromptLimit,
  resetLearnedUpstreamLimits,
} from "../src/lib/upstream-prompt-budget";
import { stripBase64FromText } from "../src/adapters/anthropic-image-guard";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A PNG header for the given size. Only the header matters here: the estimator bills an image
 * by its pixel count (w*h/750), and the sniffer reads w/h straight out of the IHDR chunk.
 */
function sizedPngBase64(width: number, height: number): string {
  const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Buffer.from(Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32(13), 0x49, 0x48, 0x44, 0x52,
    ...u32(width), ...u32(height),
    8, 6, 0, 0, 0,
  ])).toString("base64");
}

/** A 1000x760 screenshot: ~1013 vision tokens at the upstream's pixel rate. */
const SCREENSHOT_B64 = sizedPngBase64(1000, 760);

function userMessage(content: unknown[]): unknown {
  return { role: "user", content };
}

/** An Anthropic wire body always carries `max_tokens`; the brake keys off that shape. */
function anthropicBody(messages: unknown[]): { model: string; max_tokens: number; messages: unknown[] } {
  return { model: "test-model", max_tokens: 1024, messages };
}

function nativeImage(data: string): unknown {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function textOf(messages: unknown[], index = 0): string {
  const content = (messages[index] as { content: Array<{ text?: string }> }).content;
  return content.map((b) => b.text ?? "").join("");
}

describe("upstream prompt budget (the brake Codex does not have)", () => {
  test("the enforced budget reserves the output and is stricter for compaction", () => {
    expect(effectiveUpstreamPromptLimit(1_048_576)).toBe(1_048_576);
    expect(effectiveUpstreamPromptLimit(1_048_576, { outputReserve: 8_000 })).toBe(1_040_576);
    expect(effectiveUpstreamPromptLimit(1_048_576, { compaction: true, outputReserve: 8_000 }))
      .toBe(Math.floor(1_048_576 * COMPACTION_BUDGET_FACTOR) - 8_000);
  });

  test("learns the upstream window from its own error text", () => {
    expect(parseUpstreamPromptLimit(
      '{"code":11115,"msg":"prompt is too long: 2225110 tokens > 1048576 maximum"}',
    )).toBe(1_048_576);
    expect(parseUpstreamPromptLimit("some other error")).toBeUndefined();
  });

  test("remembers the smallest limit seen per provider", () => {
    resetLearnedUpstreamLimits();
    noteUpstreamPromptLimit("m.aiio.chat", 1_048_576);
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBe(1_048_576);
    noteUpstreamPromptLimit("m.aiio.chat", 262_144);
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBe(262_144);
    expect(learnedUpstreamPromptLimit("other")).toBeUndefined();
    resetLearnedUpstreamLimits();
  });

  test("does nothing when there is no limit", () => {
    const body = anthropicBody([userMessage([nativeImage(PNG_B64)])]);
    const result = enforceUpstreamPromptBudget(body, undefined);
    expect(result.droppedImages).toBe(0);
    expect(result.body).toBe(body);
  });

  test("drops an image whose payload is not a usable data URL (the 2.2M-token shape)", () => {
    // A `url` source whose url is a 400KB blob is billed as TEXT upstream (~1.4 chars/token).
    const huge = "A".repeat(400_000);
    const body = anthropicBody([userMessage([{ type: "image", source: { type: "url", url: huge } }])]);
    const result = enforceUpstreamPromptBudget(body, 100_000);
    expect(result.droppedImages).toBe(1);
    expect(result.estimatedTokens).toBeLessThanOrEqual(100_000);
    const content = (result.body as { messages: Array<{ content: Array<{ type?: string; text?: string }> }> })
      .messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe(DROPPED_IMAGE_TEXT);
  });

  test("textifies the OLDEST images first when the estimate is over budget", () => {
    const body = anthropicBody([
      userMessage([nativeImage(SCREENSHOT_B64), nativeImage(SCREENSHOT_B64), nativeImage(SCREENSHOT_B64)]),
    ]);
    // 3 x ~1013 vision tokens: a 2k budget leaves room for roughly one image.
    const result = enforceUpstreamPromptBudget(body, 2_000);
    expect(result.droppedImages).toBeGreaterThan(0);
    const content = (result.body as { messages: Array<{ content: Array<{ type?: string }> }> })
      .messages[0].content;
    // The oldest image is the first one that got replaced.
    expect(content[0].type).toBe("text");
  });

  test("keeps a request that already fits untouched", () => {
    const body = anthropicBody([userMessage([nativeImage(PNG_B64)])]);
    const result = enforceUpstreamPromptBudget(body, 1_000_000);
    expect(result.droppedImages).toBe(0);
    expect(result.overBudget).toBe(false);
    expect(result.body).toBe(body);
  });

  test("accepts a JSON string body (what the adapters hand to fetch)", () => {
    const body = JSON.stringify(anthropicBody([
      userMessage([{ type: "image", source: { type: "url", url: "B".repeat(300_000) } }]),
    ]));
    const result = enforceUpstreamPromptBudget(body, 100_000);
    expect(result.droppedImages).toBe(1);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.messages[0].content[0].type).toBe("text");
  });

  test("does not touch a non-Anthropic wire body (an OpenAI image_url part is not ours)", () => {
    const body = {
      model: "gpt-x",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "C".repeat(300_000) } }],
      }],
    };
    const result = enforceUpstreamPromptBudget(body, 10_000);
    expect(result.droppedImages).toBe(0);
    expect(result.body).toBe(body);
  });
});

describe("base64 in text blocks (the billing hazard)", () => {
  function strip(text: string): string {
    const messages = [userMessage([{ type: "text", text }])];
    stripBase64FromText(messages);
    return textOf(messages);
  }

  test("strips a plain data URL", () => {
    expect(strip("shot: data:image/png;base64," + PNG_B64)).not.toContain(PNG_B64);
  });

  test("strips a MIME-wrapped data URL (line breaks inside the payload)", () => {
    const wrapped = "data:image/png;base64," + PNG_B64.slice(0, 40) + "\n" + PNG_B64.slice(40);
    const out = strip("shot: " + wrapped);
    expect(out).not.toContain(PNG_B64.slice(40));
    expect(out.length).toBeLessThan(200);
  });

  test("strips a URL-safe data URL (- and _ in the payload)", () => {
    const urlSafe = "data:image/png;base64," + PNG_B64.slice(0, 20) + "-_" + PNG_B64.slice(22);
    const out = strip("shot: " + urlSafe);
    expect(out).not.toContain(PNG_B64.slice(22));
  });

  test("strips raw base64 that has no data-URL prefix", () => {
    const raw = "A".repeat(600);
    const out = strip("blob: " + raw);
    expect(out).not.toContain(raw);
  });

  test("leaves ordinary prose and short identifiers alone", () => {
    const prose = "the quick brown fox jumps over the lazy dog; commit 9f2a1c4 sha=abcdef0123456789";
    expect(strip(prose)).toBe(prose);
  });
});
