import { describe, expect, test } from "bun:test";
import {
  DROPPED_IMAGE_TEXT,
  enforceUpstreamPromptBudget,
  learnedUpstreamPromptLimit,
  noteUpstreamPromptLimit,
  parseUpstreamPromptLimit,
  resetLearnedUpstreamLimits,
} from "../src/lib/upstream-prompt-budget";
import { stripBase64FromText } from "../src/adapters/anthropic-image-guard";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function userMessage(content: unknown[]): unknown {
  return { role: "user", content };
}

function nativeImage(data: string): unknown {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function textOf(messages: unknown[], index = 0): string {
  const content = (messages[index] as { content: Array<{ text?: string }> }).content;
  return content.map((b) => b.text ?? "").join("");
}

describe("upstream prompt budget (the brake Codex does not have)", () => {
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
    const body = { messages: [userMessage([nativeImage(PNG_B64)])] };
    const result = enforceUpstreamPromptBudget(body, undefined);
    expect(result.droppedImages).toBe(0);
    expect(result.body).toBe(body);
  });

  test("drops an image whose payload is not a usable data URL (the 2.2M-token shape)", () => {
    // A `url` source whose url is a 400KB blob is billed as TEXT upstream (~1.4 chars/token).
    const huge = "A".repeat(400_000);
    const body = {
      messages: [userMessage([{ type: "image", source: { type: "url", url: huge } }])],
    };
    const result = enforceUpstreamPromptBudget(body, 100_000);
    expect(result.droppedImages).toBe(1);
    expect(result.estimatedTokens).toBeLessThanOrEqual(100_000);
    const content = (result.body as { messages: Array<{ content: Array<{ type?: string; text?: string }> }> })
      .messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe(DROPPED_IMAGE_TEXT);
  });

  test("textifies the OLDEST images first when the estimate is over budget", () => {
    const body = {
      messages: [userMessage([nativeImage(PNG_B64), nativeImage(PNG_B64), nativeImage(PNG_B64)])],
    };
    // ~1.6k vision tokens per image: a 2k budget leaves room for roughly one image.
    const result = enforceUpstreamPromptBudget(body, 2_000);
    expect(result.droppedImages).toBeGreaterThan(0);
    const content = (result.body as { messages: Array<{ content: Array<{ type?: string }> }> })
      .messages[0].content;
    // The oldest image is the first one that got replaced.
    expect(content[0].type).toBe("text");
  });

  test("keeps a request that already fits untouched", () => {
    const body = { messages: [userMessage([nativeImage(PNG_B64)])] };
    const result = enforceUpstreamPromptBudget(body, 1_000_000);
    expect(result.droppedImages).toBe(0);
    expect(result.overBudget).toBe(false);
    expect(result.body).toBe(body);
  });

  test("accepts a JSON string body (what the adapters hand to fetch)", () => {
    const body = JSON.stringify({
      messages: [userMessage([{ type: "image", source: { type: "url", url: "B".repeat(300_000) } }])],
    });
    const result = enforceUpstreamPromptBudget(body, 100_000);
    expect(result.droppedImages).toBe(1);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.messages[0].content[0].type).toBe("text");
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
