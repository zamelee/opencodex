/**
 * Regression test for the bug where probeMinimaxKeyQuotas() URL-joined
 * `/v1/usage` to a baseUrl that already ended with `/v1`, producing
 * `/v1/v1/usage` and silently returning nothing. The probe now shares
 * stripBase() with catalog-models.ts so both halves of the minimax-chat
 * pipeline treat trailing `/v1` the same way.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setProbeForTests, clearKeyScheduleState } from "../src/providers/key-scheduler";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let home: string;
let capturedUrls: string[] = [];
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
        apiKeyPool: [
          { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
        ],
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
  home = mkdtempSync(join(tmpdir(), "ocx-baseurl-"));
  process.env.OPENCODEX_HOME = home;
  capturedUrls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/v1/usage")) {
      capturedUrls.push(url);
      return new Response(usagePayload, { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, _init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setProbeForTests(null);
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyCooldowns();
  clearKeyScheduleState();
});

describe("probeMinimaxKeyQuotas URL normalization", () => {
  test("baseUrl without /v1 suffix", async () => {
    const cfg = makeConfig("https://m.aiio.chat");
    const { probeMinimaxKeyQuotas } = await import("../src/providers/quota");
    const result = await probeMinimaxKeyQuotas(cfg.providers.p!);
    expect(result).not.toBeNull();
    expect(capturedUrls).toEqual(["https://m.aiio.chat/v1/usage"]);
  });

  test("baseUrl WITH trailing /v1 suffix (regression: must not produce /v1/v1/usage)", async () => {
    const cfg = makeConfig("https://m.aiio.chat/v1");
    const { probeMinimaxKeyQuotas } = await import("../src/providers/quota");
    const result = await probeMinimaxKeyQuotas(cfg.providers.p!);
    expect(result).not.toBeNull();
    // Critical: NOT `/v1/v1/usage`.
    expect(capturedUrls).toEqual(["https://m.aiio.chat/v1/usage"]);
  });

  test("baseUrl with trailing slashes plus /v1", async () => {
    const cfg = makeConfig("https://m.aiio.chat///v1/");
    const { probeMinimaxKeyQuotas } = await import("../src/providers/quota");
    const result = await probeMinimaxKeyQuotas(cfg.providers.p!);
    expect(result).not.toBeNull();
    expect(capturedUrls).toEqual(["https://m.aiio.chat/v1/usage"]);
  });
});
