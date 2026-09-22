/**
 * Regression test: when a user adds a m.aiio.chat / minnimax.chat provider
 * with adapter=openai-responses (the GUI default), the model-fetch returns
 * an actionable hint pointing at the adapter mismatch instead of the
 * unhelpful "endpoint returned no models".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearKeyScheduleState } from "../src/providers/key-scheduler";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import type { OcxProviderConfig } from "../src/types";

let home: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-revproxy-"));
  process.env.OPENCODEX_HOME = home;
  originalFetch = globalThis.fetch;
  // return a valid 200 + empty array — this is the historical "endpoint
  // returned no models" symptom; the new error path fires BEFORE the fetch.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } })
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyCooldowns();
  clearKeyScheduleState();
});

function makeConfig(adapter: string, baseUrl: string): OcxProviderConfig {
  return {
    adapter,
    baseUrl,
    apiKey: "gw-test",
    apiKeyPool: [{ id: "k1", key: "gw-test" }],
  } as OcxProviderConfig;
}

describe("fetchProviderModels reverse-proxy hint", () => {
  test("m.aiio.chat + adapter=openai-responses → hint about adapter mismatch", async () => {
    const { fetchProviderModels } = await import("../src/providers/catalog-models");
    const result = await fetchProviderModels(
      makeConfig("openai-responses", "https://m.aiio.chat"),
      [{ key: "gw-test" }],
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/wrong adapter|reverse.?proxy/i);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/adapter=anthropic/i);
    expect(result.hint).toMatch(/x-api-key/i);
  });

  test("minnimax.chat + adapter=openai-chat → hint", async () => {
    const { fetchProviderModels } = await import("../src/providers/catalog-models");
    const result = await fetchProviderModels(
      makeConfig("openai-chat", "https://api.minnimax.chat/v1"),
      [{ key: "gw-test" }],
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.hint).toMatch(/anthropic/i);
  });

  test("m.aiio.chat + adapter=anthropic → no hint (proceeds to fetch)", async () => {
    const { fetchProviderModels } = await import("../src/providers/catalog-models");
    const result = await fetchProviderModels(
      makeConfig("anthropic", "https://m.aiio.chat"),
      [{ key: "gw-test" }],
    );
    // Adapter=anthropic passes the reverse-proxy gate and proceeds to fetch.
    // Mock fetch returns {data:[]} → legacy "endpoint returned no models" path.
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.hint).toBeUndefined();
    expect(result.error).toBe("endpoint returned no models");
  });

  test("ollama-cloud + adapter=openai-chat → no hint (not a reverse proxy)", async () => {
    const { fetchProviderModels } = await import("../src/providers/catalog-models");
    const result = await fetchProviderModels(
      makeConfig("openai-chat", "https://api.ollama-cloud.com/v1"),
      [{ key: "gw-test" }],
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.hint).toBeUndefined();
  });
});