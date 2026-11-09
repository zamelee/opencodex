import { describe, expect, test } from "bun:test";
import {
  GATE_CIRCUIT_COMPARABLE_RATIO,
  GATE_CIRCUIT_THRESHOLD,
  GATE_CIRCUIT_WINDOW_MS,
  gateCircuitState,
  gateCircuitVerdictFor,
  gateRejectionRecord,
  isGateCircuitArmed,
  noteGateRejection,
  noteGateSuccess,
  resetGateCircuit,
} from "../src/lib/upstream-gate-circuit";

/** A refusal of a request that our own meter puts at ~1.2M tokens. */
const BIG = 1_200_000;

function refuseBig(estimatedTokens = BIG): void {
  noteGateRejection("m.aiio.chat", "MiniMax-M3", {
    limit: 1_048_576,
    estimatedTokens,
  });
}

describe("the gate circuit (the stop after the brake)", () => {
  test("a single refusal is not enough to arm the circuit", () => {
    resetGateCircuit();
    refuseBig();
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(false);
    expect(gateCircuitState("m.aiio.chat", "MiniMax-M3")?.consecutive).toBe(1);
  });

  test("a streak of comparable refusals arms it", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(true);
    expect(gateCircuitState("m.aiio.chat", "MiniMax-M3")?.consecutive).toBe(GATE_CIRCUIT_THRESHOLD);
  });

  test("the circuit is per route: another model of the same provider is untouched", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(true);
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M2.7")).toBe(false);
    expect(isGateCircuitArmed("other.provider", "MiniMax-M3")).toBe(false);
  });

  test("refusals far apart in time are not a loop", () => {
    resetGateCircuit();
    refuseBig();
    // Pretend the first refusal happened long ago: the next one starts a fresh streak.
    const state = gateCircuitState("m.aiio.chat", "MiniMax-M3");
    expect(state?.consecutive).toBe(1);
    expect(GATE_CIRCUIT_WINDOW_MS).toBeGreaterThan(0);
    refuseBig();
    refuseBig();
    // Three refusals in a row DO arm it - the window only separates old ones.
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(true);
  });

  test("a much smaller request is a different story and does not extend the streak", () => {
    resetGateCircuit();
    refuseBig();
    // The conversation compacted hard: the next request is a tenth of the size.
    noteGateRejection("m.aiio.chat", "MiniMax-M3", { estimatedTokens: BIG / 10 });
    expect(gateCircuitState("m.aiio.chat", "MiniMax-M3")?.consecutive).toBe(1);
  });

  test("a small success does NOT clear the streak of the big refusals", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(true);
    // Another conversation's tiny request succeeds: it says nothing about the big one.
    noteGateSuccess("m.aiio.chat", "MiniMax-M3", 500);
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(true);
  });

  test("a success of a comparable size clears the streak: the route takes that size", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    noteGateSuccess("m.aiio.chat", "MiniMax-M3", BIG);
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3")).toBe(false);
    expect(gateCircuitState("m.aiio.chat", "MiniMax-M3")?.consecutive).toBe(0);
  });

  test("an armed circuit refuses a request as big as the refused one", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    const verdict = gateCircuitVerdictFor("m.aiio.chat", "MiniMax-M3", BIG);
    expect(verdict.refuse).toBe(true);
    expect(verdict.consecutive).toBe(GATE_CIRCUIT_THRESHOLD);
  });

  test("an armed circuit lets a request through when compaction made it much smaller", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    const small = Math.floor(BIG * 0.2);
    const verdict = gateCircuitVerdictFor("m.aiio.chat", "MiniMax-M3", small);
    expect(verdict.refuse).toBe(false);
  });

  test("the threshold for 'as big as' is the comparable ratio", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    const baseline = gateCircuitState("m.aiio.chat", "MiniMax-M3")?.minRefusedTokens ?? 0;
    const justUnder = Math.floor(baseline * GATE_CIRCUIT_COMPARABLE_RATIO) - 1;
    expect(gateCircuitVerdictFor("m.aiio.chat", "MiniMax-M3", justUnder).refuse).toBe(false);
    expect(gateCircuitVerdictFor("m.aiio.chat", "MiniMax-M3", baseline).refuse).toBe(true);
  });

  test("the circuit cools down after its TTL", () => {
    resetGateCircuit();
    for (let i = 0; i < GATE_CIRCUIT_THRESHOLD; i++) refuseBig();
    const now = Date.now();
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3", now)).toBe(true);
    expect(isGateCircuitArmed("m.aiio.chat", "MiniMax-M3", now + 10 * 60_000)).toBe(false);
    expect(gateCircuitState("m.aiio.chat", "MiniMax-M3")?.consecutive).toBe(0);
  });

  test("a refusal without a ceiling is recorded as a fact of its own", () => {
    resetGateCircuit();
    noteGateRejection("m.aiio.chat", "MiniMax-M3", { withoutLimit: true });
    noteGateRejection("m.aiio.chat", "MiniMax-M3", { withoutLimit: true });
    const record = gateRejectionRecord("m.aiio.chat", "MiniMax-M3");
    expect(record?.confirmedCount).toBe(2);
    expect(record?.withoutLimitCount).toBe(2);
    expect(record?.limit).toBeUndefined();
    expect(record?.firstSeenAt).toBeTruthy();
    expect(record?.lastSeenAt).toBeTruthy();
  });

  test("the smallest ceiling we ever saw is the one we keep", () => {
    resetGateCircuit();
    noteGateRejection("p", "m", { limit: 2_000_000 });
    noteGateRejection("p", "m", { limit: 1_048_576 });
    noteGateRejection("p", "m", { limit: 3_000_000 });
    expect(gateRejectionRecord("p", "m")?.limit).toBe(1_048_576);
    expect(gateRejectionRecord("p", "m")?.confirmedCount).toBe(3);
  });

  test("a route we never saw has no record", () => {
    resetGateCircuit();
    expect(gateRejectionRecord("nobody", "nothing")).toBeUndefined();
    expect(gateCircuitState("nobody", "nothing")).toBeUndefined();
  });
});
