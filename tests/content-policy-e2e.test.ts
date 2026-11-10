/**
 * End-to-end: a content-policy refusal must not look like a server fault.
 *
 * The upstream answers HTTP 500 with `input new_sensitive (1026)`. Codex treats
 * every 5xx as transient, so it retried the same turn five times and finally
 * showed "We're currently experiencing high demand" -- hiding the real reason
 * and spending quota on every round. The proxy has to answer 400 with the
 * upstream's own words so the turn fails ONCE.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-contentpolicy-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-contentpolicy-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
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
});

describe("a content-policy refusal (end-to-end)", () => {
  test("an upstream 500 about sensitive content becomes a 400 with the real reason", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        upstreamHits += 1;
        return new Response(JSON.stringify({
          error: { message: "input new_sensitive (1026)" },
        }), { status: 500, headers: { "content-type": "application/json" } });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "policy",
      providers: {
        policy: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-policy-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "policy/some-model", input: "hello", stream: false }),
      });
      const body = await res.json() as { error?: { code?: string; message?: string; type?: string } };

      // The status is the whole point: Codex retries 5xx, so a 400 is what stops
      // the five-round retry storm and the "high demand" message.
      expect(res.status).toBe(400);
      expect(body.error?.code).toBe("content_policy_violation");
      expect(body.error?.type).toBe("invalid_request_error");
      // The upstream's own words survive, so the operator can see WHY.
      expect(body.error?.message).toContain("input new_sensitive (1026)");
      expect(body.error?.message).toContain("内容审核");
      expect(upstreamHits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("an ordinary upstream 500 stays a 500", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        upstreamHits += 1;
        return new Response("upstream exploded", { status: 500 });
      },
    });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "policy",
      providers: {
        policy: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-policy-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "policy/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(500);
      expect(upstreamHits).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
