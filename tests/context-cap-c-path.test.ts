
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Capture & restore `globalThis.fetch` around tests that mock it. Without this, the test
// process keeps the stub installed for every later test in the same `bun test` invocation,
// breaking vision-sidecar / Cursor-live-stdio / Codex passthrough tests that need real HTTP.
const originalFetch = globalThis.fetch;

import {
  DEFAULT_CONTEXT_CAP_KEY,
  DEFAULT_PROVIDER_CONTEXT_CAP,
  contextCapValueRecord,
  globalContextCapValue,
  modelContextOverrides,
  providerCapValue,
  providerContextCap,
  providerContextCaps,
  resolveEffectiveContextCap,
  setAllProviderContextCaps,
  setGlobalContextCapValue,
  setModelContextOverride,
  setProviderCapValue,
  setProviderContextCap,
} from "../src/providers/context-cap";
import { loadConfig, saveConfig, readConfigDiagnostics } from "../src/config";
import { gatherRoutedModels } from "../src/codex/catalog";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

interface Sandbox {
  dir: string;
  cleanup: () => void;
}
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cpath-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

beforeEach(() => {
  delete process.env.OPENCODEX_HOME;
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  delete process.env.CODEX_HOME;
  // Always restore fetch to whatever was installed when this file was first imported. The
  // catalog test (T7) sets a stub and would otherwise persist into every later suite.
  globalThis.fetch = originalFetch;
});

describe("Context cap C-path migration", () => {
  test("T1: legacy number providerContextCaps is promoted to boolean + per-provider number", () => {
    const sb = makeSandbox();
    try {
      process.env.OPENCODEX_HOME = sb.dir;
      writeFileSync(join(sb.dir, "config.json"), JSON.stringify({
        port: 10100,
        providers: {
          anthropic: { adapter: "openai-chat", baseUrl: "https://anthropic.test/v1", apiKey: "sk-1" },
          minimax: { adapter: "openai-chat", baseUrl: "https://minimax.test/v1", apiKey: "sk-2" },
        },
        defaultProvider: "anthropic",
        providerContextCaps: { anthropic: 200000, minimax: 500000 },
      }), "utf8");
      const cfg = loadConfig();
      expect(cfg.providerContextCaps).toEqual({ anthropic: true, minimax: true });
      expect(cfg.contextCapValue).toEqual({ anthropic: 200000, minimax: 500000 });
    } finally { sb.cleanup(); }
  });

  test("T2: single-number legacy contextCapValue is normalized to {__default: n}", () => {
    const sb = makeSandbox();
    try {
      process.env.OPENCODEX_HOME = sb.dir;
      writeFileSync(join(sb.dir, "config.json"), JSON.stringify({
        port: 10100,
        providers: { openai: { adapter: "openai-chat", baseUrl: "https://openai.test/v1" } },
        defaultProvider: "openai",
        contextCapValue: 128000,
      }), "utf8");
      const cfg = loadConfig();
      expect(cfg.contextCapValue).toEqual({ [DEFAULT_CONTEXT_CAP_KEY]: 128000 });
      expect(globalContextCapValue(cfg)).toBe(128000);
    } finally { sb.cleanup(); }
  });

  test("T3: half-new-half-old mix keeps per-provider numbers and respects global default", () => {
    const sb = makeSandbox();
    try {
      process.env.OPENCODEX_HOME = sb.dir;
      writeFileSync(join(sb.dir, "config.json"), JSON.stringify({
        port: 10100,
        providers: {
          anthropic: { adapter: "openai-chat", baseUrl: "https://anthropic.test/v1" },
          openai: { adapter: "openai-chat", baseUrl: "https://openai.test/v1" },
        },
        defaultProvider: "anthropic",
        providerContextCaps: { anthropic: 200000 }, // legacy
        contextCapValue: 128000, // also legacy single number
      }), "utf8");
      const cfg = loadConfig();
      // anthropic is promoted to true and its per-provider number preserved; openai inherits the
      // __default global value of 128000 (the only value any openai cap would ever need).
      expect(cfg.providerContextCaps).toEqual({ anthropic: true });
      expect(cfg.contextCapValue).toEqual({ anthropic: 200000, [DEFAULT_CONTEXT_CAP_KEY]: 128000 });
      expect(globalContextCapValue(cfg)).toBe(128000);
      expect(providerCapValue(cfg, "anthropic")).toBe(200000);
    } finally { sb.cleanup(); }
  });

  test("T4: resolveEffectiveContextCap priority chain — override > provider > catalog", () => {
    const cfg = {
      providerContextCaps: { anthropic: true },
      contextCapValue: { anthropic: 200000, [DEFAULT_CONTEXT_CAP_KEY]: 100000 },
      modelContextOverrides: { "anthropic/claude-opus-4": 500000 },
    };
    const override = resolveEffectiveContextCap("claude-opus-4", "anthropic", 1_000_000, cfg);
    expect(override).toMatchObject({ effective: 500000, native: 1_000_000, source: "override_value", capped: true, cap: 500000 });

    const provider = resolveEffectiveContextCap("claude-sonnet-4", "anthropic", 1_000_000, cfg);
    expect(provider).toMatchObject({ effective: 200000, native: 1_000_000, source: "provider", capped: true, cap: 200000 });

    const catalog = resolveEffectiveContextCap("claude-sonnet-4", "openai", 1_000_000, cfg);
    expect(catalog).toMatchObject({ effective: 1_000_000, native: 1_000_000, source: "none", capped: false, cap: undefined });
  });

  test("T5: model override `false` explicitly exempts the model from any cap", () => {
    const cfg = {
      providerContextCaps: { anthropic: true },
      contextCapValue: { [DEFAULT_CONTEXT_CAP_KEY]: 50000 },
      modelContextOverrides: { "anthropic/claude-opus-4": false as const },
    };
    const r = resolveEffectiveContextCap("claude-opus-4", "anthropic", 1_000_000, cfg);
    expect(r).toMatchObject({ effective: 1_000_000, native: 1_000_000, source: "override_exempt", capped: false, cap: undefined });
  });

  test("T6: every cap branch is Math.min-clamped against the catalog window", () => {
    const cfg = {
      providerContextCaps: { p: true },
      contextCapValue: { p: 100_000 }, // provider cap is 100k, smaller than catalog windows
      modelContextOverrides: { "p/m1": 9_999_999 },
    };
    // Override branch: a 9.99M cap cannot exceed a 1M catalog window, so effective = 1M; the cap
    // is the smaller of the two (1M). It did not "lower" the catalog, so capped=false.
    const override = resolveEffectiveContextCap("m1", "p", 1_000_000, cfg);
    expect(override.effective).toBe(1_000_000);
    expect(override.cap).toBe(1_000_000);
    expect(override.capped).toBe(false);

    // Provider branch: 100k cap on a 500k catalog does lower, so capped=true and effective=100k.
    const provider = resolveEffectiveContextCap("m2", "p", 500_000, cfg);
    expect(provider.effective).toBe(100_000);
    expect(provider.cap).toBe(100_000);
    expect(provider.capped).toBe(true);
  });

  test("T7: gatherRoutedModels exposes native + effective + capSource in CatalogModel", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: "wide", metadata: { limits: { max_context_length: 500_000 } } },
        { id: "narrow", metadata: { limits: { max_context_length: 32_000 } } },
      ],
    }))) as typeof fetch;
    const models = await gatherRoutedModels({
      port: 10100,
      defaultProvider: "p",
      providerContextCaps: { p: true },
      contextCapValue: { p: 100_000 },
      modelContextOverrides: { "p/wide": false },
      providers: { p: { adapter: "openai-chat", baseUrl: "https://p.test/v1", apiKey: "sk" } },
    });
    const wide = models.find(m => m.id === "wide");
    const narrow = models.find(m => m.id === "narrow");
    // `p/wide` is on the exempt list: cap is bypassed, no contextCap field is set.
    expect(wide).toMatchObject({
      nativeContextWindow: 500_000,
      effectiveContextWindow: 500_000,
      contextCapped: false,
      capSource: "override_exempt",
    });
    expect(wide.contextCap).toBeUndefined();
    expect(narrow).toMatchObject({
      nativeContextWindow: 32_000,
      effectiveContextWindow: 32_000,
      contextCap: 100_000,
      contextCapped: false,
      capSource: "provider",
    });
  });

  test("T8: setModelContextOverride + modelContextOverrides getters round-trip and clear correctly", () => {
    const cfg: any = {};
    setModelContextOverride(cfg, "anthropic/claude-opus-4", 300000);
    setModelContextOverride(cfg, "anthropic/claude-haiku", false);
    expect(modelContextOverrides(cfg)).toEqual({ "anthropic/claude-opus-4": 300000, "anthropic/claude-haiku": false });
    setModelContextOverride(cfg, "anthropic/claude-opus-4", null);
    expect(modelContextOverrides(cfg)).toEqual({ "anthropic/claude-haiku": false });
    setModelContextOverride(cfg, "anthropic/claude-haiku", null);
    expect(modelContextOverrides(cfg)).toEqual({});
    expect(cfg.modelContextOverrides).toBeUndefined();
  });

  test("T9: setProviderCapValue and setGlobalContextCapValue respect the per-provider record form", () => {
    const cfg: any = {};
    setGlobalContextCapValue(cfg, 100_000);
    expect(contextCapValueRecord(cfg.contextCapValue)).toEqual({ [DEFAULT_CONTEXT_CAP_KEY]: 100_000 });
    setProviderCapValue(cfg, "anthropic", 200_000);
    expect(contextCapValueRecord(cfg.contextCapValue)).toEqual({ [DEFAULT_CONTEXT_CAP_KEY]: 100_000, anthropic: 200_000 });
    expect(providerCapValue(cfg, "anthropic")).toBe(200_000);
    expect(providerCapValue(cfg, "openai")).toBe(100_000);
    setProviderCapValue(cfg, "anthropic", null);
    expect(providerCapValue(cfg, "anthropic")).toBe(100_000);
  });

  test("T10: providerContextCaps boolean + setProviderContextCap toggles in-memory consistently", () => {
    const cfg: any = { contextCapValue: { [DEFAULT_CONTEXT_CAP_KEY]: 100_000 } };
    setProviderContextCap(cfg, "anthropic", true);
    expect(providerContextCaps(cfg)).toEqual({ anthropic: true });
    expect(providerContextCap(cfg, "anthropic")).toBe(100_000);
    setAllProviderContextCaps(cfg, ["anthropic", "openai"], true);
    expect(providerContextCaps(cfg)).toEqual({ anthropic: true, openai: true });
    setAllProviderContextCaps(cfg, ["anthropic", "openai"], false);
    expect(providerContextCaps(cfg)).toEqual({});
    expect(cfg.providerContextCaps).toBeUndefined();
  });
});
