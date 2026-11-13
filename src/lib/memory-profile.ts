/**
 * How much of the machine the proxy is allowed to use.
 *
 * WHY a profile instead of a fixed number: the replay cache that used to grow
 * without bound (see responses/state.ts) was killed on an 8 GB host that had
 * already swapped itself to death — 4.94 GB RSS, 10.11 GB commit, Bun dead
 * with SIGILL (2026-11-12). A fixed ceiling cannot be right for every box: a
 * 2 GB mini-PC and a 32 GB workstation need different numbers.
 *
 *   replay budget    = clamp(RAM * 2%,  32 MB,  256 MB)
 *   private warn     = clamp(RAM * 12%, 512 MB, 2 GB)
 *   private hard     = clamp(RAM * 18%, 1 GB,   3 GB)
 *   working set warn = clamp(RAM * 20%, 512 MB, 3 GB)
 *
 * WHY PRIVATE COMMIT IS THE MAIN CEILING (and RSS is not): on Windows the
 * resident set can be trimmed by the OS and can grow just from page touching,
 * so it is a poor "how much does this process owe the system" signal. Private
 * commit does not drop when pages are swapped out. On the incident host RSS
 * said 4.94 GB while commit said 10.11 GB — the pagefile was hiding half the
 * footprint from the RSS reading. Working set stays as an auxiliary warning
 * only.
 *
 * These are starting points for load testing, not Windows/Bun recommendations.
 * The private numbers are calibrated against a MEASURED baseline: a BLANK Bun
 * 1.3.14 process on the 8 GB no-AVX host already commits ~226 MB privately while
 * its working set is only ~47 MB. A ceiling that ignores the runtime's own
 * baseline would trip on the runtime alone.
 */

import { totalmem } from "node:os";

export interface MemoryProfile {
  /** Total RAM of the machine, in bytes. */
  ramBytes: number;
  /** Byte budget for the previous_response_id replay cache. */
  replayBudgetBytes: number;
  /** Private commit: warn above this. */
  privateWarnBytes: number;
  /** Private commit: hard line — protective mode, optional exit. */
  privateHardBytes: number;
  /** Working set: auxiliary warning only. */
  workingSetWarnBytes: number;
  /** Short label for the dashboard / logs. */
  tier: string;
}

const REPLAY_RAM_SHARE = 0.02;
const REPLAY_MIN_BYTES = 32 * 1024 * 1024;
const REPLAY_MAX_BYTES = 256 * 1024 * 1024;

const PRIVATE_WARN_RAM_SHARE = 0.12;
const PRIVATE_WARN_MIN_BYTES = 512 * 1024 * 1024;
const PRIVATE_WARN_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const PRIVATE_HARD_RAM_SHARE = 0.18;
const PRIVATE_HARD_MIN_BYTES = 1024 * 1024 * 1024;
const PRIVATE_HARD_MAX_BYTES = 3 * 1024 * 1024 * 1024;

const WORKING_SET_RAM_SHARE = 0.2;
const WORKING_SET_MIN_BYTES = 512 * 1024 * 1024;
const WORKING_SET_MAX_BYTES = 3 * 1024 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Machine RAM in bytes (0 when it cannot be determined). */
export function machineRamBytes(): number {
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

/**
 * The profile for this machine. `ramBytes` is injectable so the tiers can be
 * tested without a box of every size.
 */
export function memoryProfile(ramBytes: number = machineRamBytes()): MemoryProfile {
  const ram = ramBytes > 0 ? ramBytes : 8 * 1024 * 1024 * 1024;
  const replayBudgetBytes = clamp(Math.floor(ram * REPLAY_RAM_SHARE), REPLAY_MIN_BYTES, REPLAY_MAX_BYTES);
  const privateWarnBytes = clamp(
    Math.floor(ram * PRIVATE_WARN_RAM_SHARE),
    PRIVATE_WARN_MIN_BYTES,
    PRIVATE_WARN_MAX_BYTES,
  );
  const privateHardBytes = clamp(
    Math.floor(ram * PRIVATE_HARD_RAM_SHARE),
    PRIVATE_HARD_MIN_BYTES,
    PRIVATE_HARD_MAX_BYTES,
  );
  const workingSetWarnBytes = clamp(
    Math.floor(ram * WORKING_SET_RAM_SHARE),
    WORKING_SET_MIN_BYTES,
    WORKING_SET_MAX_BYTES,
  );
  const tier = ram >= 24 * 1024 * 1024 * 1024
    ? "xlarge"
    : ram >= 12 * 1024 * 1024 * 1024
      ? "large"
      : ram >= 6 * 1024 * 1024 * 1024
        ? "medium"
        : ram >= 3 * 1024 * 1024 * 1024
          ? "small"
          : "tiny";
  return {
    ramBytes: ram,
    replayBudgetBytes,
    privateWarnBytes,
    privateHardBytes,
    workingSetWarnBytes,
    tier,
  };
}
