import { describe, expect, test } from "bun:test";
import { summarizeUpstreamErrorBody } from "../src/lib/upstream-error-body";

describe("summarizeUpstreamErrorBody", () => {
  test("names the status phrase from an HTML gateway page", () => {
    const html = "<html><head><title>502 Bad Gateway</title></head>"
      + "<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.25.3</center></body></html>";
    const out = summarizeUpstreamErrorBody(html, 502, "text/html");
    expect(out.summary).toContain("502 Bad Gateway");
    expect(out.summary).toContain("text/html");
    expect(out.summary).toContain(`${Buffer.byteLength(html, "utf-8")} bytes`);
  });

  test("falls back to h1 when the page has no title", () => {
    const out = summarizeUpstreamErrorBody("<body><h1>504 Gateway Time-out</h1></body>", 504, "text/html");
    expect(out.summary).toContain("504 Gateway Time-out");
  });

  test("strips markup when there is neither title nor h1", () => {
    const out = summarizeUpstreamErrorBody("<body><p>upstream refused</p></body>", 502, "text/html");
    expect(out.summary).toContain("upstream refused");
    expect(out.summary).not.toContain("<");
  });

  test("keeps the first line of a plain-text body", () => {
    const out = summarizeUpstreamErrorBody(
      "upstream connect error or disconnect/reset before headers\nsecond line ignored",
      502,
      "text/plain",
    );
    expect(out.summary).toContain("upstream connect error or disconnect/reset before headers");
    expect(out.summary).not.toContain("second line ignored");
  });

  test("reports an empty body as such instead of staying silent", () => {
    const out = summarizeUpstreamErrorBody("", 502, "text/html");
    expect(out.summary).toContain("empty body");
    expect(out.summary).toContain("0 bytes");
    expect(out.sample).toBe("");
  });

  test("describes an unknown content type rather than guessing one", () => {
    const out = summarizeUpstreamErrorBody("something broke", 500, null);
    expect(out.summary).toContain("unknown content-type");
    expect(out.summary).toContain("something broke");
  });

  test("truncates a huge one-line body", () => {
    const out = summarizeUpstreamErrorBody("z".repeat(5_000), 502, "text/plain");
    expect(out.summary.length).toBeLessThan(300);
    expect(out.summary).toContain("...");
  });
});
