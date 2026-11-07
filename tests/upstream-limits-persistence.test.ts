import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache } from "../src/config";
import {
  learnedUpstreamPromptLimit,
  loadLearnedLimits,
  noteUpstreamPromptLimit,
  resetLearnedUpstreamLimits,
  saveLearnedLimits,
} from "../src/lib/upstream-prompt-budget";

let home = "";
let file = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-limits-"));
  file = join(home, "upstream-limits.json");
  process.env.OPENCODEX_HOME = home;
  // config.ts caches the resolved dir; the env var above must be picked up.
  clearResolvedConfigDirCache();
});

afterEach(() => {
  resetLearnedUpstreamLimits();
});

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* scratch cleanup is best-effort */
  }
});

describe("the learned upstream ceilings survive a restart", () => {
  test("a learned ceiling is written to the sidecar and read back", () => {
    noteUpstreamPromptLimit("m.aiio.chat", 1_048_576);
    saveLearnedLimits();
    expect(JSON.parse(readFileSync(file, "utf-8"))["m.aiio.chat"]).toBe(1_048_576);

    // A restart: the in-memory map is gone, the sidecar is not.
    resetLearnedUpstreamLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBeUndefined();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBe(1_048_576);
  });

  test("a garbage sidecar does not break the proxy", () => {
    writeFileSync(file, "{not json", "utf-8");
    resetLearnedUpstreamLimits();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBeUndefined();
  });

  test("only positive numbers are restored", () => {
    writeFileSync(file, JSON.stringify({ good: 1000, bad: -5, worse: "x" }), "utf-8");
    resetLearnedUpstreamLimits();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("good")).toBe(1000);
    expect(learnedUpstreamPromptLimit("bad")).toBeUndefined();
    expect(learnedUpstreamPromptLimit("worse")).toBeUndefined();
  });
});
