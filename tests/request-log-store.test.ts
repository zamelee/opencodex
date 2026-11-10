import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache } from "../src/config";
import {
  appendRequestLogEntry,
  clearRequestLogFile,
  readRequestLogEntries,
  requestLogFilePath,
} from "../src/server/request-log-store";

describe("request log store", () => {
  let home: string;
  const originalHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-request-log-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResolvedConfigDirCache();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = originalHome;
    clearResolvedConfigDirCache();
  });

  test("entries land in the config dir and read back", () => {
    appendRequestLogEntry({ requestId: "ocx-1", timestamp: 1, model: "m", provider: "p" });
    appendRequestLogEntry({ requestId: "ocx-2", timestamp: 2, model: "m", provider: "p" });
    expect(requestLogFilePath().startsWith(home)).toBe(true);
    const entries = readRequestLogEntries() as Array<{ requestId: string }>;
    expect(entries.length).toBe(2);
    expect(entries[0]!.requestId).toBe("ocx-1");
    expect(entries[1]!.requestId).toBe("ocx-2");
  });

  test("a malformed line is skipped, not fatal", () => {
    appendRequestLogEntry({ requestId: "ocx-1", timestamp: 1 });
    const path = requestLogFilePath();
    require("node:fs").appendFileSync(path, "{not json\n", "utf8");
    appendRequestLogEntry({ requestId: "ocx-2", timestamp: 2 });
    const entries = readRequestLogEntries() as Array<{ requestId: string }>;
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.requestId)).toEqual(["ocx-1", "ocx-2"]);
  });

  test("the file is capped by size and the oldest entries go first", () => {
    const limit = 400;
    for (let i = 0; i < 40; i++) {
      appendRequestLogEntry({ requestId: `ocx-${i}`, timestamp: i, filler: "x".repeat(40) }, limit);
    }
    const size = statSync(requestLogFilePath()).size;
    expect(size).toBeLessThanOrEqual(limit);
    const entries = readRequestLogEntries() as Array<{ requestId: string }>;
    expect(entries.length).toBeGreaterThan(0);
    // The newest entry always survives the trim.
    expect(entries[entries.length - 1]!.requestId).toBe("ocx-39");
  });

  test("clear removes the file", () => {
    appendRequestLogEntry({ requestId: "ocx-1", timestamp: 1 });
    clearRequestLogFile();
    expect(readRequestLogEntries().length).toBe(0);
  });
});
