import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { resetGateCircuit } from "../src/lib/upstream-gate-circuit";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * End-to-end coverage for the compaction loop.
 *
 * The upstream refuses every over-long request with "prompt is too long: N tokens > M
 * maximum". Codex's answer is to compact and retry - and when the compacted history is still
 * over the ceiling, that loop never ends. The proxy has to break it, and it may only do so
 * on the upstream's evidence, never on a guess of its own.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-gatecircuit-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-gatecircuit-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  resetGateCircuit();
  upstreamHits = 0;
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  resetGateCircuit();
});

/** A prompt big enough that our own meter puts it well above the gate. */
const HUGE_PROMPT = "x".repeat(600_000);

describe("the gate circuit (end-to-end)", () => {
  test("a compaction loop is broken locally instead of being retried forever", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        upstreamHits += 1;
        return new Response(JSON.stringify({
          error: {
            type: "prompt_too_long",
            message: "prompt is too long: 1580773 tokens > 1048576 maximum",
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "looping",
      providers: {
        looping: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-loop-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    const post = async () => {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "looping/some-model", input: HUGE_PROMPT, stream: false }),
      });
      return { status: res.status, body: await res.json() as { error?: { code?: string; message?: string } } };
    };
    try {
      // The first refusals are passed through: the upstream is the only authority on its
      // own window, and Codex must be allowed to compact.
      const first = await post();
      expect(first.status).toBe(400);
      expect(first.body.error?.code).toBe("context_length_exceeded");
      expect(upstreamHits).toBe(1);

      await post();
      await post();
      expect(upstreamHits).toBe(3);

      // The circuit is armed now: the next request of the same size is refused locally, so
      // the loop ends instead of burning upstream quota forever.
      const blocked = await post();
      expect(blocked.status).toBe(400);
      expect(blocked.body.error?.code).toBe("upstream_context_gate_blocked");
      expect(upstreamHits).toBe(3);
      expect(blocked.body.error?.message).toContain("1048576");
    } finally {
      server.stop(true);
    }
  });

  test("a small request is still forwarded while the circuit is hot", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        upstreamHits += 1;
        if (upstreamHits <= 3) {
          return new Response(JSON.stringify({
            error: { type: "prompt_too_long", message: "prompt is too long: 1580773 tokens > 1048576 maximum" },
          }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "looping",
      providers: {
        looping: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-loop-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    const post = async (input: string) => {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "looping/some-model", input, stream: false }),
      });
      return { status: res.status, body: await res.json() as { error?: { code?: string } } };
    };
    try {
      await post(HUGE_PROMPT);
      await post(HUGE_PROMPT);
      await post(HUGE_PROMPT);

      // A DIFFERENT conversation with a small prompt: it must still get through.
      const small = await post("hello");
      expect(small.status).toBe(200);
      expect(upstreamHits).toBe(4);
    } finally {
      server.stop(true);
    }
  });
});
