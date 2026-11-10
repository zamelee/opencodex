/**
 * Timestamped console output for the daemon's log files.
 *
 * WHY: the proxy's stdout/stderr (ocx.out.log / ocx.err.log) is the durable record of what
 * happened on a machine we cannot watch. Without a timestamp, a stack of lines from three
 * different incidents reads as one. The timestamp goes FIRST so it can be grepped and so a
 * line's position in the file sorts chronologically.
 *
 * The clock is LOCAL time: the operator reading the file is at that machine, and "21:45:35"
 * means the time they see on the wall. The offset is deliberately NOT printed — it made every
 * line 6 characters longer and nobody ever read it; the file lives on the machine whose clock
 * it shows.
 */

const PATCHED = Symbol.for("opencodex.logTimestampPatched");

/** Format one instant as `YYYY-MM-DD HH:MM:SS.mmm` (local time, no offset). */
export function formatLogTimestamp(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(Math.floor(Math.abs(value))).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Prefix every console call with a timestamp.
 *
 * Idempotent: the CLI entry point and the server entry point both call it, and a second
 * call must not double-prefix. Console methods are captured once and rebound, so the
 * original behaviour (formatting, extra arguments, stream) is preserved.
 */
export function installLogTimestamps(): void {
  const globalScope = globalThis as { [PATCHED]?: boolean };
  if (globalScope[PATCHED]) return;
  globalScope[PATCHED] = true;

  const methods = ["log", "info", "warn", "error", "debug"] as const;
  for (const method of methods) {
    const original = console[method] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    console[method] = (...args: unknown[]): void => {
      const stamp = formatLogTimestamp();
      const [first, ...rest] = args;
      if (typeof first === "string") {
        original.call(console, `[${stamp}] ${first}`, ...rest);
      } else {
        original.call(console, `[${stamp}]`, ...args);
      }
    };
  }
}
