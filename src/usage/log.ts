import { chmodSync, existsSync, mkdirSync, readFileSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { usageDisplayTotalTokens } from "./totals";
import type { OcxUsage } from "../types";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  resolvedModel?: string;
  status: number;
  durationMs: number;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
}

export function usageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

/**
 * The usage log never grows past this.
 *
 * The request log has been capped by file size for a while; the usage log did not,
 * so it grew without bound (22.8 MB on the dev box after a few days) and every
 * dashboard read pulled the whole file into memory and parsed it line by line.
 * Same policy as the request log: cap by SIZE, drop the OLDEST lines.
 */
export const USAGE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** After a trim we keep this fraction of the bytes, so trimming is amortized. */
const USAGE_LOG_KEEP_RATIO = 0.8;

/** The cap in bytes, overridable for small boxes and for tests. */
export function usageLogMaxBytes(): number {
  const raw = process.env["OPENCODEX_USAGE_LOG_MAX_BYTES"]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return USAGE_LOG_MAX_BYTES;
}

export function usageTotalTokens(usage: OcxUsage | undefined): number | undefined {
  return usageDisplayTotalTokens(usage);
}

function isEstimatedUsageProvider(provider: string): boolean {
  return provider === "kiro" || provider.startsWith("kiro-") || provider === "cursor";
}

export function usageForFinalLog(provider: string, usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  if (usage.estimated || isEstimatedUsageProvider(provider)) return { ...usage, estimated: true };
  return usage;
}

export function usageStatusForFinalLog(usage: OcxUsage | undefined): UsageStatus {
  if (!usage) return "unreported";
  return usage.estimated ? "estimated" : "reported";
}

function normalizeUsageValue(usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: normalizeUsageValue(entry.usage) } : {}),
    ...(typeof entry.totalTokens === "number" ? { totalTokens: entry.totalTokens } : {}),
  };
}

function ensureUsageLogDir(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(normalizeUsageEntry(entry))}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
  enforceUsageLogLimit(path);
}

/** Current size of the usage log in bytes (0 when it does not exist). */
export function usageLogBytes(): number {
  try {
    return statSync(usageLogPath()).size;
  } catch {
    return 0;
  }
}

/**
 * Keep the usage log under its cap by dropping the oldest lines.
 * Runs only when the file is over the cap, and keeps KEEP_RATIO of the bytes,
 * so trimming is amortized instead of happening on every write.
 */
function enforceUsageLogLimit(path: string, limit = usageLogMaxBytes()): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= limit) return;
  const budget = Math.floor(limit * USAGE_LOG_KEEP_RATIO);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const sizeOfLine = Buffer.byteLength(lines[i]!, "utf-8") + 1;
    if (bytes + sizeOfLine > budget) break;
    bytes += sizeOfLine;
    kept.unshift(lines[i]!);
  }
  try {
    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* leave the oversized file alone rather than losing it entirely */
  }
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") entries.push(parsed);
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
  return entries;
}
