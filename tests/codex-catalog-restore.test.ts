import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function backupPathForTestCatalog(codexHome: string, opencodexHome: string, catalogName: string): string {
  const catalogPath = join(realpathSync.native(codexHome), catalogName);
  const normalized = process.platform === "win32" ? resolve(catalogPath).toLowerCase() : resolve(catalogPath);
  const backupId = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(opencodexHome, `catalog-backup-${backupId}.json`);
}

function runScript(codexHome: string, opencodexHome: string, script: string): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("Codex catalog restore", () => {
  // opencodex does not own the Codex home, so it never writes the Codex catalog - not to
  // restore it, not to sync it. Every test below asserts the SAME thing from a different
  // angle: the file on disk comes out byte-for-byte unchanged, whatever we were asked to do.
  let codexHome: string;
  let opencodexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ocx-catalog-home-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-catalog-ocx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) rmSync(codexHome, { recursive: true, force: true });
    if (existsSync(opencodexHome)) rmSync(opencodexHome, { recursive: true, force: true });
  });

  test("does not write an empty catalog when every entry is proxy-routed", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const original = JSON.stringify({
      models: [
        { slug: "m.aiio.chat/MiniMax-M3.1-Flash-Preview" },
        { slug: "nengpa.com/MiniMax-M3.1-Flash-Preview" },
      ],
    }, null, 2) + "\n";
    writeFileSync(catalogPath, original, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: true });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    // Byte-for-byte unchanged: Codex must never see a zero-model catalog.
    expect(readFileSync(catalogPath, "utf8")).toBe(original);
  });

  test("does not restore an empty pristine backup over the live catalog", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, opencodexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({ models: [] }, null, 2) + "\n", "utf8");
    const original = JSON.stringify({
      models: [
        { slug: "gpt-5.5" },
        { slug: "m.aiio.chat/MiniMax-M3.1-Flash-Preview" },
      ],
    }, null, 2) + "\n";
    writeFileSync(catalogPath, original, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: true });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    // Nothing is written at all: the live catalog keeps both of its entries.
    const slugs = JSON.parse(readFileSync(catalogPath, "utf8")).models.map((m: { slug: string }) => m.slug);
    expect(slugs).toEqual(["gpt-5.5", "m.aiio.chat/MiniMax-M3.1-Flash-Preview"]);
  });

  test("pass-through mode never writes to a foreign (relay) catalog", () => {
    const catalogPath = join(codexHome, "model-catalogs", "relay-test.json");
    mkdirSync(join(codexHome, "model-catalogs"), { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "model-catalogs/relay-test.json"\n', "utf8");
    const original = JSON.stringify({
      models: [
        { slug: "gpt-5.5" },
        { slug: "m.aiio.chat/MiniMax-M3.1-Flash-Preview" },
      ],
    }, null, 2) + "\n";
    writeFileSync(catalogPath, original, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: false });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    expect(readFileSync(catalogPath, "utf8")).toBe(original);
  });

  test("models cache invalidation keeps a non-empty cache when the catalog is empty", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const cachePath = join(codexHome, "models_cache.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({ models: [] }, null, 2) + "\n", "utf8");
    const existing = JSON.stringify({
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [{ slug: "gpt-5.5" }],
    }, null, 2) + "\n";
    writeFileSync(cachePath, existing, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { invalidateCodexModelsCache } = require("./src/codex/catalog");
      invalidateCodexModelsCache({ enableCodexLauncherMode: true });
      console.log("ok");
    `);

    expect(r.status).toBe(0);
    expect(readFileSync(cachePath, "utf8")).toBe(existing);
  });

  test("drops routed entries without overwriting user-added native entries", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5" },
        { slug: "opencode-go/deepseek-v4-pro" },
        { slug: "user-native" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: true });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    const slugs = JSON.parse(readFileSync(catalogPath, "utf8")).models.map((m: { slug: string }) => m.slug);
    expect(slugs).toEqual(["gpt-5.5", "opencode-go/deepseek-v4-pro", "user-native"]);
  });

  test("uses pristine backup while preserving native entries added after sync", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, opencodexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50 },
        { slug: "codex-mini", priority: 60 },
      ],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 0, supports_websockets: true },
        { slug: "codex-mini", priority: 60, supports_websockets: true },
        { slug: "umans/umans-kimi-k2.7" },
        { slug: "user-native", priority: 10 },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: true });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored).toEqual([
      { slug: "gpt-5.5", priority: 0, supports_websockets: true },
      { slug: "codex-mini", priority: 60, supports_websockets: true },
      { slug: "umans/umans-kimi-k2.7" },
      { slug: "user-native", priority: 10 },
    ]);
  });

  test("does not apply generic legacy backup to a custom catalog path", () => {
    const catalogPath = join(codexHome, "custom-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "custom-catalog.json"\n', "utf8");
    writeFileSync(join(opencodexHome, "catalog-backup.json"), JSON.stringify({
      models: [{ slug: "wrong-legacy", priority: 1 }],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50 },
        { slug: "umans/umans-kimi-k2.7" },
        { slug: "user-native", priority: 10 },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, opencodexHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog({ enableCodexLauncherMode: true });
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 0, kept: 0 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored.map(m => m.slug)).toEqual(["gpt-5.5", "umans/umans-kimi-k2.7", "user-native"]);
  });

  test("sync applies native-only subagent priority selections", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const original = JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50, base_instructions: "native", visibility: "list" },
        { slug: "gpt-5.4", priority: 0, base_instructions: "native", visibility: "list" },
      ],
    }, null, 2) + "\n";
    writeFileSync(catalogPath, original, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      (async () => {
        const result = await syncCatalogModels({
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          enableCodexLauncherMode: true,
          subagentModels: ["gpt-5.5"],
        });
        console.log(JSON.stringify(result));
      })();
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 0 });
    // The catalog belongs to whoever owns the Codex home: we do not reorder it.
    expect(readFileSync(catalogPath, "utf8")).toBe(original);
  });

  test("sync advertises documented Codex-native additions omitted by the bundled catalog", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const original = JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          priority: 0,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 272_000,
        },
        {
          slug: "gpt-5.4",
          priority: 2,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 1_000_000,
        },
      ],
    }, null, 2) + "\n";
    writeFileSync(catalogPath, original, "utf8");

    const r = runScript(codexHome, opencodexHome, `
      const { syncCatalogModels } = require("./src/codex/catalog");
      (async () => {
        const result = await syncCatalogModels({
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          enableCodexLauncherMode: true,
          subagentModels: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.6-sol"],
        });
        console.log(JSON.stringify(result));
      })();
    `);

    expect(r.status).toBe(0);
    // We do not add native entries to someone else's catalog either.
    expect(readFileSync(catalogPath, "utf8")).toBe(original);
  });
});
