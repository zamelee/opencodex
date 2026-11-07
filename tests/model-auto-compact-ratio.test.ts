import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints, resolveAutoCompactRatio } from "../src/codex/catalog";

const base = { adapter: "anthropic", baseUrl: "https://example.test" };
const model = { id: "MiniMax-M3", provider: "m.aiio.chat" };

describe("the per-model auto-compact ratio", () => {
  test("without a pin the provider-wide ratio is used", () => {
    const hinted = applyProviderConfigHints("m.aiio.chat", { ...base, autoCompactRatio: 0.8 }, model);
    expect(hinted.autoCompactRatio).toBe(0.8);
  });

  test("without anything the default is 0.9", () => {
    const hinted = applyProviderConfigHints("m.aiio.chat", base, model);
    expect(hinted.autoCompactRatio).toBe(0.9);
  });

  test("a per-model pin wins over the provider-wide ratio", () => {
    const hinted = applyProviderConfigHints(
      "m.aiio.chat",
      { ...base, autoCompactRatio: 0.8, modelAutoCompactRatios: { "m.aiio.chat/MiniMax-M3": 0.65 } },
      model,
    );
    expect(hinted.autoCompactRatio).toBe(0.65);
  });

  test("the bare model id is accepted as a key too", () => {
    const hinted = applyProviderConfigHints(
      "m.aiio.chat",
      { ...base, modelAutoCompactRatios: { "MiniMax-M3": 0.7 } },
      model,
    );
    expect(hinted.autoCompactRatio).toBe(0.7);
  });

  test("a pin for ANOTHER model does not leak into this row", () => {
    const hinted = applyProviderConfigHints(
      "m.aiio.chat",
      { ...base, modelAutoCompactRatios: { "m.aiio.chat/Other": 0.65 } },
      model,
    );
    expect(hinted.autoCompactRatio).toBe(0.9);
  });

  test("an out-of-range pin is ignored (falls back to the provider ratio), not clamped to 0.9", () => {
    const hinted = applyProviderConfigHints(
      "m.aiio.chat",
      { ...base, autoCompactRatio: 0.8, modelAutoCompactRatios: { "m.aiio.chat/MiniMax-M3": 1.4 } },
      model,
    );
    expect(hinted.autoCompactRatio).toBe(0.8);
  });

  test("resolveAutoCompactRatio keeps the 0.5 - 0.95 band", () => {
    expect(resolveAutoCompactRatio(0.5)).toBe(0.5);
    expect(resolveAutoCompactRatio(0.95)).toBe(0.95);
    expect(resolveAutoCompactRatio(0.49)).toBe(0.9);
    expect(resolveAutoCompactRatio(0.96)).toBe(0.9);
    expect(resolveAutoCompactRatio("0.8")).toBe(0.9);
  });
});
