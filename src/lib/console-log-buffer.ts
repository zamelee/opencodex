/**
 * In-memory mirror of the proxy's own console output.
 *
 * WHY: the daemon's stdout/stderr (ocx.out.log / ocx.err.log) is the durable
 * record of what happened on a machine we cannot watch. Until now the only way
 * to read it was to open the file on that machine — impossible when the box is
 * remote and the browser is not. This buffer mirrors every console line into
 * memory so the Debug page can show it, which is what turns "go look at the
 * log file" into "open the tab".
 *
 * It is a MIRROR, not a replacement: the original console call still runs, so
 * the log file keeps its content and its timestamps.
 *
 * Ring-capped like the provider debug buffer: a long-running proxy must not
 * grow its heap without bound.
 */

export interface ConsoleLogEntry {
  /** Monotonic cursor for pagination; survives same-millisecond bursts. */
  seq: number;
  at: number;
  /** "log" | "info" | "warn" | "error" | "debug" — which console method emitted it. */
  level: string;
  line: string;
}

const MAX_LINES = 2_000;
const buffer: ConsoleLogEntry[] = [];
let nextSeq = 1;

/**
 * How many lines to keep per level. Console error output can be very chatty
 * (a retry storm prints one line per attempt), and a single level can
 * otherwise crowd out the others.
 */
const MAX_LINES_PER_LEVEL = 800;

export function appendConsoleLogLine(level: string, line: string): void {
  const entry: ConsoleLogEntry = { seq: nextSeq++, at: Date.now(), level, line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  // Per-level cap: drop the oldest of the loudest level rather than letting it
  // evict the quiet ones entirely.
  let levelCount = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i]!.level !== level) continue;
    levelCount++;
    if (levelCount > MAX_LINES_PER_LEVEL) {
      buffer.splice(i, 1);
      break;
    }
  }
}

export function getConsoleLogEntries(options?: { after?: number; limit?: number; levels?: string[] }): ConsoleLogEntry[] {
  const after = options?.after ?? 0;
  const limit = options?.limit ?? 500;
  const levels = options?.levels && options.levels.length > 0 ? new Set(options.levels) : null;
  const filtered = buffer.filter(entry => entry.seq > after && (!levels || levels.has(entry.level)));
  if (filtered.length <= limit) return filtered;
  return filtered.slice(-limit);
}

/**
 * Replay history (read back from the launcher's rotated log files) into the buffer.
 *
 * Called once at startup, before any live line is captured, so the history keeps the
 * lower sequence numbers and the browser sees one continuous stream: old lines first,
 * then the live ones.
 */
export function seedConsoleLogHistory(entries: Array<{ at: number; level: string; line: string }>): void {
  if (entries.length === 0) return;
  const seeded: ConsoleLogEntry[] = entries.map((entry, index) => ({
    seq: index + 1,
    at: entry.at,
    level: entry.level,
    line: entry.line,
  }));
  buffer.unshift(...seeded);
  nextSeq = seeded.length + 1;
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

/** Test isolation. */
export function resetConsoleLogBufferForTests(): void {
  buffer.length = 0;
  nextSeq = 1;
}
