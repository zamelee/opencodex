/**
 * End-to-end: an exhausted upstream balance must recover, not dead-end.
 *
 * The relays answer "no money left" with HTTP 403 and a body like
 * "用户额度不足, 剩余额度: ¥0.000000". The proxy must
 *   1. classify it as a quota problem (not a broken key),
 *   2. switch to another key in the pool - which is what actually recovers
 *      the turn, because each key carries its own balance,
 *   3. and only then fall back to a bounded wait-and-retry.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

const QUOTA_BODY = JSON.stringify({ error: { message: "用户额度不足, 剩余额度: ¥0.000000" } });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-quota-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-quota-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearKeyCooldowns();
});

function makeConfig(overrides: Partial<OcxConfig["providers"][string]> = {}): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
    providers: {
      pooled: {
        adapter: "openai-chat",
        baseUrl: `http://127.0.0.1:${upstream!.port}/v1`,
        apiKey: "key-alpha-000111222333",
        apiKeyPool: [
          { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
          { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
        ],
        ...overrides,
      },
    },
  } as OcxConfig;
}

async function post(server: { url: URL }): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pooled/some-model", input: "hello", stream: false }),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

describe("an exhausted upstream balance (end-to-end)", () => {
  test("the pool's next key takes over and the turn succeeds", async () => {
    const seenAuth: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        if (seenAuth.length === 1) {
          return new Response(QUOTA_BODY, { status: 403, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    saveConfig(makeConfig());
    const server = startServer(0);
    try {
      const res = await post(server);
      expect(res.status).toBe(200);
      expect(seenAuth).toEqual(["Bearer key-alpha-000111222333", "Bearer key-beta-444555666777"]);
    } finally {
      server.stop(true);
    }
  });

  test("with no other key left, the proxy waits, retries, and then reports the quota", async () => {
    let hits = 0;
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        hits += 1;
        return new Response(QUOTA_BODY, { status: 403, headers: { "content-type": "application/json" } });
      },
    });
    // A single-key provider: there is nothing to switch to, so the wait path runs.
    saveConfig(makeConfig({
      apiKeyPool: [{ id: "k1", key: "key-alpha-000111222333", addedAt: 1 }],
      quotaRetry: { enabled: true, intervalMs: 1000, maxAttempts: 2 },
    }));
    const server = startServer(0);
    try {
      const started = Date.now();
      const res = await post(server);
      const elapsed = Date.now() - started;
      // 403 + a quota body, NOT a 401-style credential failure.
      expect(res.status).toBe(403);
      const error = res.body.error as { code?: string; message?: string };
      expect(error?.code).toBe("insufficient_quota");
      expect(error?.message).toContain("额度不足");
      // It waited between the attempts instead of failing instantly.
      expect(hits).toBe(3);
      expect(elapsed).toBeGreaterThanOrEqual(1900);
    } finally {
      server.stop(true);
    }
  });

  test("the retry can be switched off", async () => {
    let hits = 0;
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        hits += 1;
        return new Response(QUOTA_BODY, { status: 403, headers: { "content-type": "application/json" } });
      },
    });
    saveConfig(makeConfig({
      apiKeyPool: [{ id: "k1", key: "key-alpha-000111222333", addedAt: 1 }],
      quotaRetry: { enabled: false },
    }));
    const server = startServer(0);
    try {
      const res = await post(server);
      expect(res.status).toBe(403);
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
