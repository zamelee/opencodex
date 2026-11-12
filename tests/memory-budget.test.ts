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
    expect(snapshot.rssBytes).toBeGreaterThan(0);
    expect(snapshot.responseState.entries).toBeGreaterThan(0);
    expect(snapshot.responseState.bytes).toBeGreaterThan(0);
    expect(snapshot.limitBytes).toBeGreaterThan(0);
  });

  test("explicit RSS limit wins over the machine-share default", () => {
    process.env["OPENCODEX_RSS_LIMIT_MB"] = "512";
    expect(memoryLimitBytes()).toBe(512 * 1024 * 1024);
    delete process.env["OPENCODEX_RSS_LIMIT_MB"];
    expect(memoryLimitBytes()).toBeGreaterThan(0);
  });
});
