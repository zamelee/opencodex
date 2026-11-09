/**
 * Mirror the proxy's console output into an in-memory ring buffer.
 *
 * WHY: see console-log-buffer.ts. The Debug page needs the daemon's own
 * console lines (the "[key-scheduler] ...", "[ocx:probe] ...", "gate circuit
 * armed" lines) without requiring a shell on the remote machine.
 *
 * Design notes:
 * - The ORIGINAL console call always runs first, so ocx.out.log / ocx.err.log
   keep their content and their timestamps. This is a mirror, not a sink.
 * - Redaction runs on the way in: a console line can carry a key (the
   opencodex-audit line prints a provider key id, and an upstream error body
   can echo a token), and this buffer is served over the management API.
 * - Failures here must never break the caller: the whole point of a
   diagnostic is to stay out of the way.
 */

import { appendConsoleLogLine } from "./console-log-buffer";
import { redactSecretString } from "./redact";

const PATCHED = Symbol.for("opencodex.consoleLogCapturePatched");

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** Render console arguments the way the console itself would, minus the formatting. */
function renderArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export function installConsoleLogCapture(): void {
  const globalScope = globalThis as { [PATCHED]?: boolean };
  if (globalScope[PATCHED]) return;
  globalScope[PATCHED] = true;

  for (const level of LEVELS) {
    const original = console[level] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    console[level] = (...args: unknown[]): void => {
      try {
        const line = redactSecretString(renderArgs(args));
        appendConsoleLogLine(level, line.length > 2_000 ? `${line.slice(0, 2_000)}...` : line);
      } catch {
        /* the mirror must never affect the original call */
      }
      original.call(console, ...args);
    };
  }
}
