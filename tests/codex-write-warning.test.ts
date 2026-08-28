import { describe, expect, test } from "bun:test";
import {
  applyLauncherFlagsToConfig,
  resolveLauncherFlags,
} from "../src/cli/launcher-flags";
import type { OcxConfig } from "../src/types";

/**
 * Patch 2: any preset / flag combo that causes opencodex to write ~/.codex/config.toml,
 * state_5.sqlite, or rollout-*.jsonl MUST emit a red stderr warning at startup.
 * Combinations that leave the Codex side untouched stay silent.
 */

function baseConfig(): OcxConfig {
  return {
    providers: {},
    preset: "full-pass-through",
    enableCodexLauncherMode: false,
    syncRoutedModels: false,
    syncNativeOpenaiModels: false,
  } as OcxConfig;
}

describe("Patch 2: codex-write warning surface", () => {
  test("resolveLauncherFlags: preset=launcher forces launcherMode on", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags({ preset: "launcher" } as any, cfg);
    expect(overlay.enableCodexLauncherMode).toBe(true);
  });

  test("resolveLauncherFlags: preset=proxy-only keeps launcherMode off", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags({ preset: "proxy-only" } as any, cfg);
    expect(overlay.enableCodexLauncherMode).toBe(false);
  });

  test("resolveLauncherFlags: preset=full-pass-through keeps launcherMode off", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags({ preset: "full-pass-through" } as any, cfg);
    expect(overlay.enableCodexLauncherMode).toBe(false);
  });

  test("resolveLauncherFlags: auto + explicit launcherMode=true triggers write", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags(
      { preset: "auto", launcherMode: true } as any,
      cfg,
    );
    expect(overlay.enableCodexLauncherMode).toBe(true);
  });

  test("resolveLauncherFlags: auto + explicit launcherMode=false stays safe", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags(
      { preset: "auto", launcherMode: false } as any,
      cfg,
    );
    expect(overlay.enableCodexLauncherMode).toBe(false);
  });

  test("applyLauncherFlagsToConfig mutates in place", () => {
    const cfg = baseConfig();
    applyLauncherFlagsToConfig(cfg, { preset: "launcher" } as any);
    expect(cfg.enableCodexLauncherMode).toBe(true);
    expect(cfg.syncRoutedModels).toBe(true);
    expect(cfg.syncNativeOpenaiModels).toBe(true);
  });

  test("applyLauncherFlagsToConfig keeps safe default for proxy-only", () => {
    const cfg = baseConfig();
    applyLauncherFlagsToConfig(cfg, { preset: "proxy-only" } as any);
    expect(cfg.enableCodexLauncherMode).toBe(false);
    expect(cfg.syncRoutedModels).toBe(false);
    // syncNativeOpenaiModels=true by design (kept under proxy-only)
    expect(cfg.syncNativeOpenaiModels).toBe(true);
  });

  test("would-write-codex predicate: preset=launcher => yes", () => {
    const cfg = baseConfig();
    applyLauncherFlagsToConfig(cfg, { preset: "launcher" } as any);
    expect(cfg.enableCodexLauncherMode).toBe(true);
  });

  test("would-write-codex predicate: preset=auto + launcherMode=false => no", () => {
    const cfg = baseConfig();
    applyLauncherFlagsToConfig(cfg, { preset: "auto", launcherMode: false } as any);
    expect(cfg.enableCodexLauncherMode).toBe(false);
  });

  test("would-write-codex predicate: explicit launcherMode=true via CLI overrides preset", () => {
    const cfg = baseConfig();
    applyLauncherFlagsToConfig(
      cfg,
      { preset: "full-pass-through", launcherMode: true } as any,
    );
    expect(cfg.enableCodexLauncherMode).toBe(true);
  });
});

import {
  formatCodexWriteBanner,
  logCodexWriteBannerIfNeeded,
  wouldWriteCodex,
} from "../src/cli/launcher-flags";

describe("Patch 2: wouldWriteCodex predicate", () => {
  test("wouldWriteCodex returns true when enableCodexLauncherMode is true", () => {
    expect(wouldWriteCodex({ enableCodexLauncherMode: true } as any)).toBe(true);
  });
  test("wouldWriteCodex returns false when enableCodexLauncherMode is false", () => {
    expect(wouldWriteCodex({ enableCodexLauncherMode: false } as any)).toBe(false);
  });
  test("wouldWriteCodex returns false when overlay is undefined or null", () => {
    expect(wouldWriteCodex(undefined)).toBe(false);
    expect(wouldWriteCodex(null)).toBe(false);
  });
  test("wouldWriteCodex returns false when overlay is empty", () => {
    expect(wouldWriteCodex({} as any)).toBe(false);
  });
});

describe("Patch 2: formatCodexWriteBanner", () => {
  test("banner contains red ANSI + Codex file paths + tip", () => {
    const b = formatCodexWriteBanner({ enableCodexLauncherMode: true } as any);
    expect(b).toContain("\x1b[31m");  // red
    expect(b).toContain("~/.codex/config.toml");
    expect(b).toContain("state_5.sqlite");
    expect(b).toContain("preset=proxy-only");
  });
  test("banner is empty string when launcher mode is off", () => {
    expect(formatCodexWriteBanner({ enableCodexLauncherMode: false } as any)).toBe("");
    expect(formatCodexWriteBanner(undefined)).toBe("");
  });
});

describe("Patch 2: logCodexWriteBannerIfNeeded writes to stderr only when writing", () => {
  test("writes when launcher mode is on", () => {
    let captured = "";
    const fakeStream = { write: (s: string) => { captured += s; return true; } };
    const wrote = logCodexWriteBannerIfNeeded({ enableCodexLauncherMode: true } as any, fakeStream as any);
    expect(wrote).toBe(true);
    expect(captured).toContain("[codex-write] WARNING");
    expect(captured).toContain("~/.codex/config.toml");
  });
  test("does not write when launcher mode is off", () => {
    let captured = "";
    const fakeStream = { write: (s: string) => { captured += s; return true; } };
    const wrote = logCodexWriteBannerIfNeeded({ enableCodexLauncherMode: false } as any, fakeStream as any);
    expect(wrote).toBe(false);
    expect(captured).toBe("");
  });
});

describe("Patch 2: full resolution -> banner pipeline", () => {
  test("preset=launcher => banner is shown", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags({ preset: "launcher" } as any, cfg);
    expect(wouldWriteCodex(overlay)).toBe(true);
    const b = formatCodexWriteBanner(overlay);
    expect(b.length).toBeGreaterThan(0);
  });
  test("preset=auto + explicit launcherMode=false => no banner", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags(
      { preset: "auto", launcherMode: false } as any,
      cfg,
    );
    expect(wouldWriteCodex(overlay)).toBe(false);
    expect(formatCodexWriteBanner(overlay)).toBe("");
  });
  test("explicit launcherMode=true overrides safe preset", () => {
    const cfg = baseConfig();
    const overlay = resolveLauncherFlags(
      { preset: "full-pass-through", launcherMode: true } as any,
      cfg,
    );
    expect(wouldWriteCodex(overlay)).toBe(true);
  });
});
