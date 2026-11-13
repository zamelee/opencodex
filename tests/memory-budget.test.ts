import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryLimitBytes, memorySnapshot } from "../src/lib/memory-guard";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  rememberResponseState,
  replayStateLookup,
  responseStateStats,
} from "../src/responses/state";
import { appendUsageEntry, readUsageEntries, usageLogBytes } from "../src/usage/log";

describe("memory budgets", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  const priorStateMax = process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"];
  const priorUsageMax = process.env["OPENCODEX_USAGE_LOG_MAX_BYTES"];
  const priorRssLimit = process.env["OPENCODEX_RSS_LIMIT_MB"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-memory-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    const restore: Array<[string, string | undefined]> = [
      ["OPENCODEX_HOME", priorHome],
      ["OPENCODEX_RESPONSE_STATE_MAX_BYTES", priorStateMax],
      ["OPENCODEX_USAGE_LOG_MAX_BYTES", priorUsageMax],
      ["OPENCODEX_RSS_LIMIT_MB", priorRssLimit],
    ];
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("replay cache stays under its byte budget and keeps the newest turn", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "20000";
    const big = "x".repeat(4000);

    for (let i = 0; i < 20; i++) {
      rememberResponseState(
        { input: [{ role: "user", content: big + "-" + i }] },
        { id: "resp_" + i, output: [{ type: "message", content: big }], status: "completed" },
      );
    }

    const stats = responseStateStats();
    expect(stats.maxBytes).toBe(20000);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    // The oldest turns are the ones evicted; the newest must survive, or a live
    // conversation would lose its chain.
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.entries).toBeLessThan(20);

    const expanded = expandPreviousResponseInput({
      previous_response_id: "resp_19",
      input: [{ role: "user", content: "next" }],
    }) as { input: unknown[] };
    expect(Array.isArray(expanded.input)).toBe(true);
    expect((expanded.input as unknown[]).length).toBeGreaterThan(0);
  });

  test("usage log is capped by size and keeps the newest entries", () => {
    process.env["OPENCODEX_USAGE_LOG_MAX_BYTES"] = "4096";
    for (let i = 0; i < 400; i++) {
      appendUsageEntry({
        requestId: "req_" + i,
        timestamp: Date.now(),
        provider: "p",
        model: "m",
        status: 200,
        durationMs: 10,
        usageStatus: "reported",
        totalTokens: 1000,
      });
    }

    const size = usageLogBytes();
    expect(size).toBeLessThanOrEqual(4096);
    expect(size).toBeGreaterThan(0);
    const entries = readUsageEntries();
    expect(entries.length).toBeGreaterThan(0);
    // The newest entry survives the trim.
    expect(entries.at(-1)?.requestId).toBe("req_399");
  });

  test("usage log trim keeps the file readable and under the cap", () => {
    process.env["OPENCODEX_USAGE_LOG_MAX_BYTES"] = "2048";
    for (let i = 0; i < 200; i++) {
      appendUsageEntry({
        requestId: "r" + i,
        timestamp: Date.now(),
        provider: "p",
        model: "m",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
      });
    }
    const path = join(home, "usage.jsonl");
    expect(statSync(path).size).toBeLessThanOrEqual(2048);
    expect(readUsageEntries().length).toBeGreaterThan(0);
  });

  test("memory snapshot reports the growing structures", () => {
    rememberResponseState(
      { input: [{ role: "user", content: "hello" }] },
      { id: "resp_snapshot", output: [{ type: "message", content: "hi" }], status: "completed" },
    );
    const snapshot = memorySnapshot();
    expect(snapshot.privateBytes).toBeGreaterThan(0);
    expect(snapshot.workingSetBytes).toBeGreaterThan(0);
    expect(snapshot.responseState.entries).toBeGreaterThan(0);
    expect(snapshot.responseState.bytes).toBeGreaterThan(0);
    expect(snapshot.limitBytes).toBeGreaterThan(0);
    expect(snapshot.warnBytes).toBeGreaterThan(0);
    expect(snapshot.state).toBe("normal");
  });

  test("explicit RSS limit wins over the machine-share default", () => {
    process.env["OPENCODEX_RSS_LIMIT_MB"] = "512";
    expect(memoryLimitBytes()).toBe(512 * 1024 * 1024);
    delete process.env["OPENCODEX_RSS_LIMIT_MB"];
    expect(memoryLimitBytes()).toBeGreaterThan(0);
  });

  test("the newest entry does not get to exceed the budget on its own", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "20000";
    // One turn that alone is bigger than the whole budget.
    const huge = "x".repeat(40000);
    rememberResponseState(
      { input: [{ role: "user", content: huge }] },
      { id: "resp_huge", output: [{ type: "message", content: huge }], status: "completed" },
    );
    const stats = responseStateStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    // It must not be silently kept: the chain is gone, but it is GONE, and the
    // tombstone says so instead of the turn looking like it never happened.
    expect(stats.entries).toBe(0);
    expect(replayStateLookup("resp_huge").evictedByUs).toBe(true);
  });

  test("eviction drops whole sessions, not slices of them", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "30000";
    const chunk = "y".repeat(2000);
    // session A: two chained turns
    rememberResponseState(
      { input: [{ role: "user", content: chunk }] },
      { id: "a1", output: [{ type: "message", content: chunk }], status: "completed" },
    );
    rememberResponseState(
      { previous_response_id: "a1", input: [{ role: "user", content: chunk }] },
      { id: "a2", output: [{ type: "message", content: chunk }], status: "completed" },
    );
    // session B: three more turns
    for (const id of ["b1", "b2", "b3"]) {
      const prev = id === "b1" ? undefined : `b${Number(id[1]) - 1}`;
      rememberResponseState(
        { previous_response_id: prev, input: [{ role: "user", content: chunk }] },
        { id, output: [{ type: "message", content: chunk }], status: "completed" },
      );
    }
    const stats = responseStateStats();
    expect(stats.sessions).toBe(2);
    // Both turns of session A are present: a chain is never cut in half.
    expect(replayStateLookup("a1").found).toBe(true);
    expect(replayStateLookup("a2").found).toBe(true);
  });

  test("a session that does not fit is dropped whole and leaves tombstones", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "12000";
    const chunk = "z".repeat(3000);
    rememberResponseState(
      { input: [{ role: "user", content: chunk }] },
      { id: "s1", output: [{ type: "message", content: chunk }], status: "completed" },
    );
    rememberResponseState(
      { previous_response_id: "s1", input: [{ role: "user", content: chunk }] },
      { id: "s2", output: [{ type: "message", content: chunk }], status: "completed" },
    );
    rememberResponseState(
      { input: [{ role: "user", content: chunk }] },
      { id: "other", output: [{ type: "message", content: chunk }], status: "completed" },
    );
    const stats = responseStateStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    // Whatever got dropped is remembered, so a later miss can be explained.
    for (const id of ["s1", "s2", "other"]) {
      const lookup = replayStateLookup(id);
      if (!lookup.found) expect(lookup.evictedByUs).toBe(true);
    }
  });

  test("byte accounting uses UTF-8 bytes, so base64 is not counted twice", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "100000";
    const ascii = "a".repeat(50_000);
    rememberResponseState(
      { input: [{ role: "user", content: ascii }] },
      { id: "resp_ascii", output: [{ type: "message", content: "" }], status: "completed" },
    );
    const stats = responseStateStats();
    // UTF-16 counting would say ~100 kB for a 50 kB ASCII string.
    expect(stats.bytes).toBeLessThan(70_000);
  });
});
