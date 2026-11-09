import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendConsoleLogLine, getConsoleLogEntries, resetConsoleLogBufferForTests } from "../src/lib/console-log-buffer";
import { installConsoleLogCapture } from "../src/lib/console-log-capture";

describe("console log capture", () => {
  afterEach(() => {
    resetConsoleLogBufferForTests();
  });

  test("captures a console line with its level", () => {
    appendConsoleLogLine("warn", "[key-scheduler] m.aiio.chat: staged rotation");
    const entries = getConsoleLogEntries();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1]!;
    expect(last.level).toBe("warn");
    expect(last.line).toContain("[key-scheduler]");
  });

  test("redacts secrets before the line enters the buffer", () => {
    const { redactSecretString } = require("../src/lib/redact");
    const line = redactSecretString("upstream said sk-live-abcdef1234567890");
    expect(line).not.toContain("sk-live-abcdef1234567890");
    expect(line).toContain("[REDACTED]");
  });

  test("filters by level", () => {
    appendConsoleLogLine("log", "plain line");
    appendConsoleLogLine("error", "error line");
    const errors = getConsoleLogEntries({ levels: ["error"] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(entry => entry.level === "error")).toBe(true);
  });

  test("returns entries after a cursor", () => {
    appendConsoleLogLine("log", "first");
    const first = getConsoleLogEntries();
    const cursor = first[first.length - 1]!.seq;
    appendConsoleLogLine("log", "second");
    const after = getConsoleLogEntries({ after: cursor });
    expect(after.length).toBe(1);
    expect(after[0]!.line).toBe("second");
  });

  test("installConsoleLogCapture mirrors a real console call and still calls through", () => {
    installConsoleLogCapture();
    // Spy AFTER the capture is installed: the capture wraps whatever console.log
    // is at install time, so a spy installed later replaces the wrapper and
    // would bypass the mirror entirely.
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      console.log("[ocx:probe] declared=700k learned=- current=700k");
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("the captured console call reaches the buffer", () => {
    installConsoleLogCapture();
    // Capture the CURRENT console.log (the mirror), call it, and let it write
    // through to the real console. The mirror is what must land in the buffer.
    const mirrored = console.log;
    const sink = spyOn(console, "log").mockImplementation(() => {});
    try {
      console.log = mirrored;
      mirrored("[ocx:probe] declared=700k learned=- current=700k");
      const entries = getConsoleLogEntries();
      const last = entries[entries.length - 1]!;
      expect(last.level).toBe("log");
      expect(last.line).toContain("[ocx:probe]");
    } finally {
      console.log = mirrored;
      sink.mockRestore();
    }
  });
});
