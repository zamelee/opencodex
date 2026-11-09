import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_LEARNED_SCALE,
  MIN_LEARNED_SCALE,
  learnedTokenScale,
  noteUpstreamTokenScale,
  resetLearnedTokenScales,
  upstreamTokenScaleFactor,
} from "../src/lib/upstream-token-scale";

afterEach(() => {
  resetLearnedTokenScales();
});

describe("the upstream's own count calibrates our estimate", () => {
  test("a refusal that names both numbers teaches the factor", () => {
    // The measured case (2026-11-09, m.aiio.chat / MiniMax-M3.1-Flash): the upstream
    // counted 2,010,775 tokens for a body we estimated at 498,000.
    const learned = noteUpstreamTokenScale("m.aiio.chat", 2_010_775, 498_000);
    expect(learned?.factor).toBeCloseTo(4.0377, 3);
    expect(upstreamTokenScaleFactor("m.aiio.chat")).toBeCloseTo(4.0377, 3);
  });

  test("an estimate that is already close teaches nothing", () => {
    // 409,159 upstream vs 395,920 ours is a 3.3% gap: a factor here would be noise.
    const learned = noteUpstreamTokenScale("m.aiio.chat", 409_159, 395_920);
    expect(learned).toBeUndefined();
    expect(upstreamTokenScaleFactor("m.aiio.chat")).toBe(1);
  });

  test("the largest factor ever seen wins, so the brake errs early", () => {
    noteUpstreamTokenScale("p", 4_000_000, 1_000_000);
    expect(upstreamTokenScaleFactor("p")).toBeCloseTo(4, 3);
    // A later, milder observation must not lower the factor.
    noteUpstreamTokenScale("p", 2_000_000, 1_000_000);
    expect(upstreamTokenScaleFactor("p")).toBeCloseTo(4, 3);
  });

  test("the factor is capped so one odd refusal cannot wedge the proxy", () => {
    noteUpstreamTokenScale("p", 100_000_000, 1_000);
    expect(upstreamTokenScaleFactor("p")).toBe(MAX_LEARNED_SCALE);
  });

  test("an unusable observation teaches nothing", () => {
    expect(noteUpstreamTokenScale("p", undefined, 500_000)).toBeUndefined();
    expect(noteUpstreamTokenScale("p", 1_000_000, 0)).toBeUndefined();
    expect(noteUpstreamTokenScale("", 1_000_000, 500_000)).toBeUndefined();
    expect(upstreamTokenScaleFactor("p")).toBe(1);
  });

  test("providers are calibrated independently", () => {
    noteUpstreamTokenScale("a", 4_000_000, 1_000_000);
    expect(upstreamTokenScaleFactor("a")).toBeCloseTo(4, 3);
    expect(upstreamTokenScaleFactor("b")).toBe(1);
    expect(learnedTokenScale("b")).toBeUndefined();
  });

  test("the minimum learned factor is the threshold below which we do not bother", () => {
    // 1.4x is inside the noise band and must not be learned.
    noteUpstreamTokenScale("p", 1_400_000, 1_000_000);
    expect(upstreamTokenScaleFactor("p")).toBe(1);
    // 1.5x is the first ratio worth keeping.
    noteUpstreamTokenScale("p", 1_500_000, 1_000_000);
    expect(upstreamTokenScaleFactor("p")).toBeCloseTo(MIN_LEARNED_SCALE, 3);
  });
});
