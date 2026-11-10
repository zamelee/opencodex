/**
 * Restore the previous run's console output into the in-memory console buffer.
 *
 * WHY: the console mirror (console-log-buffer.ts) is a ring buffer in RAM, so a restart
 * wipes it. The operator's real question is usually "what happened before I restarted?" —
 * and the answer already exists on disk: the launcher redirects stdout/stderr to
 * ocx.out.log / ocx.err.log. We do not write a second copy; we READ what is already
 * there and replay it into the buffer as history.
 *
 * The launcher rotates ocx.out.log -> ocx.out.log.1 on every start, so the ".1" file is
 * the previous run's log. Both the current format (`[2026-11-10 00:13:39.824]`) and the
 * older ISO-with-offset format are parsed, so the first run after an upgrade still
 * restores the old log correctly.
 *
 * Lines are matched to a level by the file they came from: stdout -> "log",
 * stderr -> "error".
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface ConsoleHistoryEntry {
  /** Epoch ms, or 0 when the line carried no timestamp. */
  at: number;
  level: string;
  line: string;
}

/** How many bytes of the tail of a log file we are willing to read. */
const TAIL_BYTES = 256 * 1024;

/** How many history lines we replay per file. */
const MAX_LINES_PER_FILE = 400;

const STAMP_PATTERN = /^\[(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})\.(\d{3})(?:Z|[+-]\d{2}:?\d{2})?\]/;

/** Parse a leading `[...]` timestamp into epoch ms; 0 when absent or unparseable. */
export function parseLogTimestamp(line: string): { at: number; rest: string } {
  const match = STAMP_PATTERN.exec(line);
  if (!match) return { at: 0, rest: line };
  const [, year, month, day, hour, minute, second, milli] = match;
  const at = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(milli),
  ).getTime();
  const rest = line.slice(match[0].length).replace(/^ /, "");
  return { at: Number.isFinite(at) ? at : 0, rest };
}

/** Read the last `maxLines` lines of a file, without loading the whole thing. */
function readTailLines(path: string, maxLines: number): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const length = Math.min(size, TAIL_BYTES);
  const start = size - length;
  let text: string;
  try {
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  // A partial first line (the tail started mid-line) is not a real line.
  if (start > 0 && lines.length > 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-maxLines);
}

/** Read one log file into history entries. */
export function readConsoleLogHistoryFile(path: string, level: string, maxLines = MAX_LINES_PER_FILE): ConsoleHistoryEntry[] {
  const entries = readTailLines(path, maxLines).map(raw => {
    // Keep the raw line (timestamp prefix included): live lines in the buffer also
    // carry their prefix, so the browser shows one uniform format for old and new.
    const { at } = parseLogTimestamp(raw);
    return { at, level, line: raw };
  });
  // A line printed in the same millisecond as the one before it carries no
  // stamp of its own (see log-timestamp.ts). Inherit the previous line's time
  // so sorting stays truthful.
  let lastAt = 0;
  for (const entry of entries) {
    if (entry.at > 0) lastAt = entry.at;
    else entry.at = lastAt;
  }
  return entries;
}

/**
 * Collect history from the launcher's log files.
 *
 * `paths` are the CURRENT log files (the launcher redirects stdout/stderr into them);
 * the rotated "<path>.1" sibling holds the previous run and is what we restore.
 */
export function collectConsoleLogHistory(
  sources: Array<{ path: string; level: string }>,
  maxLinesPerFile = MAX_LINES_PER_FILE,
): ConsoleHistoryEntry[] {
  const entries: ConsoleHistoryEntry[] = [];
  for (const source of sources) {
    if (!source.path) continue;
    entries.push(...readConsoleLogHistoryFile(`${source.path}.1`, source.level, maxLinesPerFile));
  }
  // Chronological across files: stdout and stderr are separate streams, so sort by the
 // timestamp we recovered. Lines without a timestamp keep file order at the end.
  entries.sort((a, b) => a.at - b.at);
  return entries;
}

/**
 * Where the launcher puts the logs. The launcher exports OCX_LOG_OUT / OCX_LOG_ERR;
 * when the proxy is started by hand we fall back to the current working directory.
 */
export function resolveConsoleLogPaths(
  env: Record<string, string | undefined> = process.env,
): Array<{ path: string; level: string }> {
  const out = env.OCX_LOG_OUT?.trim() || "ocx.out.log";
  const err = env.OCX_LOG_ERR?.trim() || "ocx.err.log";
  return [
    { path: out, level: "log" },
    { path: err, level: "error" },
  ];
}
