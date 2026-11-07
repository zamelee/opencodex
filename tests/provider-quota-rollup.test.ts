import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../src/providers/quota";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const KEYS = {
  "key-exhausted": { fiveHour: { limit: 3000, used: 3000 }, weekly: { limit: 21250, used: 21250 } },
  "key-half": { fiveHour: { limit: 3000, used: 1500 }, weekly: { limit: 21250, used: 10000 } },
  "key-fresh": { fiveHour: { limit: 2500, used: 100 }, weekly: { limit: 21250, used: 100 } },
};

function usageFor(key: string): unknown {
  const k = KEYS[key as keyof typeof KEYS];
  return {
    rolling_5h: { ...k.fiveHour, window_start: 0, window_end: 0 },
    weekly: { ...k.weekly, resets_at: 0, week_start: 0 },
    plan_name: "旗舰版",
    expires_at: Math.floor(Date.now() / 1000) + 86400 * 30,
  };
}

function testConfig(): OcxConfig {
  return {
    defaultProvider: "m.aiio.chat",
    providers: {
      "m.aiio.chat": {
        adapter: "anthropic",
        baseUrl: "https://m.aiio.chat",
        apiKey: "key-exhausted",
        apiKeyPool: [
          { id: "a", key: "key-exhausted", active: true, autoSwitch: true },
          { id: "b", key: "key-half", active: false, autoSwitch: true },
          { id: "c", key: "key-fresh", active: false, autoSwitch: true },
        ],
      },
    },
  } as unknown as OcxConfig;
}

beforeEach(() => {
  clearProviderQuotaCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/usage")) {
      const headers = new Headers(init?.headers);
      const key = headers.get("x-api-key") ?? "";
      return new Response(JSON.stringify(usageFor(key)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
});

describe("provider quota rollup over a key pool", () => {
  test("the pooled percentage matches the pooled numbers and counts the usable keys", async () => {
    const reports = await fetchProviderQuotaReports(testConfig(), true);
    const report = reports.reports.find((r) => r.provider === "m.aiio.chat");
    expect(report).toBeDefined();
    const quota = report!.quota;
    // weekly: (21250 + 10000 + 100) / (3 * 21250) = 59.15%
    expect(quota.weeklyPercent).toBeCloseTo((31350 / 63750) * 100, 1);
    // 5h: (3000 + 1500 + 100) / (3000 + 3000 + 2500) = 54.12% — the percent now matches the
    // summed used/limit the UI prints (it used to be the ACTIVE key's percent: 100%).
    expect(quota.fiveHourPercent).toBeCloseTo((4600 / 8500) * 100, 1);
    // "key-exhausted" is done in both windows, "key-half" is not -> 2 of 3 usable.
    expect(quota.usableKeys).toBe(2);
    expect(quota.totalKeys).toBe(3);
  });
});
