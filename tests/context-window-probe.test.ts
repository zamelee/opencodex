import { afterEach, describe, expect, test } from "bun:test";
import { PROBE_SAFETY_MARGIN, probeContextWindow } from "../src/server/context-window-probe";
import { noteUpstreamPromptLimit, resetLearnedUpstreamLimits } from "../src/lib/upstream-prompt-budget";

afterEach(() => {
  resetLearnedUpstreamLimits();
});

describe("probing the real context window", () => {
  test("without a learned limit the declared value is used, discounted", () => {
    resetLearnedUpstreamLimits();
    const probe = probeContextWindow("m.aiio.chat", "MiniMax-M3.1-Flash-Preview", {
      declared: 1_000_000,
      current: 700_000,
    });
    expect(probe.source).toBe("declared");
    expect(probe.declared).toBe(1_000_000);
    expect(probe.suggestion).toBe(Math.floor(1_000_000 * PROBE_SAFETY_MARGIN));
    expect(probe.current).toBe(700_000);
  });

  test("the learned ceiling wins over the declared value", () => {
    resetLearnedUpstreamLimits();
    noteUpstreamPromptLimit("m.aiio.chat", 1_048_576);
    const probe = probeContextWindow("m.aiio.chat", "MiniMax-M3.1-Flash-Preview", {
      declared: 1_000_000,
    });
    expect(probe.source).toBe("learned");
    expect(probe.learned).toBe(1_048_576);
    expect(probe.suggestion).toBe(Math.floor(1_048_576 * PROBE_SAFETY_MARGIN));
  });

  test("no declared and no learned value -> nothing to measure", () => {
    resetLearnedUpstreamLimits();
    const probe = probeContextWindow("m.aiio.chat", "MiniMax-M3.1-Flash-Preview");
    expect(probe.source).toBe("none");
    expect(probe.suggestion).toBeUndefined();
  });
});
