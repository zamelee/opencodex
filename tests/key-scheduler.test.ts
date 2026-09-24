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
  pickBestKeyId,
  pickNextKey,
  recordRoutedCall,
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
  home = mkdtempSync(join(tmpdir(), "ocx-keysched-"));
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

describe("pickNextKey", () => {
  const none = () => false;

  test("excludes candidates saturated on the 5h gate", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }), // active, over
      quotaKey("k2", { fiveHourUsed: 2400, fiveHourLimit: 2500 }), // also over (0.96 > 0.85)
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500 }),  // headroom
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBe("k3");
  });

  test("returns null when every alternative is gated out", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBeNull();
  });

  test("excludes weekly-exhausted and expired keys", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, weeklyUsed: 21250, weeklyLimit: 21250 }), // weekly dead
      quotaKey("k3", { fiveHourUsed: 0, fiveHourLimit: 2500, expiresAt: NOW - 86_400_000 }),            // expired yesterday
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBeNull();
  });

  test("excludes keys in 429 cooldown", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500 }),
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, () => true)).toBeNull();
  });

  test("expiry urgency prefers the sooner-dying key", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      // k2: expires in 5 days, 15000 remaining weekly → urgency 3000/day
      quotaKey("k2", { fiveHourUsed: 500, fiveHourLimit: 2500, weeklyUsed: 6250, weeklyLimit: 21250, expiresAt: NOW + 5 * 86_400_000 }),
      // k3: expires in 30 days, 15000 remaining weekly → urgency 500/day
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500, weeklyUsed: 6250, weeklyLimit: 21250, expiresAt: NOW + 30 * 86_400_000 }),
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBe("k2");
  });

  test("ties on urgency fall back to 5h headroom", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2000, fiveHourLimit: 2500 }), // no weekly data → urgency 0
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500 }),  // no weekly data → urgency 0
    ];
    expect(pickNextKey(keys, "p", "k1", 0.85, NOW, none)).toBe("k3");
  });
});

describe("pickBestKeyId", () => {
  const none = () => false;

  test("returns null when no candidates are serviceable", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 1000, fiveHourLimit: 2500, weeklyUsed: 21250, weeklyLimit: 21250 }),
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBeNull();
  });

  test("active key wins the tiebreaker when usage is identical", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2200, fiveHourLimit: 2500 }), // active, 88%
      quotaKey("k2", { fiveHourUsed: 2200, fiveHourLimit: 2500 }), // 88%, same
      quotaKey("k3", { fiveHourUsed: 2200, fiveHourLimit: 2500 }), // 88%, same
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k1");
  });

  test("picks the key with the lowest estimated usage", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2300, fiveHourLimit: 2500 }), // active, 92%
      quotaKey("k2", { fiveHourUsed: 100, fiveHourLimit: 2500 }),  // 4% — clearly best
      quotaKey("k3", { fiveHourUsed: 1500, fiveHourLimit: 2500 }), // 60%
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k2");
  });

  test("unknown estimate ranks LAST (pessimistic)", () => {
    // active at 50% + candidate at 4% + candidate with no data. The 4%-usage key is
    // strictly better by usage, so it wins. The unknown-estimate key is ranked
    // last (headroom = -Infinity), which differs from `pickNextKey`'s "benefit of
    // doubt" rule (allow as a candidate). For watchdog purposes we want unknown
    // data to NEVER block a known-good key.
    const keys = [
      quotaKey("k1", { fiveHourUsed: 1250, fiveHourLimit: 2500 }),  // active, 50%
      quotaKey("k2", { fiveHourUsed: undefined, fiveHourLimit: 2500 }), // unknown
      quotaKey("k3", { fiveHourUsed: 100, fiveHourLimit: 2500 }),   // 4%
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k3");
  });

  test("unknown estimate loses to active when active is the only other candidate", () => {
    // No known-good candidates → active wins (with active-tiebreaker) over the
    // unknown-estimate key. This is the "I have bad info on the other key but
    // I'm still serving, so don't rotate to a black box" case.
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2300, fiveHourLimit: 2500 }),  // active, 92%
      quotaKey("k2", { fiveHourUsed: undefined, fiveHourLimit: 2500 }), // unknown
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k1");
  });

  test("respects keys-in-cooldown filter", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2300, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500 }),
    ];
    // Only the candidate is in cooldown; active is not. With active ranking first
    // by usage (k1 92% > k2 0%), and k2 excluded by cooldown, active wins by default.
    expect(pickBestKeyId(keys, "p", "k1", NOW, id => id === "k2")).toBe("k1");
  });

  test("returns null when both active and candidates are in cooldown", () => {
    // Active is in cooldown → can't use it; candidates also in cooldown → no serviceable
    // key remains. This is the circuit-breaker case from maybeRotateForQuota's POV.
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2300, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500 }),
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, () => true)).toBeNull();
  });

  test("filters expired and weekly-exhausted keys", () => {
    const keys = [
      quotaKey("k1", { fiveHourUsed: 2300, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500, expiresAt: NOW - 86_400_000 }),
      quotaKey("k3", { fiveHourUsed: 0, fiveHourLimit: 2500, weeklyUsed: 21250, weeklyLimit: 21250 }),
    ];
    expect(pickBestKeyId(keys, "p", "k1", NOW, none)).toBe("k1");
  });
});

describe("maybeRotateForQuota", () => {
  function stubProbe(keys: ProviderQuotaKey[] | null) {
    _setProbeForTests(async () => keys);
  }

  test("rotates when the active key crosses the 5h threshold", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2200, fiveHourLimit: 2500, fiveHourResetAt: NOW + 3600_000 }),
      quotaKey("k2", { fiveHourUsed: 300, fiveHourLimit: 2500 }),
      quotaKey("k3", { fiveHourUsed: 900, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(true);
    // Pending mode: rotation is staged, apiKey is NOT mutated yet (commit happens on stream done
    // or next request via commitPendingKeyChange).
    expect(config.providers.p!.apiKey).toBe("key-alpha-000111222333");
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
    expect(config.providers.p!.pendingKeyChange?.key).toBe("key-beta-444555666777");
    expect(config.providers.p!.pendingKeyChange?.reason).toBe("5h-threshold");
    const state = getKeyScheduleState(config, "p");
    expect(state?.events).toHaveLength(1);
    expect(state?.events[0]).toMatchObject({ fromId: "k1", toId: "k2", reason: "5h-threshold" });
  });

  test("stays put below the threshold", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 1000, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 300, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    expect(config.providers.p!.apiKey).toBe("key-alpha-000111222333");
  });

  test("locally recorded calls push the estimate over the threshold", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2100, fiveHourLimit: 2500 }), // 0.84 — just under
      quotaKey("k2", { fiveHourUsed: 300, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    recordRoutedCall("p", "k1"); // 2101/2500 = 0.8404, still under
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    for (let i = 0; i < 30; i++) recordRoutedCall("p", "k1"); // 2131/2500 = 0.8524 → over
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(true);
    // apiKey unchanged (still staging); pendingKeyChange is set.
    expect(config.providers.p!.apiKey).toBe("key-alpha-000111222333");
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
  });

  test("probe failure degrades to no-op (429 backstop owns the retry)", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe(null);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    _setProbeForTests(async () => { throw new Error("network down"); });
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    expect(config.providers.p!.apiKey).toBe("key-alpha-000111222333");
  });

  test("respects keySchedule.enabled=false", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL, keySchedule: { enabled: false } });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
  });

  test("respects a custom threshold", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL, keySchedule: { threshold: 0.5 } });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 1500, fiveHourLimit: 2500 }), // 0.6 ≥ 0.5
      quotaKey("k2", { fiveHourUsed: 1000, fiveHourLimit: 2500 }), // 0.4 < 0.5
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(true);
    // Pending mode: apiKey is not yet mutated - staging only.
    expect(config.providers.p!.apiKey).toBe("key-alpha-000111222333");
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
    expect(config.providers.p!.pendingKeyChange?.key).toBe("key-beta-444555666777");
  });

  test("no-op for non-quota providers and small pools", async () => {
    const plain = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    plain.providers.p!.baseUrl = "https://api.anthropic.com";
    stubProbe([quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }), quotaKey("k2", { fiveHourUsed: 0, fiveHourLimit: 2500 })]);
    expect(await maybeRotateForQuota(plain, "p", NOW)).toBe(false);

    const single = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: [POOL[0]!] });
    expect(await maybeRotateForQuota(single, "p", NOW)).toBe(false);
  });

  test("watchdog vetoes when active is rank #1 even though all are over threshold", async () => {
    // All three keys at 100%, so the watchdog ranks active first by tiebreaker and
    // does NOT rotate. Pre-watchdog code would have rotated to whichever candidate
    // had marginally less usage, which is exactly the A→B→A→B ping-pong.
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k3", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(false);
    expect(config.providers.p!.pendingKeyChange).toBeUndefined();
  });

  test("watchdog rotates to least-bad when active is the worst-saturated key", async () => {
    // Active at 100%, k2 at 99.96% (least-bad by 0.04%). Watchdog picks k2.
    // Layer 2 (return cooldown) prevents the immediate bounce-back the old code
    // would have caused.
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2499, fiveHourLimit: 2500 }),
      quotaKey("k3", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(true);
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
  });

  test("return cooldown prevents the same-key ping-pong", async () => {
    // Verify Layer 2 of the ping-pong fix. Two keys; both saturated.
    //   call 1: k1 worst → rotate k1→k2, mark k1 return-cooldown.
    //   call 2: artificially flip the probe so k1 looks better; the watchdog would
    //     otherwise want to rotate back. The return-cooldown on k1 must block it.
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    stubProbe([
      quotaKey("k1", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2499, fiveHourLimit: 2500 }),
    ]);
    expect(await maybeRotateForQuota(config, "p", NOW)).toBe(true);
    expect(config.providers.p!.pendingKeyChange?.keyId).toBe("k2");
    // Confirm k1 is pinned by return-cooldown before flipping the probe.
    expect(getKeyCooldownReason("p", "k1", NOW)).toBe("return-cooldown");

    // Simulate the dispatch stream closing: commit the pending rotation. After
    // this the system is "really" on k2, not just staged.
    expect(commitPendingKeyChange(config, "p")).toBe(true);
    expect(config.providers.p!.apiKey).toBe("key-beta-444555666777");

    // Now flip the probe so k2 looks worst (simulate time passing + k2 accumulating
    // more local calls). The watchdog would want to rotate back to k1, but the
    // return-cooldown on k1 blocks it.
    clearKeyScheduleState();
    _setProbeForTests(async () => [
      quotaKey("k1", { fiveHourUsed: 2499, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 2500, fiveHourLimit: 2500 }),
    ]);
    // Advance past probe TTL so the new probe data is consumed.
    expect(await maybeRotateForQuota(config, "p", NOW + 200_000)).toBe(false);
    // The critical assertion: k1 was NOT picked. The old code would have staged
    // a k2->k1 rotation here. We verify via pendingKeyChange being unset and
    // apiKey remaining on k2.
    expect(config.providers.p!.pendingKeyChange).toBeUndefined();
    expect(config.providers.p!.apiKey).toBe("key-beta-444555666777");
  });
});

describe("getKeyScheduleState", () => {
  test("reports the ranked standby as nextUpId", async () => {
    const config = makeConfig({ apiKey: POOL[0]!.key, apiKeyPool: POOL });
    _setProbeForTests(async () => [
      quotaKey("k1", { fiveHourUsed: 2200, fiveHourLimit: 2500 }),
      quotaKey("k2", { fiveHourUsed: 100, fiveHourLimit: 2500 }),
      quotaKey("k3", { fiveHourUsed: 300, fiveHourLimit: 2500 }),
    ]);
    // Warm the probe cache via the rotate path (rotation happens; standby becomes active).
    await maybeRotateForQuota(config, "p", NOW);
    const state = getKeyScheduleState(config, "p");
    expect(state?.enabled).toBe(true);
    // Pending mode: activeId still k1 (rotation staged, not committed yet).
    expect(state?.activeId).toBe("k1");
    // Pending-mode: nextUpId is the pending target (k2), NOT the post-commit standby.
    expect(state?.nextUpId).toBe("k2");
    expect(state?.pendingKeyChange?.keyId).toBe("k2");
  });
});
import { getKeyCooldownReason } from "../src/providers/key-failover";
