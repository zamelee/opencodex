import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLauncherModeEnabled } from "../src/codex/launcher-mode";

/**
 * Regression: a hand-written config.json that omits `enableCodexLauncherMode`
 * used to be read as "launcher mode ON" (the guard was `=== false`), so opencodex
 * injected itself into a Codex home managed by someone else (CodexPlusPlus) —
 * rewriting config.toml, remapping the resume history, and writing a journal.
 *
 * The contract now: launcher mode is ON only when the field is explicitly true.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

let opencodexHome = "";
let codexHome = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-lm-opencodex-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-lm-codex-"));
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.1"\n', "utf8");
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

function writeConfig(fields: Record<string, unknown>): void {
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
    port: 10100,
    defaultProvider: "dummy",
    providers: {
      dummy: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "sk-test-dummy" },
    },
    ...fields,
  }), "utf8");
}

/** Run a script in a child process with the sandboxed env, and read back a JSON line. */
function runPhase<T>(script: string): { status: number; data: T | null } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8",
  });
  let data: T | null = null;
  try { data = result.stdout.trim() ? (JSON.parse(result.stdout) as T) : null; } catch { data = null; }
  return { status: result.status ?? 1, data };
}

const PROBE = (original: string) => `
  const { writeJournal } = await import("./src/codex/journal.ts");
  const { injectCodexConfig } = await import("./src/codex/inject.ts");
  const fs = await import("node:fs");
  const path = await import("node:path");
  writeJournal();
  const journalExists = fs.existsSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"));
  await injectCodexConfig(10100);
  const after = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf-8");
  console.log(JSON.stringify({ configTouched: after !== ${JSON.stringify(original)}, journalExists }));
`;

describe("isLauncherModeEnabled", () => {
  test("a missing field means OFF (safe default)", () => {
    expect(isLauncherModeEnabled({})).toBe(false);
    expect(isLauncherModeEnabled({ enableCodexLauncherMode: undefined })).toBe(false);
    expect(isLauncherModeEnabled(null)).toBe(false);
    expect(isLauncherModeEnabled(undefined)).toBe(false);
  });

  test("only an explicit true enables it", () => {
    expect(isLauncherModeEnabled({ enableCodexLauncherMode: true })).toBe(true);
    expect(isLauncherModeEnabled({ enableCodexLauncherMode: false })).toBe(false);
  });
});

describe("a config.json without the launcher-mode flag stays a pure relay", () => {
  test("config.toml is not touched and no journal is written", () => {
    writeConfig({}); // no enableCodexLauncherMode at all
    const original = readFileSync(join(codexHome, "config.toml"), "utf-8");
    const r = runPhase<{ configTouched: boolean; journalExists: boolean }>(PROBE(original));
    expect(r.status).toBe(0);
    expect(r.data?.configTouched).toBe(false);
    expect(r.data?.journalExists).toBe(false);
    expect(existsSync(join(codexHome, "opencodex-journal.json"))).toBe(false);
  });

  test("an explicit true still injects (launcher mode keeps working)", () => {
    writeConfig({ enableCodexLauncherMode: true });
    const original = readFileSync(join(codexHome, "config.toml"), "utf-8");
    const r = runPhase<{ configTouched: boolean; journalExists: boolean }>(PROBE(original));
    expect(r.status).toBe(0);
    expect(r.data?.configTouched).toBe(true);
    expect(r.data?.journalExists).toBe(true);
  });
});
