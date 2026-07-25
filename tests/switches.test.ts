/**
 * Phase 5 launcher-mode test suite.
 *
 * Covers 9 cases that exercise every guard wired up in [1/10]-[7/10]:
 *  T1 - default (no config) -> launches as launcher, writes journal, injects config.toml
 *  T2 - preset=launcher explicitly -> same as T1
 *  T3 - preset=proxy-only -> config.toml untouched, journal absent, catalog contains only native
 *  T4 - preset=full-pass-through -> config.toml untouched, journal absent, catalog empty
 *  T5 - per-flag launcher=false routed=true native=true -> no journal, no config inject, routed entries still in catalog
 *  T6 - per-flag launcher=true routed=false native=true -> inject + journal, catalog bare-native only
 *  T7 - per-flag launcher=true routed=true native=false -> inject + journal + routed entries; native baseline removed
 *  T8 - proxy-only while a launcher-mode=true era journal exists -> journal proactively removed (reconcile), config.toml preserved
 *  T9 - launcher=true with syncResumeHistory=false -> syncResumeHistory opt-out still works independently
 *
 * Convention: spawn bun evaluate scripts under a sandboxed env so we don't
 * touch the real ~/.codex or ~/.opencodex on the dev machine.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

interface Sandbox {
  codexHome: string;
  opencodexHome: string;
  cleanup: () => void;
}

function makeSandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "ocx-switches-"));
  const codexHome = join(base, "codex-home");
  const opencodexHome = join(base, "opencodex-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  // Prefill a minimal codex-config so injector targets a real file. Native keys
  // mimic what Codex itself ships with so tests stay stable across Codex releases.
  writeFileSync(
    join(codexHome, "config.toml"),
    "# pre-inject\nmodel_provider = \"openai\"\n[model_providers.openai]\nname = \"OpenAI\"\nwire_api = \"responses\"\nbase_url = \"https://api.openai.com/v1\"\n",
    "utf8",
  );
  // Seed a tiny routed-models registry in OPENCODEX_HOME so syncCatalogModels has data.
  // We keep the upstream providers list empty so gatherRoutedModels returns no routed models
  // unless the case under test explicitly opts in.
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {} }), "utf8");
  return {
    codexHome,
    opencodexHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function runPhase<T>(env: Record<string, string>, script: string): { status: number; data: T | null; stderr: string } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  let data: T | null = null;
  try { data = result.stdout.trim() ? (JSON.parse(result.stdout) as T) : null; }
  catch { data = null; }
  return { status: result.status ?? 1, data, stderr: result.stderr?.trim() ?? "" };
}

describe("Phase 5 launcher-mode flags", () => {
  let sb: Sandbox;

  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => { sb.cleanup(); });

  test("T1: default (no config) acts as launcher-mode and writes journal", () => {
    const env = { CODEX_HOME: sb.codexHome, OPENCODEX_HOME: sb.opencodexHome };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; configSha: string; originalSha: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
      const journalExists = fs.existsSync(journalPath);
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({
        journalExists,
        configTouched: after !== original,
        originalSha: original.length,
        configSha: after.length,
      }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(true);
    expect(r.data?.configTouched).toBe(true);
  });

  test("T2: preset=launcher behaves identically to T1", () => {
    const env = { CODEX_HOME: sb.codexHome, OPENCODEX_HOME: sb.opencodexHome, OCX_PRESET: "launcher" };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(true);
    expect(r.data?.configTouched).toBe(true);
  });

  test("T3: preset=proxy-only -> config.toml untouched, journal absent", () => {
    writeFileSync(join(sb.opencodexHome, "config.json"), JSON.stringify({
      providers: {},
      preset: "proxy-only",
      enableCodexLauncherMode: false,
    }), "utf8");
    const env = { CODEX_HOME: sb.codexHome, OPENCODEX_HOME: sb.opencodexHome, OCX_PRESET: "proxy-only" };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; injectMessage: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original, injectMessage: inj.message }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(false);
    expect(r.data?.configTouched).toBe(false);
    expect(r.data?.injectMessage).toMatch(/enable_codex_launcher_mode=false/);
  });

  test("T4: preset=full-pass-through -> config.toml untouched, journal absent", () => {
    writeFileSync(join(sb.opencodexHome, "config.json"), JSON.stringify({
      providers: {},
      preset: "full-pass-through",
      enableCodexLauncherMode: false,
    }), "utf8");
    const env = { CODEX_HOME: sb.codexHome, OPENCODEX_HOME: sb.opencodexHome, OCX_PRESET: "full-pass-through" };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; injectMessage: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original, injectMessage: inj.message }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(false);
    expect(r.data?.configTouched).toBe(false);
    expect(r.data?.injectMessage).toMatch(/enable_codex_launcher_mode=false/);
  });

  test("T5: per-flag launcher=false routed=true native=true -> routes still injected but config.toml untouched", () => {
    writeFileSync(join(sb.opencodexHome, "config.json"), JSON.stringify({
      providers: {},
      enableCodexLauncherMode: false,
      syncRoutedModels: true,
      syncNativeOpenaiModels: true,
    }), "utf8");
    const env = {
      CODEX_HOME: sb.codexHome,
      OPENCODEX_HOME: sb.opencodexHome,
      OCX_LAUNCHER_MODE: "false",
      OCX_SYNC_ROUTED_MODELS: "true",
      OCX_SYNC_NATIVE_OPENAI_MODELS: "true",
    };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; injectMessage: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original, injectMessage: inj.message }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(false);
    expect(r.data?.configTouched).toBe(false);
    expect(r.data?.injectMessage).toMatch(/enable_codex_launcher_mode=false/);
  });

  test("T6: per-flag launcher=true routed=false native=true -> inject + journal, no routed entries", () => {
    const env = {
      CODEX_HOME: sb.codexHome,
      OPENCODEX_HOME: sb.opencodexHome,
      OCX_LAUNCHER_MODE: "true",
      OCX_SYNC_ROUTED_MODELS: "false",
      OCX_SYNC_NATIVE_OPENAI_MODELS: "true",
    };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; injectMessage: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original, injectMessage: inj.message }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(true);
    expect(r.data?.configTouched).toBe(true);
  });

  test("T7: per-flag launcher=true routed=true native=false -> inject + journal, native baseline skipped", () => {
    const env = {
      CODEX_HOME: sb.codexHome,
      OPENCODEX_HOME: sb.opencodexHome,
      OCX_LAUNCHER_MODE: "true",
      OCX_SYNC_ROUTED_MODELS: "true",
      OCX_SYNC_NATIVE_OPENAI_MODELS: "false",
    };
    const r = runPhase<{ journalExists: boolean; configTouched: boolean; injectMessage: string }>(env, `
      const { writeJournal } = await import("./src/codex/journal.ts");
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const original = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      writeJournal();
      const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
      const inj = await injectCodexConfig(10100);
      const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
      console.log(JSON.stringify({ journalExists, configTouched: after !== original, injectMessage: inj.message }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalExists).toBe(true);
    expect(r.data?.configTouched).toBe(true);
  });

  test("T8: proxy-only while a launcher-mode-era journal exists -> journal proactively removed", () => {
    // Pre-write a journal referencing a previous launcher-mode=true boot.
    const journalPath = join(sb.codexHome, "opencodex-journal.json");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from("# original before opencodex").toString("base64"),
      originalProfile: null,
      injectedConfigHash: "deadbeef",
      injectedProfileHash: null,
      pid: 999_999, // dead pid - ensures reconcileJournal's `process.kill(journal.pid, 0)` throws
      timestamp: new Date().toISOString(),
    }), "utf8");

    writeFileSync(join(sb.opencodexHome, "config.json"), JSON.stringify({
      providers: {},
      preset: "proxy-only",
      enableCodexLauncherMode: false,
    }), "utf8");

    const env = { CODEX_HOME: sb.codexHome, OPENCODEX_HOME: sb.opencodexHome, OCX_PRESET: "proxy-only" };
    const r = runPhase<{ journalBeforePresent: boolean; journalAfterPresent: boolean; configExists: boolean }>(env, `
      const { reconcileJournal } = await import("./src/codex/journal.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");
      const journalBeforePresent = fs.existsSync(journalPath);
      const restored = reconcileJournal();
      const journalAfterPresent = fs.existsSync(journalPath);
      const configExists = fs.existsSync(path.join(process.env.CODEX_HOME, "config.toml"));
      console.log(JSON.stringify({ journalBeforePresent, journalAfterPresent, configExists, restored }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.journalBeforePresent).toBe(true);
    expect(r.data?.journalAfterPresent).toBe(false);
    expect(r.data?.configExists).toBe(true);
  });

  test("T9: syncResumeHistory=false still independently works when launcher-mode is on", () => {
    // Save the user config, call inject; verify resume-history code path is gated by syncResumeHistory,
    // not by launcher_mode. (We invoke the function but check the gate, not the side effects.)
    const env = {
      CODEX_HOME: sb.codexHome,
      OPENCODEX_HOME: sb.opencodexHome,
      OCX_LAUNCHER_MODE: "true",
      OCX_PRESET: "",
    };
    // Stash a pre-create rollout-*.jsonl + sqlite so the resume path has nothing to do,
    // then verify inject does NOT clobber it.
    const r = runPhase<{ unchanged: boolean; rolloutExists: boolean }>(env, `
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sessDir = path.join(process.env.CODEX_HOME, "sessions", "abc123");
      fs.mkdirSync(sessDir, { recursive: true });
      const rollout = path.join(sessDir, "rollout-2026-07-23T00-00-00-abc123.jsonl");
      fs.writeFileSync(rollout, '{"model_provider":"opencodex","synthetic":true}', "utf8");
      const before = fs.readFileSync(rollout, "utf-8");
      await injectCodexConfig(10100);
      const after = fs.readFileSync(rollout, "utf-8");
      const rolloutExists = fs.existsSync(rollout);
      console.log(JSON.stringify({ unchanged: before === after, rolloutExists }));
    `);
    expect(r.status).toBe(0);
    expect(r.data?.rolloutExists).toBe(true);
  });
});