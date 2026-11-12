/**
 * Memory ceiling and diagnostics for the proxy process.
 *
 * WHY: on an 8 GB host the proxy grew to 4.94 GB RSS / 10.11 GB commit after
 * 31 hours and Bun died with SIGILL (2026-11-12). The growth was ours: the
 * previous_response_id replay cache was capped by ENTRY COUNT (1000) with no
 * byte limit, while each entry holds base64 `input_image` payloads. The disk
 * snapshot had a size cap; the RAM copy did not.
 *
 * Three layers now:
 *   1. the replay cache has a byte budget (see responses/state.ts)
 *   2. the usage log is capped by file size (see usage/log.ts)
 *   3. this guard: when RSS crosses a ceiling, the replay cache is trimmed
 *      (oldest first) and the event is logged, so the process gives the memory
 *      back instead of being OOM-killed or crashing the runtime.
 *
 * The ceiling comes from OPENCODEX_RSS_LIMIT_MB. When that is unset, the guard
 * falls back to a share of the machine's RAM (see defaultLimitBytes) so small
 * boxes are protected without configuration.
 */

import { statSync } from "node:fs";
import { totalmem } from "node:os";

import { requestLogFilePath } from "../server/request-log-store";
import { responseStateMaxBytes, responseStateStats, trimResponseStates } from "../responses/state";
import { usageLogBytes } from "../usage/log";

/** How often the guard looks at the process RSS. */
const CHECK_INTERVAL_MS = 30_000;

/** Share of the machine RAM above which the guard starts trimming. */
const DEFAULT_RAM_SHARE = 0.5;

function envLimitBytes(): number | null {
  const raw = process.env["OPENCODEX_RSS_LIMIT_MB"]?.trim();
  if (!raw) return null;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return Math.floor(mb * 1024 * 1024);
}

/** The RSS ceiling in bytes: explicit env wins, else a share of the machine RAM. */
export function memoryLimitBytes(): number {
  const explicit = envLimitBytes();
  if (explicit !== null) return explicit;
  let total = 0;
  try {
    total = totalmem();
  } catch {
    total = 0;
  }
  if (total <= 0) return 0;
  return Math.floor(total * DEFAULT_RAM_SHARE);
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A snapshot of everything that can grow, for /api/debug/memory. */
export function memorySnapshot(): {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  uptimeSeconds: number;
  limitBytes: number;
  overLimit: boolean;
  responseState: { entries: number; bytes: number; maxBytes: number };
  usageLogBytes: number;
  requestLogBytes: number;
} {
  const usage = process.memoryUsage();
  const limit = memoryLimitBytes();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    uptimeSeconds: Math.round(process.uptime()),
    limitBytes: limit,
    overLimit: limit > 0 && usage.rss > limit,
    responseState: responseStateStats(),
    usageLogBytes: usageLogBytes(),
    requestLogBytes: fileBytes(requestLogFilePath()),
  };
}

/**
 * Trim the replay cache until it is under `targetBytes`.
 * Returns how many entries were dropped (0 when nothing had to go).
 */
export function relieveMemory(targetBytes?: number): number {
  const target = targetBytes ?? Math.floor(responseStateMaxBytes() / 4);
  return trimResponseStates(target);
}

/**
 * Install the periodic RSS check. Returns a stop function.
 * `onTrim` reports what was dropped so the caller can log it.
 */
export function installMemoryGuard(onTrim: (dropped: number, snapshot: ReturnType<typeof memorySnapshot>) => void): () => void {
  const timer = setInterval(() => {
    const limit = memoryLimitBytes();
    if (limit <= 0) return;
    const rss = process.memoryUsage().rss;
    if (rss <= limit) return;
    const dropped = relieveMemory();
    onTrim(dropped, memorySnapshot());
  }, CHECK_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
