import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache, saveConfig } from "../src/config";
import { resetLearnedTokenScales, upstreamTokenScaleFactor } from "../src/lib/upstream-token-scale";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * End-to-end coverage for the calibration between our estimate and the upstream's count.
 *
 * The measured failure (2026-11-09, m.aiio.chat / MiniMax-M3.1-Flash): the upstream
 * refused with "prompt is too long: 2010775 tokens > 1048576 maximum" while our own
 * estimate for the same body was 498,000 tokens. The proxy therefore believed a doomed
 * 2M-token request was a harmless 500k one and forwarded it, every single time.
 *
 * Two things have to hold:
 *   1. the ceiling in that error is LEARNED (it is nested in a JSON string, where the
 *      ">" arrives escaped as the six characters backslash-u-003-e - a naive parse never
 *      sees it);
 *   2. the ratio between the upstream's count and our estimate is learned too, so the
 *      NEXT request is braked at the upstream's ceiling instead of being sent into the
 *      same wall.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;
let upstreamBodies: string[] = [];

/** A 1x1 PNG, base64. Small enough to keep the test fast, real enough to sniff. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * The upstream's refusal, byte-for-byte as the relay sent it on 2026-11-09.
 *
 * The message is a JSON string NESTED inside the error object, so the ">" arrives as the
 * six characters backslash-u-003-e. Building this fixture with JSON.stringify (as the
 * test server does) keeps that single level of escaping - which is exactly what the proxy
 * reads off the wire.
 */
const REAL_REFUSAL = {
  error: {
    type: "prompt_too_long",
    message: "{\"code\":11115,\"msg\":\"prompt is too long: 2010775 tokens \u003e 1048576 maximum\","
      + "\"requestId\":\"80187d212022e257ede0a627c8a3af25\",\"retry_policy\":{\"retry\":false}}",
  },
};

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-tokenscale-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-tokenscale-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearResolvedConfigDirCache();
  resetLearnedTokenScales();
  upstreamHits = 0;
  upstreamBodies = [];
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearResolvedConfigDirCache();
  resetLearnedTokenScales();
});

describe("the upstream's own numbers calibrate the brake (end-to-end)", () => {
  test("the ceiling and the token scale are both learned from one refusal", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        upstreamHits += 1;
        upstreamBodies.push(await req.text());
        return new Response(JSON.stringify(REAL_REFUSAL), {
          status: 400, headers: { "content-type": "application/json" },
        });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "scaled",
      providers: {
        scaled: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-scale-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    const post = async (input: string) => {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "scaled/some-model", input, stream: false }),
      });
      return { status: res.status, body: await res.json() as { error?: { code?: string; message?: string } } };
    };
    try {
      // A prompt our own meter calls ~200k tokens: against the upstream's 1,048,576
      // ceiling that looks safe, so the proxy sends it.
      const prompt = "x".repeat(600_000);
      const first = await post(prompt);
      expect(first.status).toBe(400);
      expect(first.body.error?.code).toBe("context_length_exceeded");
      expect(upstreamHits).toBe(1);

      // The refusal named the ceiling (1048576) AND the size it was asked to handle
      // (2010775). Both are learned: the ceiling as the gate, and the ratio between the
      // upstream's count and our estimate as the scale that puts the two in one unit.
      const factor = upstreamTokenScaleFactor("scaled");
      expect(factor).toBeGreaterThan(1.5);
      // 2010775 upstream tokens over our estimate of the same body is a 10x ratio; the
      // learned factor is capped so one odd refusal cannot wedge the proxy.
      expect(factor).toBe(8);
    } finally {
      server.stop(true);
    }
  });

  test("the learned scale makes the NEXT request smaller, so it can actually fit", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        upstreamHits += 1;
        const body = await req.text();
        upstreamBodies.push(body);
        if (upstreamHits === 1) {
          // The first request teaches the scale.
          return new Response(JSON.stringify(REAL_REFUSAL), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
        // The upstream now accepts anything under its own ceiling.
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "scaled",
      providers: {
        scaled: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-scale-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    const post = async (input: string) => {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "scaled/some-model", input, stream: false }),
      });
      return { status: res.status, body: await res.json() as { error?: { code?: string } } };
    };
    try {
      // The body carries an image: that is what the brake can degrade. A pure-text body
      // has nothing to give up, which is why the upstream's own number is the only thing
      // that can save it - and why the refusal is worth learning from.
      const withImage = {
        model: "scaled/some-model",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "x".repeat(600_000) },
            { type: "input_image", image_url: "data:image/png;base64," + PNG_1PX },
          ],
        }],
        stream: false,
      };
      const postImage = async () => {
        const res = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(withImage),
        });
        return { status: res.status, body: await res.json() as { error?: { code?: string } } };
      };

      await postImage();
      expect(upstreamHits).toBe(1);
      const firstBody = upstreamBodies[0].length;

      // The second request is braked with the scale the first one taught us: our estimate
      // is multiplied into the upstream's unit, so the brake sees the real size and
      // degrades the request until it fits under 1,048,576 upstream tokens.
      const second = await postImage();
      expect(second.status).toBe(200);
      expect(upstreamHits).toBe(2);
      // The body the upstream received the second time is SMALLER than the first one.
      expect(upstreamBodies[1].length).toBeLessThan(firstBody);
    } finally {
      server.stop(true);
    }
  });
});
