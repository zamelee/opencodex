import { describe, expect, test } from "bun:test";
import {
  gateLimitSettings,
  resolveGateLimit,
  setModelGateLimit,
} from "../src/providers/gate-limit";
import type { OcxConfig } from "../src/types";

const cfg = (modelGateLimits?: OcxConfig["modelGateLimits"]): OcxConfig =>
  ({ modelGateLimits }) as OcxConfig;

describe("the manual context gate has three states", () => {
  test("unset means AUTO: we follow whatever we know, not a number of our own", () => {
    expect(resolveGateLimit(cfg(), "m.aiio.chat", "MiniMax-M3")).toEqual({ mode: "auto" });
  });

  test("a number is the operator's own ceiling", () => {
    const resolved = resolveGateLimit(
      cfg({ "m.aiio.chat/MiniMax-M3": 250_000 }),
      "m.aiio.chat",
      "MiniMax-M3",
    );
    expect(resolved.mode).toBe("manual");
    expect(resolved.limit).toBe(250_000);
  });

  test('"upstream" means NO local gate: the upstream gets to refuse us', () => {
    const resolved = resolveGateLimit(
      cfg({ "m.aiio.chat/MiniMax-M3": "upstream" }),
      "m.aiio.chat",
      "MiniMax-M3",
    );
    expect(resolved.mode).toBe("upstream");
    expect(resolved.limit).toBeUndefined();
  });

  test("the namespaced id wins, and a bare model id also resolves", () => {
    const config = cfg({ "m.aiio.chat/MiniMax-M3": 250_000 });
    expect(resolveGateLimit(config, "m.aiio.chat", "MiniMax-M3").limit).toBe(250_000);
    expect(resolveGateLimit(config, null, "m.aiio.chat/MiniMax-M3").limit).toBe(250_000);
  });

  test("a different model of the same provider is not caught by its neighbour's gate", () => {
    const config = cfg({ "m.aiio.chat/MiniMax-M3": 250_000 });
    expect(resolveGateLimit(config, "m.aiio.chat", "MiniMax-M2.7").mode).toBe("auto");
  });
});

describe("writing the gate", () => {
  test("setting a number records it; setting null clears it", () => {
    const config = cfg();
    setModelGateLimit(config, "m.aiio.chat/MiniMax-M3", 250_000);
    expect(config.modelGateLimits).toEqual({ "m.aiio.chat/MiniMax-M3": 250_000 });
    setModelGateLimit(config, "m.aiio.chat/MiniMax-M3", null);
    expect(config.modelGateLimits).toEqual({});
  });

  test("clearing a model that was never set is a no-op", () => {
    const config = cfg();
    setModelGateLimit(config, "nope/none", null);
    expect(config.modelGateLimits).toEqual({});
  });

  test('"upstream" survives a write and a re-read', () => {
    const config = cfg();
    setModelGateLimit(config, "m.aiio.chat/MiniMax-M3", "upstream");
    expect(gateLimitSettings(config).models["m.aiio.chat/MiniMax-M3"]).toBe("upstream");
  });
});

describe("junk in the config never becomes a ceiling", () => {
  test("a non-positive, non-finite or non-number value is ignored", () => {
    const settings = gateLimitSettings(
      cfg({
        zero: 0 as unknown as number,
        negative: -5 as unknown as number,
        nan: Number.NaN as unknown as number,
        text: "250k" as unknown as number,
        good: 250_000,
      }),
    );
    expect(settings.models).toEqual({ good: 250_000 });
  });

  test("a fraction is floored to whole tokens", () => {
    const settings = gateLimitSettings(cfg({ half: 250_000.9 }));
    expect(settings.models.half).toBe(250_000);
  });

  test("a whole config that is not an object yields no settings", () => {
    expect(gateLimitSettings(cfg("nope" as unknown as OcxConfig["modelGateLimits"])).models).toEqual({});
  });
});
