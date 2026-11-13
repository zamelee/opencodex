/**
 * Per-process memory counters, with the two that actually matter for a guard.
 *
 * WHY NOT JUST RSS: on Windows, RSS (Working Set) is the physical memory currently
 * resident. It can shrink because the OS trimmed the working set, and it can grow
 * because pages were touched — neither tells you how much memory the process has
 * *committed*. The number that behaves like "what this process owes the system" is
 * PrivateUsage (private commit): it does not drop when pages are paged out, so a
 * process whose pages are all swapped out still shows its true footprint.
 *
 * That distinction matters for the incident that produced this module: the 8 GB host
 * reported `RSS 4.94GB | Commit 10.11GB`. Commit grew past what RSS suggested, and
 * the gap is exactly what paging hides. A guard that watches RSS alone can be told
 * "everything is fine" by the pagefile.
 *
 * Primary source: GetProcessMemoryInfo() from psapi.dll (Windows Vista+), which
 * reports WorkingSetSize, PagefileUsage and PrivateUsage for a process handle.
 * Everywhere else (and if the call fails) we fall back to Bun's process.memoryUsage(),
 * where "private bytes" degrades to "resident bytes" — documented as an approximation
 * rather than silently pretending the two are the same.
 */

export interface ProcessMemoryCounters {
  /** Resident physical memory (Working Set). */
  workingSetBytes: number;
  /** Private commit: memory the process has reserved and committed to itself. */
  privateBytes: number;
  /** Commit charge that is backed by the pagefile rather than RAM. */
  pagefileBytes: number;
  /** Cumulative page faults. */
  pageFaultCount: number;
  /** True when the values come from the Windows API rather than the fallback. */
  precise: boolean;
}

import { dlopen, FFIType } from "bun:ffi";
import { freemem, totalmem } from "node:os";

type GetProcessMemoryInfoFn = (
  handle: unknown,
  counters: unknown,
  size: number,
) => number;
type GetCurrentProcessFn = () => unknown;

let cached: {
  getProcessMemoryInfo: GetProcessMemoryInfoFn;
  getCurrentProcess: GetCurrentProcessFn;
} | null = null;
let cachedFailed = false;

/** PROCESS_MEMORY_COUNTERS on x64: cb, PageFaultCount, then nine SIZE_T fields. */
const COUNTERS_SIZE = 80;
const OFF_WORKING_SET = 16;
const OFF_PAGEFILE = 56;
const OFF_PRIVATE = 72;
const OFF_PAGE_FAULTS = 4;

function loadWindowsApi(): boolean {
  if (cached) return true;
  if (cachedFailed || process.platform !== "win32") return false;
  try {
    const psapi = dlopen("psapi.dll", {
      GetProcessMemoryInfo: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    // GetCurrentProcess lives in kernel32, not psapi.
    const kernel32 = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
    });
    cached = {
      getProcessMemoryInfo: psapi.symbols.GetProcessMemoryInfo as unknown as GetProcessMemoryInfoFn,
      getCurrentProcess: kernel32.symbols.GetCurrentProcess as unknown as GetCurrentProcessFn,
    };
    return true;
  } catch {
    cachedFailed = true;
    return false;
  }
}

/**
 * Read the counters. Never throws: a failed read falls back to Bun's own numbers
 * with `precise: false`.
 */
export function processMemoryCounters(): ProcessMemoryCounters {
  const usage = process.memoryUsage();
  if (loadWindowsApi() && cached) {
    try {
      const buf = new ArrayBuffer(COUNTERS_SIZE);
      const ok = cached.getProcessMemoryInfo(
        cached.getCurrentProcess(),
        buf,
        COUNTERS_SIZE,
      );
      if (ok) {
        const view = new DataView(buf);
        return {
          workingSetBytes: Number(view.getBigUint64(OFF_WORKING_SET, true)),
          privateBytes: Number(view.getBigUint64(OFF_PRIVATE, true)),
          pagefileBytes: Number(view.getBigUint64(OFF_PAGEFILE, true)),
          pageFaultCount: view.getUint32(OFF_PAGE_FAULTS, true),
          precise: true,
        };
      }
    } catch {
      /* fall through to the approximation */
    }
  }
  return {
    workingSetBytes: usage.rss,
    privateBytes: usage.rss,
    pagefileBytes: 0,
    pageFaultCount: 0,
    precise: false,
  };
}

/**
 * Machine-wide memory pressure, used as an extra guard condition: a small process
 * should not be allowed to push an already-starved machine into the OOM killer.
 */
export interface SystemMemory {
  totalPhysicalBytes: number;
  availablePhysicalBytes: number;
  /** Best-effort system commit limit; 0 when it cannot be determined. */
  commitLimitBytes: number;
  /** Best-effort system commit charge; 0 when it cannot be determined. */
  commitBytes: number;
}

export function systemMemory(): SystemMemory {
  const total = safeTotalMem();
  return {
    totalPhysicalBytes: total,
    availablePhysicalBytes: safeFreeMem(),
    commitLimitBytes: 0,
    commitBytes: 0,
  };
}

function safeTotalMem(): number {
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

function safeFreeMem(): number {
  try {
    return freemem();
  } catch {
    return 0;
  }
}
