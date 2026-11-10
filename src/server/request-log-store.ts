/**
 * Durable home for the request log.
 *
 * WHY: the Logs page used to live in memory only (200 entries), so a restart
 * erased the very thing an operator was looking at — "which request failed at
 * 21:45, and what did the upstream say?". The entries are METADATA (model,
 * provider, status, token counts, duration, request id, a redacted error
 * summary); there is no conversation text in them, so keeping them on disk is
 * ordinary operational logging, not a privacy decision.
 *
 * The file is capped by SIZE, not by entry count: a busy proxy writes a lot of
 * small entries, and "the last 2 MB" is a limit an operator can reason about
 * ("how much disk"), while "the last 500 entries" is a limit that shrinks on a
 * quiet day and explodes on a busy one.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";

/** The file never grows past this. */
export const REQUEST_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** After a trim we keep this fraction of the bytes, so trimming is not a per-write chore. */
const KEEP_RATIO = 0.8;

export function requestLogFilePath(): string {
  return join(getConfigDir(), "request-log.jsonl");
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append one entry. Never throws: logging must not fail a user request. */
export function appendRequestLogEntry(entry: unknown, limit = REQUEST_LOG_MAX_BYTES): void {
  try {
    const path = requestLogFilePath();
    ensureDir(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    enforceSizeLimit(path, limit);
  } catch {
    /* the log is a nicety; never break the request over it */
  }
}

/**
 * Keep the file under the cap by dropping the OLDEST lines.
 *
 * Only runs when the file is over the cap, and keeps KEEP_RATIO of the bytes,
 * so the trim is amortized instead of happening on every single write.
 */
function enforceSizeLimit(path: string, limit: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= limit) return;
  const budget = Math.floor(limit * KEEP_RATIO);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter(line => line.trim() !== "");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const sizeOfLine = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (bytes + sizeOfLine > budget) break;
    bytes += sizeOfLine;
    kept.unshift(lines[i]!);
  }
  try {
    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
  } catch {
    /* leave the oversized file alone rather than losing it entirely */
  }
}

/** Read the persisted entries, newest last. Malformed lines are skipped. */
export function readRequestLogEntries(): unknown[] {
  const path = requestLogFilePath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a half-written last line after a hard kill: skip it */
    }
  }
  return entries;
}

/** Delete the persisted log (GUI "clear" button). */
export function clearRequestLogFile(): void {
  try {
    rmSync(requestLogFilePath(), { force: true });
  } catch {
    /* nothing to clear */
  }
}
