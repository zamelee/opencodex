import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache } from "../../src/config";

export interface IsolatedCodexHome {
  path: string;
  restore(): void;
}

export function installIsolatedCodexHome(prefix = "ocx-codex-home-"): IsolatedCodexHome {
  // This helper manages CODEX_HOME (the test target). Callers that also need an isolated
  // OPENCODEX_HOME must set `process.env.OPENCODEX_HOME` BEFORE calling this helper (or use
  // their own beforeEach ordering). We do NOT delete OPENCODEX_HOME here on purpose: doing so
  // would silently overwrite the test’s own carefully-chosen temp dir.
  //
  // We DO drop the resolvedConfigDirCache here because it lets suites that don’t set
  // OPENCODEX_HOME themselves still avoid leaking the previous suite’s cached path.
  const previousCodexHome = process.env.CODEX_HOME;
  clearResolvedConfigDirCache();
  const path = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(path, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n', "utf8");
  process.env.CODEX_HOME = path;

  return {
    path,
    restore() {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      clearResolvedConfigDirCache();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
