import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setProbeForTests,
  clearKeyScheduleState,
  maybeRotateForQuota,
  pickBestKeyId,
  pickNextKey,
} from "../src/providers/key-scheduler";
import { clearKeyCooldowns, rotateKeyOn429 } from "../src/providers/key-failover";
import {
  clearKeyExpiryRegistry,
  probeMinimaxKeyQuotas,
  type ProviderQuotaKey,
} from "../src/providers/quota";
import { listProviderApiKeys, setProviderApiKeyAutoSwitch } from "../src/providers/api-keys";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * Two independent reasons a pool entry can be kept out of the automatic rotation:
 *
 *   - EXPIRED  — derived from the upstream probe (`expires_at` in the past). Never
 *     persisted: renewing the plan upstream flips it back on the next probe, so the
 *     key re-enters the rotation on its own.
 *   - autoSwitch=false — persisted USER intent. Stays out until the user opts back in.
 */

let home: string;
const NOW = Date.parse("2026-11-03T12:00:00Z");

function quotaKey(id: string, fields: Partial<ProviderQuotaKey>): ProviderQuotaKey {
  return { id, masked: "gw-****", active: false, source: "test", updatedAt: NOW, ...fields };
}

const POOL = [
  { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
  { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
  { id: "k3", key: "key-gamma-888999000111", addedAt: 3 },
];

function makeConfig(provider: Partial<OcxProviderConfig>): OcxConfig {
  return {
    port: 10199,
    defaultProvider: "p",
    providers: {
      p: { adapter: "anthropic", baseUrl: "https://m.aiio.chat/", ...provider } as OcxProviderConfig,
    },
  } as OcxConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-keyexp-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyScheduleState();
  clearKeyCooldowns();
  clearKeyExpiryRegistry();
});

afterEach(() => {
  _setProbeForTests(null);
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyScheduleState();
  clearKeyCooldowns();
  clearKeyExpiryRegistry();
});

describe("expired keys leave the automatic rotation", () => {
  const none = () => false;

  test("pickNextKey skips a key the probe reports as expired", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, expired: true }),
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500 }),
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBe("k3");
  });

  test("pickBestKeyId skips a key the probe reports as expired", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 100, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, expired: true }),
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k1");
  });

  test("a renewed key comes back on its own (the expired flag is derived, not sticky)", () => {
    const expired = [quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 })];
    expect(pickNextKey(expired, "p", "k1", 0.85, NOW, none)).toBeNull();

    // Same key, renewed upstream: the probe no longer flags it as expired.
    const renewed = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, expired: false }),
    ];
    expect(pickNextKey(renewed, "p", "k1", 0.85, NOW, none)).toBe("k2");
  });
});

describe("autoSwitch=false keeps a key out of the automatic rotation", () => {
  const none = () => false;

  test("pickNextKey skips an opted-out key", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, autoSwitch: false }),
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500 }),
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBe("k3");
  });

  test("pickBestKeyId skips an opted-out key", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 100, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, autoSwitch: false }),
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k1");
  });
});

describe("an expired active key rotates away without waiting for the 5h gate", () => {
  test("rotates with reason active-expired even though the 5h budget is wide open", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    _setProbeForTests(async () => [
      quotaKey("k1", { fiveHourUsed: 10, fiveHourLimit: 2500, expired: true }),
      quotaKey("k2", { fiveHourUsed: 20, fiveHourLimit: 2500 }),
    ]);
    const rotated = await maybeRotateForQuota(config, "p", NOW);
    expect(rotated).toBe(true);
    expect(config.providers.p!.pendingKeyChange?.reason).toBe("active-expired");
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
  });

  test("stays put when every alternative is expired (circuit breaker)", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    _setProbeForTests(async () => [
      quotaKey("k1", { fiveHourUsed: 10, fiveHourLimit: 2500, expired: true }),
      quotaKey("k2", { fiveHourUsed: 20, fiveHourLimit: 2500, expired: true }),
    ]);
    const rotated = await maybeRotateForQuota(config, "p", NOW);
    expect(rotated).toBe(false);
    expect(config.providers.p!.pendingKeyChange).toBeUndefined();
  });

  test("a healthy active key with room left does not rotate", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    _setProbeForTests(async () => [
      quotaKey("k1", { fiveHourUsed: 10, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 20, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
  });
});

describe("429 failover skips expired keys", () => {
  test("does not rotate onto a key whose plan is over", async () => {
    // Publish the expiry table the way the probe does: an upstream payload whose
    // `expires_at` is in the past.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ rolling_5h: { limit: 100, used: 1 }, expires_at: "2026-01-01T00:00:00Z" }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    try {
      const provider = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL }).providers.p!;
      await probeMinimaxKeyQuotas(provider, "p");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    const rotated = rotateKeyOn429(config, "p", null, NOW, POOL[0]!.key);
    // Every key is expired (the stub answers the same payload for all of them) → no
    // healthy candidate, so the 429 surfaces to the caller instead of pinning a dead key.
    expect(rotated).toBeNull();
  });
});

describe("429 failover skips weekly-exhausted keys", () => {
  test("does not rotate onto a key whose calendar-week budget is spent", async () => {
    // k2 is weekly-dead (21250/21250) but its PLAN is alive: rotating onto it would
    // answer the 429 with another 429, stalling the client for nothing.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const apiKey = headers["x-api-key"] ?? "";
      const weekly = apiKey === POOL[1]!.key
        ? { used: 21250, limit: 21250 }
        : { used: 10, limit: 21250 };
      return new Response(
        JSON.stringify({ rolling_5h: { limit: 2500, used: 1 }, weekly }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const provider = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL }).providers.p!;
      await probeMinimaxKeyQuotas(provider, "p");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    const rotated = rotateKeyOn429(config, "p", null, NOW, POOL[0]!.key);
    // k2 is skipped (weekly spent); k3 is the only healthy candidate.
    expect(rotated?.apiKey).toBe(POOL[2]!.key);
  });
});

describe("autoSwitch persistence", () => {
  test("opting out is stored on the pool entry and shows up in the API listing", () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL.map(e => ({ ...e })) });
    expect(setProviderApiKeyAutoSwitch(config, "p", "k2", false)).toBe(true);
    expect(config.providers.p!.apiKeyPool!.find(e => e.id === "k2")!.autoSwitch).toBe(false);
    const listed = listProviderApiKeys(config, "p").keys;
    expect(listed.find(k => k.id === "k2")!.autoSwitch).toBe(false);
    expect(listed.find(k => k.id === "k1")!.autoSwitch).toBe(true);
  });

  test("opting back in clears the flag (back to the default)", () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL.map(e => ({ ...e })) });
    setProviderApiKeyAutoSwitch(config, "p", "k2", false);
    setProviderApiKeyAutoSwitch(config, "p", "k2", true);
    expect(config.providers.p!.apiKeyPool!.find(e => e.id === "k2")!.autoSwitch).toBeUndefined();
    expect(listProviderApiKeys(config, "p").keys.find(k => k.id === "k2")!.autoSwitch).toBe(true);
  });

  test("an unknown key id is rejected", () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL.map(e => ({ ...e })) });
    expect(setProviderApiKeyAutoSwitch(config, "p", "nope", false)).toBe(false);
  });
});
