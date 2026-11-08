import { describe, expect, test } from "bun:test";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as OcxConfig;

describe("Codex catalog refresh", () => {
  test("never invalidates the Codex models cache: the Codex home is not ours to touch", async () => {
    let invalidated = 0;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/opencodex-catalog.json" }),
      invalidateCodexModelsCache: () => { invalidated += 1; },
      existsSync: () => true,
    });

    expect(result).toEqual({
      added: 0,
      path: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      cacheSynced: false,
    });
    expect(invalidated).toBe(0);
  });

  test("does not touch the cache when no Codex catalog can be materialized", async () => {
    let invalidated = 0;
    const result = await refreshCodexModelCatalog(config, {
      syncCatalogModels: async () => ({ added: 0, path: "/tmp/missing-catalog.json" }),
      invalidateCodexModelsCache: () => { invalidated += 1; },
      existsSync: () => false,
    });

    expect(result.catalogExists).toBe(false);
    expect(result.cacheSynced).toBe(false);
    expect(invalidated).toBe(0);
  });
});
