import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setProbeForTests,
  clearKeyScheduleState,
  commitPendingKeyChange,
  getKeyScheduleState,
  maybeRotateForQuota,
} from "../src/providers/key-scheduler";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import type { ProviderQuotaKey } from "../src/providers/quota";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let home: string;
const NOW = Date.parse("2026-09-19T12:00:00Z");

function quotaKey(id: string, fields: Partial<ProviderQuotaKey>): ProviderQuotaKey {
  return {
    id,
    masked: "gw-****",
    active: false,
    source: "test",
    updatedAt: NOW,
    ...fields,
  };
}

function makeConfig(provider: Partial<OcxProviderConfig>): OcxConfig {
  return {
    port: 10199,
    defaultProvider: "p",
    providers: {
      p: {
        adapter: "anthropic",
        baseUrl: "https://m.aiio.chat/",
        apiKey: "key-alpha-000111222333",
        ...provider,
      } as OcxProviderConfig,
    },
  } as OcxConfig;
}

const POOL = [
  { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
  { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
  { id: "k3", key: "key-gamma-888999000111", addedAt: 3 },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-pkc-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyScheduleState();
  clearKeyCooldowns();
});

afterEach(() => {
  _setProbeForTests(null);
  delete process.env.OPENCODEX_HOME;
  rmSync(home, { recursive: true, force: true });
  clearKeyScheduleState();
  clearKeyCooldowns();
});

describe("Pending Key Change (Location A — 5h threshold)", () => {
  test("maybeRotateForQuota stages pendingKeyChange, does NOT mutate apiKey", async () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    const keys: ProviderQuotaKey[] = [
      quotaKey("k1", { active: true, fiveHourUsed: 90, fiveHourLimit: 100, fiveHourPercent: 90 }),
      quotaKey("k2", { fiveHourUsed: 10, fiveHourLimit: 100, fiveHourPercent: 10 }),
    ];
    _setProbeForTests(async () => keys);
    const rotated = await maybeRotateForQuota(cfg, "p", NOW);
    expect(rotated).toBe(true);
    expect(cfg.providers.p!.apiKey).toBe("key-alpha-000111222333"); // unchanged
    expect(cfg.providers.p!.pendingKeyChange?.keyId).toBe("k2");
    expect(cfg.providers.p!.pendingKeyChange?.key).toBe("key-beta-444555666777");
    expect(cfg.providers.p!.pendingKeyChange?.reason).toBe("5h-threshold");
    const poolActive = cfg.providers.p!.apiKeyPool?.find(e => e.id === "k2");
    expect(poolActive?.active).toBe(true);
  });

  test("stays put below the 5h threshold, no pendingKeyChange staged", async () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    const keys: ProviderQuotaKey[] = [
      quotaKey("k1", { active: true, fiveHourUsed: 50, fiveHourLimit: 100, fiveHourPercent: 50 }),
      quotaKey("k2", { fiveHourUsed: 10, fiveHourLimit: 100, fiveHourPercent: 10 }),
    ];
    _setProbeForTests(async () => keys);
    const rotated = await maybeRotateForQuota(cfg, "p", NOW);
    expect(rotated).toBe(false);
    expect(cfg.providers.p!.apiKey).toBe("key-alpha-000111222333");
    expect(cfg.providers.p!.pendingKeyChange).toBeUndefined();
  });
});

describe("commitPendingKeyChange (Location D/E)", () => {
  test("applies pendingKeyChange: mutates apiKey, updates active flag, persists config, clears pending", async () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    cfg.providers.p!.pendingKeyChange = {
      keyId: "k2",
      key: "key-beta-444555666777",
      ts: NOW,
      reason: "5h-threshold",
    };
    const ok = commitPendingKeyChange(cfg, "p");
    expect(ok).toBe(true);
    expect(cfg.providers.p!.apiKey).toBe("key-beta-444555666777");
    expect(cfg.providers.p!.pendingKeyChange).toBeUndefined();
    const k1 = cfg.providers.p!.apiKeyPool?.find(e => e.id === "k1");
    const k2 = cfg.providers.p!.apiKeyPool?.find(e => e.id === "k2");
    expect(k1?.active).toBeFalsy();
    expect(k2?.active).toBe(true);
  });

  test("idempotent no-op when pendingKeyChange is unset", async () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    const beforeApiKey = cfg.providers.p!.apiKey;
    const ok = commitPendingKeyChange(cfg, "p");
    expect(ok).toBe(false);
    expect(cfg.providers.p!.apiKey).toBe(beforeApiKey);
  });

  test("returns false on unknown provider", async () => {
    const cfg = makeConfig({});
    expect(commitPendingKeyChange(cfg, "nonexistent")).toBe(false);
  });

  test("Location E flow: stale pendingKeyChange gets force-committed on next request", async () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    cfg.providers.p!.apiKey = "key-alpha-000111222333";
    cfg.providers.p!.pendingKeyChange = {
      keyId: "k3",
      key: "key-gamma-888999000111",
      ts: NOW - 1000,
      reason: "5h-threshold",
    };
    const ok = commitPendingKeyChange(cfg, "p");
    expect(ok).toBe(true);
    expect(cfg.providers.p!.apiKey).toBe("key-gamma-888999000111");
    expect(cfg.providers.p!.pendingKeyChange).toBeUndefined();
    const k3 = cfg.providers.p!.apiKeyPool?.find(e => e.id === "k3");
    expect(k3?.active).toBe(true);
  });
});

describe("getKeyScheduleState exposes pendingKeyChange to GUI", () => {
  test("state.pendingKeyChange mirrors the provider field", () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    cfg.providers.p!.pendingKeyChange = {
      keyId: "k2",
      key: "key-beta-444555666777",
      ts: NOW,
      reason: "5h-threshold",
    };
    const state = getKeyScheduleState(cfg, "p");
    expect(state?.pendingKeyChange?.keyId).toBe("k2");
  });

  test("state.pendingKeyChange is undefined when no rotation staged", () => {
    const cfg = makeConfig({ apiKeyPool: POOL });
    const state = getKeyScheduleState(cfg, "p");
    expect(state?.pendingKeyChange).toBeUndefined();
  });
});
