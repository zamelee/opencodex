import { afterEach, describe, expect, test } from "bun:test";
import {
  buildProbeFiller,
  GATE_PROBE_MAX_TARGET_TOKENS,
  probeUpstreamGate,
} from "../src/providers/context-gate-probe";
import type { OcxProviderConfig } from "../src/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function provider(adapter: OcxProviderConfig["adapter"], baseUrl: string): OcxProviderConfig {
  return { adapter, baseUrl, apiKey: "k" } as OcxProviderConfig;
}

describe("the active context-gate probe", () => {
  test("the filler is big enough and does not collapse under BPE", () => {
    const filler = buildProbeFiller(1_000);
    // 3 chars/token, plus a space per word.
    expect(filler.length).toBeGreaterThanOrEqual(2_999);
    // A body of one repeated character would collapse into a handful of tokens.
    expect(new Set(filler.split(" ")).size).toBeGreaterThan(1);
  });

  test("a rejection that names a ceiling is the answer we wanted", async () => {
    let seen = "";
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = String(init.body);
      return new Response(
        '{"code":11115,"msg":"prompt is too long: 2048000 tokens > 1048576 maximum"}',
        { status: 400 },
      );
    }) as typeof fetch;

    const result = await probeUpstreamGate({
      provider: provider("anthropic", "https://example.test"),
      modelId: "some-model",
      apiKey: "k",
      targetTokens: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.limit).toBe(1_048_576);
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.attempts[0]?.status).toBe(400);
    expect(result.attempts[0]?.reportedTokens).toBe(2_048_000);
    // The body we sent is what the upstream counted.
    expect(seen).toContain("some-model");
    expect(seen).toContain("max_tokens");
  });

  test("an acceptance is a lower bound, not a ceiling, and we stop there", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ usage: { input_tokens: 900_000 } }), { status: 200 });
    }) as typeof fetch;

    const result = await probeUpstreamGate({
      provider: provider("openai-chat", "https://example.test/v1"),
      modelId: "m",
      apiKey: "k",
      targetTokens: 500,
    });

    expect(result.ok).toBe(false);
    expect(result.lowerBound).toBe(900_000);
    expect(result.attempts[0]?.outcome).toBe("accepted");
    // One request only: doubling into a bill is not what we do.
    expect(calls).toBe(1);
  });

  test("a 429 teaches us nothing and says so", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;

    const result = await probeUpstreamGate({
      provider: provider("anthropic", "https://example.test"),
      modelId: "m",
      apiKey: "k",
      targetTokens: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.limit).toBeUndefined();
    expect(result.attempts[0]?.outcome).toBe("unknown");
    expect(result.error).toContain("429");
  });

  test("a refusal without a usable number is reported, never guessed", async () => {
    globalThis.fetch = (async () => new Response(
      '{"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"}}',
      { status: 400 },
    )) as typeof fetch;

    const result = await probeUpstreamGate({
      provider: provider("anthropic", "https://example.test"),
      modelId: "m",
      apiKey: "k",
      targetTokens: 100,
    });

    expect(result.ok).toBe(false);
    // (2013) is not a token count, so it must not become the ceiling.
    expect(result.limit).toBeUndefined();
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.error).toContain("did not name a ceiling");
  });

  test("the request never grows past the hard ceiling", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const result = await probeUpstreamGate({
      provider: provider("anthropic", "https://example.test"),
      modelId: "m",
      apiKey: "k",
      learnedLimit: 99_000_000,
    });
    expect(result.attempts[0]?.targetTokens).toBe(GATE_PROBE_MAX_TARGET_TOKENS);
  });

  test("an adapter we cannot speak to is refused before any request goes out", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await probeUpstreamGate({
      provider: provider("google", "https://example.test"),
      modelId: "m",
      apiKey: "k",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("google");
    expect(called).toBe(false);
  });
});
