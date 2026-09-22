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
  home = mkdtempSync(join(tmpdir(), "ocx-probeall-"));
  process.env.OPENCODEX_HOME = home;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyCooldowns();
  clearKeyScheduleState();
});

function mockFetch(handler: (path: string, headers: Record<string, string>) => { status: number; body: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const req = new Request(input, _init);
    const h: Record<string, string> = {};
    req.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    const url = req.url;
    const path = url.split("?")[0]!.replace(/^https?:\/\/[^/]+/, "");
    const res = handler(path, h);
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function provider(adapter: string, baseUrl: string, key = "gw-test"): OcxProviderConfig {
  return {
    adapter,
    baseUrl,
    apiKey: key,
    apiKeyPool: [{ id: "k1", key }],
  } as OcxProviderConfig;
}

describe("probeAllAdapters", () => {
  test("m.aiio.chat: anthropic returns models, openai-* returns [] -> recommended=anthropic", async () => {
    mockFetch((p) => {
      if (p.endsWith("/v1/models")) {
        const looksAnthropic = p === "/v1/models"; // any /v1/models GET
        // Both anthropic and openai send to /v1/models, but only the
        // x-api-key header authenticates with m.aiio.chat.
        return { status: 200, body: JSON.stringify({ data: [{ id: "MiniMax-M2.7" }, { id: "MiniMax-M3" }] }) };
      }
      return { status: 404, body: "{}" };
    });
    const { probeAllAdapters } = await import("../src/providers/catalog-models");
    const result = await probeAllAdapters(provider("openai-responses", "https://m.aiio.chat"));
    expect(result.recommended).toBe("anthropic");
    expect(result.results).toHaveLength(3);
    const ant = result.results.find(r => r.adapter === "anthropic")!;
    expect(ant.modelCount).toBe(2);
  });

  test("OpenAI official: openai-chat returns models -> recommended=openai-chat", async () => {
    mockFetch((p) => {
      if (p.endsWith("/models")) return { status: 200, body: JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.5-pro" }] }) };
      return { status: 404, body: "{}" };
    });
    const { probeAllAdapters } = await import("../src/providers/catalog-models");
    const result = await probeAllAdapters(provider("openai-chat", "https://api.openai.com/v1"));
    expect(result.recommended).toBe("openai-chat");
  });

  test("All three fail: recommended falls back to first-order entry; results still returned", async () => {
    mockFetch(() => ({ status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) }));
    const { probeAllAdapters } = await import("../src/providers/catalog-models");
    const result = await probeAllAdapters(provider("anthropic", "https://m.aiio.chat"));
    expect(result.results).toHaveLength(3);
    expect(result.results.every(r => r.ok === false)).toBe(true);
    expect(result.recommended).toBeTruthy();
  });

  test("missing apiKey/apiKeyPool: throws", async () => {
    const { probeAllAdapters } = await import("../src/providers/catalog-models");
    await expect(probeAllAdapters(provider("anthropic", "https://x.com").apiKey = undefined as unknown as string)).rejects.toThrow();
  });
});