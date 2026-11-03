/**
 * Single source of truth for "may opencodex write into ~/.codex?".
 *
 * The safe default matters more than the flag itself: opencodex is a pure
 * translation relay unless the operator explicitly asks for launcher mode. A
 * hand-written config.json that simply omits `enableCodexLauncherMode` must NOT
 * be read as "enabled" — that used to happen, and it made opencodex inject
 * itself into a Codex home managed by someone else (CodexPlusPlus).
 *
 * So: launcher mode is ON only when the field is explicitly `true`.
 */
export function isLauncherModeEnabled(config: { enableCodexLauncherMode?: boolean } | null | undefined): boolean {
  return config?.enableCodexLauncherMode === true;
}
