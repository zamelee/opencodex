import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  checkMemoryPressure,
  memoryLimits,
  memorySnapshot,
  resetMemoryGuardState,
} from "../src/lib/memory-guard";

describe("memory guard state machine", () => {
  const priorWarn = process.env["OPENCODEX_MEMORY_WARN_MB"];
  const priorHard = process.env["OPENCODEX_MEMORY_HARD_MB"];
  const priorLegacy = process.env["OPENCODEX_RSS_LIMIT_MB"];

  beforeEach(() => {
    resetMemoryGuardState();
  });

  afterEach(() => {
    const restore: Array<[string, string | undefined]> = [
      ["OPENCODEX_MEMORY_WARN_MB", priorWarn],
      ["OPENCODEX_MEMORY_HARD_MB", priorHard],
      ["OPENCODEX_RSS_LIMIT_MB", priorLegacy],
    ];
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetMemoryGuardState();
  });

  test("crossing the hard line is immediate, no waiting for a second sample", () => {
    process.env["OPENCODEX_MEMORY_HARD_MB"] = "1";
    process.env["OPENCODEX_MEMORY_WARN_MB"] = "1";
    const check = checkMemoryPressure();
    expect(check.state).toBe("critical");
    expect(check.changed).toBe(true);
  });

  test("a warning needs two consecutive samples", () => {
    process.env["OPENCODEX_MEMORY_WARN_MB"] = "1";
    process.env["OPENCODEX_MEMORY_HARD_MB"] = "1024";
    const first = checkMemoryPressure();
    expect(first.state).toBe("normal");
    const second = checkMemoryPressure();
    expect(second.state).toBe("warning");
    expect(second.changed).toBe(true);
  });

  test("recovery needs three good samples", () => {
    process.env["OPENCODEX_MEMORY_WARN_MB"] = "1";
    process.env["OPENCODEX_MEMORY_HARD_MB"] = "1024";
    checkMemoryPressure();
    expect(checkMemoryPressure().state).toBe("warning");

    // Now pretend the process is small again.
    process.env["OPENCODEX_MEMORY_WARN_MB"] = "1024";
    process.env["OPENCODEX_MEMORY_HARD_MB"] = "2048";
    expect(checkMemoryPressure().state).toBe("warning");
    expect(checkMemoryPressure().state).toBe("warning");
    expect(checkMemoryPressure().state).toBe("normal");
  });

  test("the legacy RSS limit env still sets the hard line", () => {
    process.env["OPENCODEX_RSS_LIMIT_MB"] = "777";
    const limits = memoryLimits();
    expect(limits.hardBytes).toBe(777 * 1024 * 1024);
    expect(limits.source).toBe("env");
  });

  test("the snapshot reports both memory views", () => {
    const snapshot = memorySnapshot();
    expect(snapshot.privateBytes).toBeGreaterThan(0);
    expect(snapshot.workingSetBytes).toBeGreaterThan(0);
    expect(snapshot.precise).toBe(true);
    expect(snapshot.ramBytes).toBeGreaterThan(0);
  });
});
