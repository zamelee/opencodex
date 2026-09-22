/**
 * Regression test for the 401 mystery: probeMinimaxKeyQuotas() was sending
 * five headers ({ x-api-key, anthropic-version, User-Agent, Accept }) but
 * the minimax.chat dashboard JS bundle sends only `{ "x-api-key": <key> }`.
 * The reverse proxy treats extra headers as a rejection signal and returns
 * 401. Same fix applies to fetchAnthropicModels() in catalog-models.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearKeyScheduleState } from "../src/providers/key-scheduler";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let home: string;
let capturedHeaders: Record<string, string>[] = [];
let originalFetch: typeof globalThis.fetch;

function makeConfig(baseUrl: string): OcxConfig {
  return {
    port: 10199,
    defaultProvider: "p",
    providers: {
      p: {
        adapter: "anthropic",
        baseUrl,
        apiKey: "key-alpha-000111222333",
        apiKeyPool: [{ id: "k1", key: "key-alpha-000111222333", addedAt: 1 }],
      } as OcxProviderConfig,
    },
  } as OcxConfig;
}

const usagePayload = JSON.stringify({
  rolling_5h: { limit: 2500, used: 100, window_start: 0, window_end: 0 },
  weekly: { limit: 21250, used: 500, resets_at: 0, week_start: 0 },
  plan_name: "test",
  expires_at: 0,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-mini-hdr-"));
  process.env.OPENCODEX_HOME = home;
  capturedHeaders = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const req = new Request(input, _init);
    const h: Record<string, string> = {};
    req.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    capturedHeaders.push(h);
    if (req.url.includes("/v1/usage")) {
      return new Response(usagePayload, { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, _init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyCooldowns();
  clearKeyScheduleState();
});

describe("minimax probe sends ONLY x-api-key (matches dashboard JS)", () => {
  test("probeMinimaxKeyQuotas: x-api-key only, no extras", async () => {
    const cfg = makeConfig("https://m.aiio.chat");
    const { probeMinimaxKeyQuotas } = await import("../src/providers/quota");
    await probeMinimaxKeyQuotas(cfg.providers.p!);
    expect(capturedHeaders.length).toBe(1);
    const h = capturedHeaders[0]!;
    expect(h["x-api-key"]).toBe("key-alpha-000111222333");
    expect(h["anthropic-version"]).toBeUndefined();
    expect(h["user-agent"]).toBeUndefined();
    expect(h["accept"]).toBeUndefined();
  });

  test("fetchAnthropicModels: x-api-key only", async () => {
    const cfg = makeConfig("https://m.aiio.chat");
    const { fetchProviderModels } = await import("../src/providers/catalog-models");
    await fetchProviderModels(cfg.providers.p!, [{ key: "key-alpha-000111222333" }]);
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(1);
    const h = capturedHeaders[capturedHeaders.length - 1]!;
    expect(h["x-api-key"]).toBeTruthy();
    expect(h["anthropic-version"]).toBeUndefined();
    expect(h["user-agent"]).toBeUndefined();
    expect(h["accept"]).toBeUndefined();
  });
});
