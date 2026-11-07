import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";

const prov = { adapter: "anthropic", baseUrl: "https://example.test", contextWindow: 700_000 };

describe("the upstream's own declaration survives our caps", () => {
  test("a raw model that declares 1M keeps that number next to our 700k cap", () => {
    const hinted = applyProviderConfigHints("m.aiio.chat", prov, {
      id: "MiniMax-M3",
      provider: "m.aiio.chat",
      contextWindow: 1_000_000,
    });
    expect(hinted.upstreamContextWindow).toBe(1_000_000);
    expect(hinted.contextWindow).toBe(700_000);
  });

  test("an upstream that declares NOTHING does not get our cap quoted as its declaration", () => {
    const hinted = applyProviderConfigHints("m.aiio.chat", prov, {
      id: "MiniMax-M3",
      provider: "m.aiio.chat",
    });
    expect(hinted.upstreamContextWindow).toBeUndefined();
    expect(hinted.contextWindow).toBe(700_000);
  });

  test("re-hinting an already-hinted model does not fabricate a declaration", () => {
    // The per-provider model cache stores RAW models, but any model that already went through
    // the hints must not have our own cap quoted back as the upstream's number.
    const once = applyProviderConfigHints("m.aiio.chat", prov, {
      id: "MiniMax-M3",
      provider: "m.aiio.chat",
    });
    const twice = applyProviderConfigHints("m.aiio.chat", prov, once);
    expect(twice.upstreamContextWindow).toBeUndefined();
    expect(twice.contextWindow).toBe(700_000);
  });

  test("re-hinting a declared model keeps the original declaration", () => {
    const once = applyProviderConfigHints("m.aiio.chat", prov, {
      id: "MiniMax-M3",
      provider: "m.aiio.chat",
      contextWindow: 1_000_000,
    });
    const twice = applyProviderConfigHints("m.aiio.chat", prov, once);
    expect(twice.upstreamContextWindow).toBe(1_000_000);
    expect(twice.contextWindow).toBe(700_000);
  });
});
