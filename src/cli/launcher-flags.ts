/**
 * Phase 5 launcher-mode CLI flag parsing + application.
 *
 * Two input shapes are honored:
 * 1. CLI argv flags parsed by getLauncherFlagsFromArgv(argv):
 *      --launcher-mode=auto|true|false
 *      --sync-routed-models=auto|true|false
 *      --sync-native-openai-models=auto|true|false
 *      --preset=auto|launcher|proxy-only|full-pass-through
 *
 * 2. Environment variables (spawn-friendly, propagate to backgrounded bun processes):
 *      OCX_LAUNCHER_MODE        in {"true","false"}                    (unset = auto)
 *      OCX_SYNC_ROUTED_MODELS   in {"true","false"}
 *      OCX_SYNC_NATIVE_OPENAI_MODELS in {"true","false"}
 *      OCX_PRESET               in {"","launcher","proxy-only","full-pass-through"}
 *
 * When BOTH are set, CLI argv wins (more explicit). Environment vars exist so ocx-start.py
 * (Python) and other launchers can spawn `bun run src/cli/index.ts start` with the right
 * mode without depending on argv quoting rules.
 *
 * "auto" / unset means: leave the config field as-is (whatever is in ~/.opencodex/config.json
 * or whatever the default behavior is). The flag is therefore opt-out, never opt-in by surprise.
 */
import type { OcxConfig } from "../types";

export type LauncherFlagTriBool = "auto" | true | false;
export type PresetName = "launcher" | "proxy-only" | "full-pass-through" | "auto";

export interface LauncherFlags {
  launcherMode: LauncherFlagTriBool;
  syncRoutedModels: LauncherFlagTriBool;
  syncNativeOpenaiModels: LauncherFlagTriBool;
  preset: PresetName;
}

const TRI_TRUE = new Set(["true", "1", "yes", "on"]);
const TRI_FALSE = new Set(["false", "0", "no", "off"]);

function parseTriBool(raw: string | undefined, defaultValue: LauncherFlagTriBool): LauncherFlagTriBool {
  if (raw === undefined) return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === "auto") return "auto";
  if (TRI_TRUE.has(lower)) return true;
  if (TRI_FALSE.has(lower)) return false;
  return defaultValue;
}

function parsePreset(raw: string | undefined, defaultValue: PresetName): PresetName {
  if (raw === undefined) return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === "auto") return "auto";
  if (lower === "launcher" || lower === "proxy-only" || lower === "full-pass-through") return lower;
  return defaultValue;
}

/**
 * Parse a CLI argv token into { key, value }. Accepts both --key=value and --key value shapes.
 * Returns null when the token is not a launcher flag.
 */
function extractFlag(argv: readonly string[], i: number): { key: string; value: string; consumedNext: boolean } | null {
  const tok = argv[i];
  if (!tok || !tok.startsWith("--")) return null;
  const eq = tok.indexOf("=");
  if (eq >= 0) {
    return { key: tok.slice(2, eq), value: tok.slice(eq + 1), consumedNext: false };
  }
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    return { key: tok.slice(2), value: next, consumedNext: true };
  }
  return { key: tok.slice(2), value: "true", consumedNext: false };
}

const FLAG_KEYS = new Set([
  "launcher-mode",
  "sync-routed-models",
  "sync-native-openai-models",
  "preset",
]);

export function getLauncherFlagsFromArgv(argv: readonly string[]): LauncherFlags {
  const flags: LauncherFlags = {
    launcherMode: "auto",
    syncRoutedModels: "auto",
    syncNativeOpenaiModels: "auto",
    preset: "auto",
  };
  for (let i = 0; i < argv.length; i++) {
    const f = extractFlag(argv, i);
    if (!f || !FLAG_KEYS.has(f.key)) continue;
    if (f.key === "launcher-mode") flags.launcherMode = parseTriBool(f.value, "auto");
    else if (f.key === "sync-routed-models") flags.syncRoutedModels = parseTriBool(f.value, "auto");
    else if (f.key === "sync-native-openai-models") flags.syncNativeOpenaiModels = parseTriBool(f.value, "auto");
    else if (f.key === "preset") flags.preset = parsePreset(f.value, "auto");
    if (f.consumedNext) i++;
  }
  return flags;
}

export function getLauncherFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): LauncherFlags {
  return {
    launcherMode: parseTriBool(env.OCX_LAUNCHER_MODE, "auto"),
    syncRoutedModels: parseTriBool(env.OCX_SYNC_ROUTED_MODELS, "auto"),
    syncNativeOpenaiModels: parseTriBool(env.OCX_SYNC_NATIVE_OPENAI_MODELS, "auto"),
    preset: parsePreset(env.OCX_PRESET, "auto"),
  };
}

/** CLI wins over env when both are explicit; "auto" means leave alone. */
export function mergeLauncherFlags(cli: LauncherFlags, env: LauncherFlags): LauncherFlags {
  return {
    launcherMode: cli.launcherMode !== "auto" ? cli.launcherMode : env.launcherMode,
    syncRoutedModels: cli.syncRoutedModels !== "auto" ? cli.syncRoutedModels : env.syncRoutedModels,
    syncNativeOpenaiModels: cli.syncNativeOpenaiModels !== "auto" ? cli.syncNativeOpenaiModels : env.syncNativeOpenaiModels,
    preset: cli.preset !== "auto" ? cli.preset : env.preset,
  };
}

/**
 * Resolve flags into a concrete effective config overlay. Returns an object holding only the
 * three launcher-related fields + the chosen preset; callers should spread it onto the live
 * config object. "auto" / unset means we copy whatever is already in config (no override).
 */
export interface LauncherModeOverlay {
  enableCodexLauncherMode?: boolean;
  syncRoutedModels?: boolean;
  syncNativeOpenaiModels?: boolean;
  preset?: OcxConfig["preset"];
}

export function resolveLauncherFlags(flags: LauncherFlags, config: OcxConfig): LauncherModeOverlay {
  const overlay: LauncherModeOverlay = {};
  const preset = flags.preset !== "auto" ? flags.preset : undefined;

  // Step 1: preset sets all three if explicit. CLI/env preset wins over individual bools.
  if (preset) {
    overlay.preset = preset;
    if (preset === "launcher") {
      overlay.enableCodexLauncherMode = true;
      overlay.syncRoutedModels = true;
      overlay.syncNativeOpenaiModels = true;
    } else if (preset === "proxy-only") {
      overlay.enableCodexLauncherMode = false;
      overlay.syncRoutedModels = false;
      overlay.syncNativeOpenaiModels = true;
    } else if (preset === "full-pass-through") {
      overlay.enableCodexLauncherMode = false;
      overlay.syncRoutedModels = false;
      overlay.syncNativeOpenaiModels = false;
    }
  }

  // Step 2: explicit per-flag tri-bools override whatever preset set (or apply if no preset).
  // Patch 2 bugfix: undefined !== "auto" is true, which would clobber preset-set values with undefined.
  // Skip when the caller did not set the field at all.
  if (flags.launcherMode !== "auto" && flags.launcherMode !== undefined) overlay.enableCodexLauncherMode = flags.launcherMode;
  if (flags.syncRoutedModels !== "auto" && flags.syncRoutedModels !== undefined) overlay.syncRoutedModels = flags.syncRoutedModels;
  if (flags.syncNativeOpenaiModels !== "auto" && flags.syncNativeOpenaiModels !== undefined) overlay.syncNativeOpenaiModels = flags.syncNativeOpenaiModels;

  // Step 3: default unset fields to config values (so we never clobber existing JSON with undefined).
  if (overlay.enableCodexLauncherMode === undefined) overlay.enableCodexLauncherMode = config.enableCodexLauncherMode;
  if (overlay.syncRoutedModels === undefined) overlay.syncRoutedModels = config.syncRoutedModels;
  if (overlay.syncNativeOpenaiModels === undefined) overlay.syncNativeOpenaiModels = config.syncNativeOpenaiModels;
  if (overlay.preset === undefined) overlay.preset = config.preset;

  return overlay;
}

/** Mutates `config` in place: applies the launcher-flag overlay. Returns config for chaining. */
export function applyLauncherFlagsToConfig(config: OcxConfig, flags: LauncherFlags): OcxConfig {
  const overlay = resolveLauncherFlags(flags, config);
  if (overlay.enableCodexLauncherMode !== undefined) config.enableCodexLauncherMode = overlay.enableCodexLauncherMode;
  if (overlay.syncRoutedModels !== undefined) config.syncRoutedModels = overlay.syncRoutedModels;
  if (overlay.syncNativeOpenaiModels !== undefined) config.syncNativeOpenaiModels = overlay.syncNativeOpenaiModels;
  if (overlay.preset !== undefined) config.preset = overlay.preset;
  return config;
}

/** Stable text representation for warning logs and `--help` output. */
export function formatLauncherFlags(flags: LauncherFlags): string {
  const parts: string[] = [];
  if (flags.preset !== "auto") parts.push(`preset=${flags.preset}`);
  if (flags.launcherMode !== "auto") parts.push(`launcher-mode=${flags.launcherMode}`);
  if (flags.syncRoutedModels !== "auto") parts.push(`sync-routed-models=${flags.syncRoutedModels}`);
  if (flags.syncNativeOpenaiModels !== "auto") parts.push(`sync-native-openai-models=${flags.syncNativeOpenaiModels}`);
  return parts.length > 0 ? parts.join(",") : "auto";
}

// --- Patch 2: Codex-write warning surface ---------------------------------------
// The launcher-mode flag, when enabled, writes ~/.codex/config.toml,
// ~/.codex/state_5.sqlite (model_provider tag), and rollout-*.jsonl files.
// Anything that triggers that MUST emit a red stderr banner so the operator
// is not silently surprised when Codex files move.

/** True iff applying this overlay will cause opencodex to write Codex files. */
export function wouldWriteCodex(overlay: LauncherModeOverlay | undefined | null): boolean {
  if (!overlay) return false;
  // enableCodexLauncherMode is the master switch; the sync flags are no-op
  // when it is off, so checking the master is enough.
  return overlay.enableCodexLauncherMode === true;
}

/** Format a red stderr banner announcing that Codex files will be modified. */
export function formatCodexWriteBanner(overlay: LauncherModeOverlay | undefined | null): string {
  if (!wouldWriteCodex(overlay)) return "";
  // ANSI red. Kept portable: most modern Windows terminals + PowerShell 7+ honor it.
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";
  const lines = [
    `${RED}[codex-write] WARNING${RESET}: launcher-mode is ON. opencodex will write to your Codex client:`,
    `  - ~/.codex/config.toml            ([model_providers.opencodex] block)`,
    `  - ~/.codex/state_5.sqlite         (model_provider tag)`,
    `  - ~/.codex/sessions/*/rollout-*.jsonl  (provider field on new turns)`,
    `${YELLOW}[codex-write] Tip${RESET}: pick preset=proxy-only or full-pass-through (or set --preset auto + --launcher-mode false) to make opencodex a pure HTTP relay.`,
  ];
  return lines.join("\n");
}

/** Convenience: print the banner if writing Codex files. Returns whether it printed.
 * Test-only `stream` kwarg lets unit tests capture without touching the real stderr. */
export function logCodexWriteBannerIfNeeded(
  overlay: LauncherModeOverlay | undefined | null,
  stream: { write: (s: string) => unknown } | NodeJS.WriteStream = process.stderr,
): boolean {
  const banner = formatCodexWriteBanner(overlay);
  if (!banner) return false;
  stream.write(banner + "\n");
  return true;
}
