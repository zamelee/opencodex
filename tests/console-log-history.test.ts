import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectConsoleLogHistory,
  parseLogTimestamp,
  readConsoleLogHistoryFile,
} from "../src/lib/console-log-history";
import {
  getConsoleLogEntries,
  resetConsoleLogBufferForTests,
  seedConsoleLogHistory,
} from "../src/lib/console-log-buffer";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-console-history-"));
}

describe("console log history", () => {
  afterEach(() => {
    resetConsoleLogBufferForTests();
  });

  test("parses the current timestamp format", () => {
    const parsed = parseLogTimestamp("[2026-11-10 00:13:39.824] hello");
    expect(parsed.rest).toBe("hello");
    expect(parsed.at).toBeGreaterThan(0);
    const d = new Date(parsed.at);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(10);
  });

  test("parses the older ISO-with-offset format", () => {
    const parsed = parseLogTimestamp("[2026-11-10T00:13:39.824+08:00] hello");
    expect(parsed.rest).toBe("hello");
    expect(parsed.at).toBeGreaterThan(0);
  });

  test("a line without a timestamp keeps its text and reports no time", () => {
    const parsed = parseLogTimestamp("plain line");
    expect(parsed.at).toBe(0);
    expect(parsed.rest).toBe("plain line");
  });

  test("reads a log file into history entries with the file's level", () => {
    const dir = tempDir();
    const path = join(dir, "ocx.err.log");
    writeFileSync(path, "[2026-11-10 00:13:39.824] boom\n[2026-11-10 00:13:40.100] bang\n", "utf8");
    const entries = readConsoleLogHistoryFile(path, "error");
    expect(entries.length).toBe(2);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.line).toBe("[2026-11-10 00:13:39.824] boom");
    expect(entries[1]!.at).toBeGreaterThan(entries[0]!.at);
  });

  test("collects the rotated .1 file of each source and sorts by time", () => {
    const dir = tempDir();
    const out = join(dir, "ocx.out.log");
    const err = join(dir, "ocx.err.log");
    writeFileSync(`${out}.1`, "[2026-11-10 00:00:00.000] stdout line\n", "utf8");
    writeFileSync(`${err}.1`, "[2026-11-10 00:00:01.000] stderr line\n", "utf8");
    const entries = collectConsoleLogHistory([
      { path: out, level: "log" },
      { path: err, level: "error" },
    ]);
    expect(entries.length).toBe(2);
    expect(entries[0]!.line).toBe("[2026-11-10 00:00:00.000] stdout line");
    expect(entries[1]!.line).toBe("[2026-11-10 00:00:01.000] stderr line");
    expect(entries[1]!.level).toBe("error");
  });

  test("missing files are simply empty history", () => {
    const entries = collectConsoleLogHistory([{ path: join(tempDir(), "nope.log"), level: "log" }]);
    expect(entries.length).toBe(0);
  });

  test("seeding puts history first and live lines continue the sequence", () => {
    seedConsoleLogHistory([
      { at: 1, level: "log", line: "old line" },
      { at: 2, level: "error", line: "old error" },
    ]);
    const { appendConsoleLogLine } = require("../src/lib/console-log-buffer");
    appendConsoleLogLine("log", "new line");
    const entries = getConsoleLogEntries();
    expect(entries.length).toBe(3);
    expect(entries[0]!.line).toBe("old line");
    expect(entries[0]!.seq).toBe(1);
    expect(entries[2]!.line).toBe("new line");
    expect(entries[2]!.seq).toBe(3);
  });
});
