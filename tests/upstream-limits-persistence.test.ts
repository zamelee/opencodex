import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache } from "../src/config";
import {
  learnedUpstreamPromptLimit,
  learnedGate,
  loadLearnedLimits,
  noteUpstreamPromptLimit,
  parseUpstreamPromptGate,
  parseUpstreamRejection,
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
    expect(JSON.parse(readFileSync(file, "utf-8")).gates["m.aiio.chat"].limit).toBe(1_048_576);

    // A restart: the in-memory map is gone, the sidecar is not.
    resetLearnedUpstreamLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBeUndefined();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBe(1_048_576);
  });

  test("a gate is scoped to the model, so one model's 400 does not poison its siblings", () => {
    noteUpstreamPromptLimit("m.aiio.chat", 1_048_576, { modelId: "MiniMax-M3.1-Flash" });
    noteUpstreamPromptLimit("m.aiio.chat", 262_144, { modelId: "MiniMax-M2.7" });
    saveLearnedLimits();

    resetLearnedUpstreamLimits();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "MiniMax-M3.1-Flash")).toBe(1_048_576);
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "MiniMax-M2.7")).toBe(262_144);
    // A model we never saw a failure for has no gate of its own.
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "MiniMax-M3")).toBeUndefined();
  });

  test("a provider-level gate is the fallback for a model we have no model-scoped gate for", () => {
    noteUpstreamPromptLimit("m.aiio.chat", 700_000);
    saveLearnedLimits();
    resetLearnedUpstreamLimits();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "MiniMax-M3")).toBe(700_000);
  });

  test("the smallest gate ever seen wins, but the sighting keeps updating", () => {
    noteUpstreamPromptLimit("m.aiio.chat", 1_048_576, { modelId: "M" });
    noteUpstreamPromptLimit("m.aiio.chat", 2_097_152, { modelId: "M" });
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "M")).toBe(1_048_576);
    const gate = learnedGate("m.aiio.chat", "M");
    expect(gate?.observedAt).not.toBe("");
    expect(gate?.lastSeenAt).not.toBe("");
  });

  test("a v1 sidecar (provider-level numbers) is still readable", () => {
    writeFileSync(file, JSON.stringify({ "m.aiio.chat": 1_048_576 }), "utf-8");
    resetLearnedUpstreamLimits();
    loadLearnedLimits();
    expect(learnedUpstreamPromptLimit("m.aiio.chat")).toBe(1_048_576);
    expect(learnedUpstreamPromptLimit("m.aiio.chat", "any-model")).toBe(1_048_576);
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

describe("the upstream gate is read out of the error text", () => {
  test("the MiniMax / new-api shape carries both the request size and the gate", () => {
    const parsed = parseUpstreamPromptGate(
      '{"code":11115,"msg":"prompt is too long: 1580773 tokens > 1048576 maximum"}',
    );
    expect(parsed?.limit).toBe(1_048_576);
    expect(parsed?.observedInputTokens).toBe(1_580_773);
  });

  test("the gate survives the JSON escaping the upstream's nested message carries", () => {
    // The upstream nests its message as a JSON string, so ">" arrives as the six
    // characters \u003e. A regex looking for ">" misses it, and the proxy then claims
    // "the upstream gave no ceiling" for an error that said "1048576 maximum".
    const raw = '{"error":{"type":"prompt_too_long","message":"{\\"code\\":11115,'
      + '\\"msg\\":\\"prompt is too long: 2010775 tokens \\u003e 1048576 maximum\\"}"}}';
    const parsed = parseUpstreamPromptGate(raw);
    expect(parsed?.limit).toBe(1_048_576);
    expect(parsed?.observedInputTokens).toBe(2_010_775);
    // And the refusal is recognized AS a refusal-with-a-limit, not a bare refusal.
    expect(parseUpstreamRejection(raw)).toMatchObject({
      rejected: true,
      rejectedWithoutLimit: false,
      limit: 1_048_576,
    });
  });

  test("other upstreams word it differently", () => {
    expect(parseUpstreamPromptGate("maximum context length is 262144 tokens")?.limit).toBe(262_144);
    expect(parseUpstreamPromptGate("context_length_exceeded: 131072")?.limit).toBe(131_072);
    expect(parseUpstreamPromptGate("input length and max_tokens exceed context limit: 8192")?.limit).toBe(8_192);
  });

  test("an unrelated error yields no gate", () => {
    expect(parseUpstreamPromptGate("Provider error 502: upstream unreachable")).toBeUndefined();
    expect(parseUpstreamPromptGate("")).toBeUndefined();
  });
});
