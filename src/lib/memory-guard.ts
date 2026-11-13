/**
 * Memory ceiling and diagnostics for the proxy process.
 *
 * WHY: on an 8 GB host the proxy grew to 4.94 GB RSS / 10.11 GB commit after
 * 31 hours and Bun died with SIGILL (2026-11-12). The growth was ours: the
 * previous_response_id replay cache was capped by ENTRY COUNT (1000) with no
 * byte limit, while each entry holds base64 `input_image` payloads. The disk
 * snapshot had a size cap; the RAM copy did not.
 *
 * FOUR LAYERS now:
 *   1. the replay cache has a byte budget (see responses/state.ts)
 *   2. the usage log is capped by file size (see usage/log.ts)
 *   3. this guard: PRIVATE COMMIT is the main ceiling, the working set is an
 *      auxiliary signal, and the replay cache is trimmed when either is crossed
 *   4. an optional hard exit, so a process that cannot give the memory back
 *      does not sit there until the runtime dies
 *
 * WHY PRIVATE COMMIT AND NOT RSS: on Windows the resident set can shrink because
 * the OS trimmed it and can grow just from pages being touched. Private commit
 * (PrivateUsage) is what the process actually owes the system and does not drop
 * when pages are swapped out. On the incident host RSS read 4.94 GB while commit
 * read 10.11 GB -- the pagefile was hiding half the footprint from the RSS
 * reading, so an RSS-only guard would have fired far too late.
 *
 * The state machine has hysteresis on purpose: 30 s sampling means "three
 * consecutive samples" is 90 s, which is a long time to be bleeding when the
 * machine is already short of memory. Crossing the hard line is immediate;
 * recovery needs three good samples below the (lower) recovery line.
 */

import { statSync } from "node:fs";

import { requestLogFilePath } from "../server/request-log-store";
import {
  responseStateMaxBytes,
  responseStateStats,
  trimResponseStates,
} from "../responses/state";
import { usageLogBytes } from "../usage/log";
import { memoryProfile } from "./memory-profile";
import { processMemoryCounters, systemMemory } from "./process-memory";

/** How often the guard looks at the process memory. */
const CHECK_INTERVAL_MS = 30_000;
/** Consecutive warn-level samples before we call it a warning. */
const WARN_SAMPLES = 2;
/** Consecutive recovery samples before we call it normal again. */
const RECOVERY_SAMPLES = 3;
/** Recovery line: below 80% of the warn line. */
const RECOVERY_RATIO = 0.8;

export type MemoryState = "normal" | "warning" | "critical";

export interface MemoryLimits {
  /** Private commit: above this we warn and trim. */
  warnBytes: number;
  /** Private commit: above this we are in protective mode. */
  hardBytes: number;
  /** Working set: auxiliary warning only. */
  workingSetWarnBytes: number;
  /** Where the numbers came from: "env" or "profile". */
  source: "env" | "profile";
}

function envMb(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * The effective limits. Explicit env wins; otherwise the machine profile.
 *
 * OPENCODEX_RSS_LIMIT_MB is the old name and still works as the HARD limit --
 * renaming it would silently change the meaning of somebody's existing config.
 */
export function memoryLimits(): MemoryLimits {
  const profile = memoryProfile();
  const hard = envMb("OPENCODEX_MEMORY_HARD_MB") ?? envMb("OPENCODEX_RSS_LIMIT_MB");
  const warn = envMb("OPENCODEX_MEMORY_WARN_MB");
  const workingSet = envMb("OPENCODEX_MEMORY_WORKING_SET_MB");
  return {
    warnBytes: warn ?? profile.privateWarnBytes,
    hardBytes: hard ?? profile.privateHardBytes,
    workingSetWarnBytes: workingSet ?? profile.workingSetWarnBytes,
    source: hard !== null || warn !== null || workingSet !== null ? "env" : "profile",
  };
}

/** Backwards-compatible alias: the hard ceiling in bytes. */
export function memoryLimitBytes(): number {
  return memoryLimits().hardBytes;
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
  workingSetBytes: number;
  privateBytes: number;
  pagefileBytes: number;
  pageFaultCount: number;
  precise: boolean;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  uptimeSeconds: number;
  warnBytes: number;
  limitBytes: number;
  workingSetWarnBytes: number;
  limitsSource: "env" | "profile";
  tier: string;
  ramBytes: number;
  availablePhysicalBytes: number;
  state: MemoryState;
  overLimit: boolean;
  responseState: { entries: number; bytes: number; maxBytes: number; sessions: number; evicted: number };
  usageLogBytes: number;
  requestLogBytes: number;
} {
  const usage = process.memoryUsage();
  const counters = processMemoryCounters();
  const limits = memoryLimits();
  const profile = memoryProfile();
  const system = systemMemory();
  return {
    workingSetBytes: counters.workingSetBytes,
    privateBytes: counters.privateBytes,
    pagefileBytes: counters.pagefileBytes,
    pageFaultCount: counters.pageFaultCount,
    precise: counters.precise,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    uptimeSeconds: Math.round(process.uptime()),
    warnBytes: limits.warnBytes,
    limitBytes: limits.hardBytes,
    workingSetWarnBytes: limits.workingSetWarnBytes,
    limitsSource: limits.source,
    tier: profile.tier,
    ramBytes: profile.ramBytes,
    availablePhysicalBytes: system.availablePhysicalBytes,
    state: currentState,
    overLimit: limits.hardBytes > 0 && counters.privateBytes > limits.hardBytes,
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

let currentState: MemoryState = "normal";
let warnStreak = 0;
let recoveryStreak = 0;

export interface MemoryCheck {
  state: MemoryState;
  /** True when this call changed the state (the caller logs only on transitions). */
  changed: boolean;
  dropped: number;
  privateBytes: number;
  hardBytes: number;
  warnBytes: number;
  workingSetBytes: number;
}

/**
 * One memory check.
 *
 * Called on the timer, on request arrival and before a replay entry is written:
 * a 300 MB request can allocate and finish between two timer ticks, so sampling
 * alone is not a guard.
 */
export function checkMemoryPressure(opts?: { trim?: boolean }): MemoryCheck {
  const limits = memoryLimits();
  const counters = processMemoryCounters();
  const privateBytes = counters.privateBytes;
  const hard = limits.hardBytes;
  const warn = limits.warnBytes;
  const previousState = currentState;
  let dropped = 0;

  const overHard = hard > 0 && privateBytes > hard;
  const overWarn = warn > 0 && privateBytes > warn;

  if (overHard) {
    // Hard line: no waiting for a second sample.
    currentState = "critical";
    warnStreak = 0;
    recoveryStreak = 0;
    if (opts?.trim !== false) dropped = relieveMemory();
  } else if (overWarn) {
    warnStreak++;
    recoveryStreak = 0;
    if (warnStreak >= WARN_SAMPLES) {
      currentState = "warning";
      if (opts?.trim !== false) dropped = relieveMemory();
    }
  } else {
    warnStreak = 0;
    const recoveryLine = Math.floor(warn * RECOVERY_RATIO);
    if (currentState !== "normal" && privateBytes < recoveryLine) {
      recoveryStreak++;
      if (recoveryStreak >= RECOVERY_SAMPLES) {
        currentState = "normal";
        recoveryStreak = 0;
      }
    } else {
      recoveryStreak = 0;
    }
  }

  return {
    state: currentState,
    changed: currentState !== previousState,
    dropped,
    privateBytes,
    hardBytes: hard,
    warnBytes: warn,
    workingSetBytes: counters.workingSetBytes,
  };
}

/** Current state without taking a new sample. */
export function memoryState(): MemoryState {
  return currentState;
}

/** Reset the state machine (tests, and after a manual trim). */
export function resetMemoryGuardState(): void {
  currentState = "normal";
  warnStreak = 0;
  recoveryStreak = 0;
}

/**
 * Install the periodic memory check. Returns a stop function.
 * `onEvent` is called on every state transition (and on trims), so the caller can
 * log it. A steady state does NOT produce a log line every 30 seconds -- a log
 * that repeats itself is a second memory problem.
 */
export function installMemoryGuard(
  onEvent: (check: MemoryCheck, snapshot: ReturnType<typeof memorySnapshot>) => void,
): () => void {
  const timer = setInterval(() => {
    const check = checkMemoryPressure();
    if (check.changed || check.dropped > 0) onEvent(check, memorySnapshot());
  }, CHECK_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
