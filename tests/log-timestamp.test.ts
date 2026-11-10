import { describe, expect, test } from "bun:test";
import { formatLogStampSmart, formatLogTimestamp } from "../src/lib/log-timestamp";

describe("log timestamp", () => {
  test("the format is local time without an offset", () => {
    const stamp = formatLogTimestamp(new Date(2026, 10, 10, 0, 13, 39, 824));
    expect(stamp).toBe("2026-11-10 00:13:39.824");
    expect(stamp).not.toContain("+");
    expect(stamp).not.toContain("T");
  });

  test("two lines in the same millisecond share one stamp", () => {
    const now = new Date(2026, 10, 10, 0, 13, 39, 824);
    const first = formatLogStampSmart("", now);
    expect(first.repeat).toBe(false);
    const second = formatLogStampSmart(first.stamp, now);
    expect(second.repeat).toBe(true);
    expect(second.stamp).toBe(first.stamp);
  });

  test("a later millisecond gets its own stamp", () => {
    const first = formatLogStampSmart("", new Date(2026, 10, 10, 0, 13, 39, 824));
    const next = formatLogStampSmart(first.stamp, new Date(2026, 10, 10, 0, 13, 39, 825));
    expect(next.repeat).toBe(false);
    expect(next.stamp).not.toBe(first.stamp);
  });
});
