import { describe, expect, test } from "bun:test";
import { collectImageInventory } from "../src/image/image-inventory";
import {
  detectImageBillingFamily,
  estimateImageTokens,
} from "../src/image/image-estimator";
import {
  dropOrder,
  droppedImagePlaceholder,
  fallbackOrder,
  planImages,
} from "../src/image/image-policy";

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function sizedPngBase64(width: number, height: number): string {
  return Buffer.from(Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32(13), 0x49, 0x48, 0x44, 0x52,
    ...u32(width), ...u32(height),
    8, 6, 0, 0, 0,
  ])).toString("base64");
}

const SMALL = sizedPngBase64(100, 100);
const BIG = sizedPngBase64(2000, 1500);

function imageBlock(data: string): unknown {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function body(messages: unknown[]): unknown {
  return { model: "m", max_tokens: 1024, messages };
}

describe("image inventory", () => {
  test("records dimensions, turn index and payload size for every image", () => {
    const wire = body([
      { role: "user", content: [imageBlock(SMALL)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [imageBlock(BIG)] },
    ]);
    const inventory = collectImageInventory(wire);
    expect(inventory.entries).toHaveLength(2);
    expect(inventory.entries[0]).toMatchObject({ width: 100, height: 100, messageIndex: 0, kind: "native" });
    expect(inventory.entries[1]).toMatchObject({ width: 2000, height: 1500, messageIndex: 2, kind: "native" });
  });

  test("marks a repeated payload as a duplicate of the first occurrence", () => {
    const wire = body([
      { role: "user", content: [imageBlock(SMALL), imageBlock(SMALL)] },
    ]);
    const inventory = collectImageInventory(wire);
    const plan = planImages(inventory, { providerName: "m.aiio.chat", modelId: "MiniMax-M3" });
    expect(plan.items[0].duplicate).toBe(false);
    expect(plan.items[1].duplicate).toBe(true);
  });

  test("an unusable payload is not a native image (it is billed as text upstream)", () => {
    const wire = body([
      { role: "user", content: [{ type: "image", source: { type: "url", url: "x".repeat(5000) } }] },
    ]);
    const inventory = collectImageInventory(wire);
    expect(inventory.entries[0].kind).toBe("unusable");
    expect(inventory.entries[0].payloadChars).toBe(5000);
  });
});

describe("image token estimation", () => {
  test("anthropic-style billing scales with pixel area", () => {
    const small = estimateImageTokens(1000, 760, "anthropic");
    const big = estimateImageTokens(2000, 1500, "anthropic");
    expect(small.method).toBe("anthropic-pixels");
    expect(small.confidence).toBe("high");
    expect(big.tokens).toBeGreaterThan(small.tokens * 2);
  });

  test("openai-style billing tiles the image", () => {
    const est = estimateImageTokens(1024, 1024, "openai");
    expect(est.method).toBe("openai-tiles");
    expect(est.confidence).toBe("medium");
    expect(est.tokens).toBe(85 + 170 * 4);
  });

  test("unknown dimensions fall back to a flat estimate with low confidence", () => {
    const est = estimateImageTokens(undefined, undefined, "anthropic");
    expect(est.method).toBe("flat-fallback");
    expect(est.confidence).toBe("low");
  });

  test("billing family detection", () => {
    expect(detectImageBillingFamily("m.aiio.chat", "MiniMax-M3")).toBe("anthropic");
    expect(detectImageBillingFamily("openai", "gpt-4o")).toBe("openai");
    expect(detectImageBillingFamily("some-relay", "some-model")).toBe("unknown");
  });
});

describe("image retention policy", () => {
  test("the current turn's images are protected from the normal drop order", () => {
    const wire = body([
      { role: "user", content: [imageBlock(BIG)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [imageBlock(SMALL)] },
    ]);
    const inventory = collectImageInventory(wire);
    // The first image is one turn old, so the default 4-turn recent window protects it.
    const plan = planImages(inventory, { providerName: "m.aiio.chat" });
    expect(plan.items[0].tier).toBe("P1-recent");
    expect(plan.items[1].tier).toBe("P0-current-turn");
    const order = dropOrder(plan).map(i => i.entry.ordinal);
    expect(order).toEqual([0]);

    // With no recent window, the same image becomes early history and is droppable.
    const strict = planImages(inventory, { providerName: "m.aiio.chat", preserveRecentTurns: 0 });
    expect(strict.items[0].tier).toBe("P3-early-unique");
    expect(dropOrder(strict).map(i => i.entry.ordinal)).toEqual([0]);
  });

  test("recent turns are protected, early history is sacrificed first", () => {
    const messages: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: [imageBlock(sizedPngBase64(10 + i, 10 + i))] });
      messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    }
    const inventory = collectImageInventory(body(messages));
    const plan = planImages(inventory, { providerName: "m.aiio.chat", preserveRecentTurns: 2 });
    const tiers = plan.items.map(i => i.tier);
    expect(tiers[0]).toBe("P3-early-unique");
    expect(tiers[tiers.length - 1]).toBe("P0-current-turn");
    expect(tiers).toContain("P1-recent");
  });

  test("duplicates are sacrificed before distinct images regardless of turn", () => {
    const wire = body([
      { role: "user", content: [imageBlock(BIG)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [imageBlock(SMALL), imageBlock(SMALL)] },
    ]);
    const inventory = collectImageInventory(wire);
    const plan = planImages(inventory, { providerName: "m.aiio.chat" });
    const order = dropOrder(plan).map(i => i.entry.ordinal);
    expect(order[0]).toBe(2);
  });

  test("the biggest image of a tier is sacrificed first (most tokens per loss)", () => {
    const wire = body([
      { role: "user", content: [imageBlock(sizedPngBase64(200, 200))] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [imageBlock(SMALL)] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [imageBlock(BIG)] },
    ]);
    const inventory = collectImageInventory(wire);
    const plan = planImages(inventory, { providerName: "m.aiio.chat", preserveRecentTurns: 0 });
    const order = dropOrder(plan);
    expect(order[0].entry.ordinal).toBe(0);
  });

  test("the current turn is only sacrificed as a last resort", () => {
    const wire = body([
      { role: "user", content: [imageBlock(BIG)] },
    ]);
    const inventory = collectImageInventory(wire);
    const plan = planImages(inventory, { providerName: "m.aiio.chat" });
    expect(dropOrder(plan)).toHaveLength(0);
    expect(fallbackOrder(plan)).toHaveLength(1);
  });

  test("the placeholder states what was lost", () => {
    const wire = body([{ role: "user", content: [imageBlock(BIG)] }]);
    const inventory = collectImageInventory(wire);
    const plan = planImages(inventory, { providerName: "m.aiio.chat" });
    const text = droppedImagePlaceholder(plan.items[0].entry, "dropped to fit the upstream context budget");
    expect(text).toContain("2000x1500");
    expect(text).toContain("dropped to fit the upstream context budget");
  });
});
