import { describe, expect, test } from "bun:test";
import { suggestErrorFamily } from "../src/lib/upstream-error-llm";
import { normalizeUpstreamError } from "../src/lib/upstream-error-normalize";

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const CONFIG = {
  enabled: true,
  baseUrl: "https://example.invalid",
  apiKey: "key-test",
  model: "test-model",
};

describe("the optional LLM assist (off by default, an advisor only)", () => {
  test("does nothing when the switch is off", async () => {
    const normalized = normalizeUpstreamError("something we cannot read");
    const suggestion = await suggestErrorFamily(normalized, {
      config: { ...CONFIG, enabled: false },
      fetchImpl: fakeFetch({ content: [{ type: "text", text: '{"family":"auth"}' }] }),
    });
    expect(suggestion).toBeUndefined();
  });

  test("does not second-guess a family our own reader already named", async () => {
    const normalized = normalizeUpstreamError(
      '{"error":{"type":"prompt_too_long","message":"prompt is too long"}}',
    );
    expect(normalized.family).toBe("prompt_too_long");
    let called = false;
    const suggestion = await suggestErrorFamily(normalized, {
      config: CONFIG,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(suggestion).toBeUndefined();
    expect(called).toBe(false);
  });

  test("fills a family we could not read", async () => {
    const normalized = normalizeUpstreamError(
      '{"error":{"message":"the model is not provisioned for this tenant"}}',
    );
    expect(normalized.family).toBe("unknown");
    const suggestion = await suggestErrorFamily(normalized, {
      config: CONFIG,
      fetchImpl: fakeFetch({
        content: [{
          type: "text",
          text: '{"family":"auth","confidence":0.8,"reason":"not provisioned"}',
        }],
      }),
    });
    expect(suggestion).toEqual({ family: "auth", confidence: 0.8, reason: "not provisioned" });
  });

  test("never returns a number, even when the model offers one", async () => {
    const normalized = normalizeUpstreamError("we cannot read this one");
    const suggestion = await suggestErrorFamily(normalized, {
      config: CONFIG,
      fetchImpl: fakeFetch({
        content: [{
          type: "text",
          text: '{"family":"prompt_too_long","observedTokens":999,"contextLimit":1000}',
        }],
      }),
    });
    expect(suggestion).toEqual({ family: "prompt_too_long" });
    expect(JSON.stringify(suggestion)).not.toContain("999");
  });

  test("a model that misquotes a number we already know loses its vote entirely", async () => {
    const normalized = normalizeUpstreamError(
      '{"error":{"type":"prompt_too_long","message":"prompt is too long: 5010629 tokens > 1048576 maximum"}}',
    );
    const suggestion = await suggestErrorFamily(normalized, {
      config: CONFIG,
      fetchImpl: fakeFetch({
        content: [{
          type: "text",
          text: '{"family":"prompt_too_long","observedTokens":123,"contextLimit":456}',
        }],
      }),
    });
    expect(suggestion).toBeUndefined();
  });

  test("every failure ends the same way: no suggestion", async () => {
    const normalized = normalizeUpstreamError("we cannot read this one");
    const cases: Array<typeof fetch> = [
      fakeFetch({ content: [{ type: "text", text: "not json at all" }] }),
      fakeFetch({ content: [{ type: "text", text: '{"family":"not_a_family"}' }] }),
      fakeFetch({ content: [{ type: "text", text: '{"family":"unknown"}' }] }),
      fakeFetch({ error: "boom" }, 500),
      fakeFetch({ error: "boom" }, 429),
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of cases) {
      const suggestion = await suggestErrorFamily(normalized, { config: CONFIG, fetchImpl });
      expect(suggestion).toBeUndefined();
    }
  });

  test("a timeout ends the same way", async () => {
    const normalized = normalizeUpstreamError("we cannot read this one");
    const suggestion = await suggestErrorFamily(normalized, {
      config: { ...CONFIG, timeoutMs: 500 },
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(suggestion).toBeUndefined();
  }, 10_000);
});
