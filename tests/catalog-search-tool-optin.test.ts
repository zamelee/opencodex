import { describe, expect, test } from "bun:test";
import { normalizeRoutedCatalogEntry, applyProviderConfigHints } from "../src/codex/catalog";

describe("the hosted web_search tool is opt-in per provider", () => {
  test("a routed provider does NOT advertise web search by default", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "m.aiio.chat/MiniMax-M3" } as never) as Record<string, unknown>;
    expect(entry.supports_search_tool).toBe(false);
    expect(entry.web_search_tool_type).toBeUndefined();
  });

  test("a routed provider that opts in advertises it", () => {
    const entry = normalizeRoutedCatalogEntry(
      { slug: "m.aiio.chat/MiniMax-M3" } as never,
      false,
      true,
    ) as Record<string, unknown>;
    expect(entry.supports_search_tool).toBe(true);
    expect(entry.web_search_tool_type).toBe("text_and_image");
  });

  test("the provider config hint carries the opt-in onto the model entry", () => {
    const base = { adapter: "anthropic", baseUrl: "https://example.test" };
    const off = applyProviderConfigHints("m.aiio.chat", base, { id: "MiniMax-M3", provider: "m.aiio.chat" });
    expect(off.supportsSearchTool).toBe(false);
    const on = applyProviderConfigHints(
      "m.aiio.chat",
      { ...base, supportsSearchTool: true },
      { id: "MiniMax-M3", provider: "m.aiio.chat" },
    );
    expect(on.supportsSearchTool).toBe(true);
  });
});
