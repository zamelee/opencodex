import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import {
  _setProbeForTests,
  clearKeyScheduleState,
} from "../src/providers/key-scheduler";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * End-to-end for the quota-aware scheduler (src/providers/key-scheduler.ts): the probe is
 * stubbed in-process, the upstream generation call is intercepted via globalThis.fetch so
 * the fake "m.aiio.chat" base URL never hits the network.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-keysched-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keysched-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  originalFetch = globalThis.fetch;
  clearKeyCooldowns();
  clearKeyScheduleState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setProbeForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearKeyCooldowns();
  clearKeyScheduleState();
});

function quotaKey(id: string, fiveHourUsed: number) {
  return {
    id, masked: "gw-****", active: false, source: "test", updatedAt: Date.now(),
    fiveHourUsed, fiveHourLimit: 2500,
  };
}

describe("server quota-aware key scheduling (end-to-end)", () => {
  test("saturated active key rotates BEFORE dispatch; state endpoint reports the event", async () => {
    const seenAuth: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("m.aiio.chat")) {
        seenAuth.push(new Request(input, init).headers.get("authorization") ?? "");
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok on rotated key" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    _setProbeForTests(async () => [
      quotaKey("k1", 2500), // saturated → gate trips
      quotaKey("k2", 100),  // headroom → rotates here
    ]);

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
      providers: {
        pooled: {
          adapter: "openai-chat",
          baseUrl: "https://m.aiio.chat/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(200);
      // Pending-mode semantics: maybeRotateForQuota stages pendingKeyChange instead of
      // mutating provider.apiKey. Non-streaming requests don't go through trackStreamLifetime,
      // so the commit happens at the start of the NEXT request (Location E in responses.ts).
      // First request still uses the old key; only the second request uses the rotated one.
      expect(seenAuth[0]).toBe("Bearer key-alpha-000111222333");
      // Issue a second request — Location E force-commits the pendingKeyChange, so this
      // request now sees the rotated key.
      const res2 = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/some-model", input: "hello again", stream: false }),
      });
      expect(res2.status).toBe(200);
      expect(seenAuth[1]).toBe("Bearer key-beta-444555666777");

      const sched = await originalFetch(new URL("/api/providers/key-schedule?name=pooled", server.url));
      expect(sched.status).toBe(200);
      const state = await sched.json() as {
        enabled: boolean; threshold: number; activeId: string | null;
        nextUpId: string | null; events: Array<{ fromId: string; toId: string; reason: string }>;
      };
      expect(state.enabled).toBe(true);
      expect(state.activeId).toBe("k2");
      expect(state.nextUpId).toBeNull(); // k1 still saturated → no eligible standby
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({ fromId: "k1", toId: "k2", reason: "5h-threshold" });
    } finally {
      server.stop(true);
    }
  });

  test("healthy active key dispatches untouched and records no rotation", async () => {
    const seenAuth: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("m.aiio.chat")) {
        seenAuth.push(new Request(input, init).headers.get("authorization") ?? "");
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok on same key" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    _setProbeForTests(async () => [quotaKey("k1", 1000), quotaKey("k2", 100)]);

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
      providers: {
        pooled: {
          adapter: "openai-chat",
          baseUrl: "https://m.aiio.chat/v1",
          apiKey: "key-alpha-000111222333",
          apiKeyPool: [
            { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
            { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
          ],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      // Cold server, zero requests: the endpoint itself warms the probe so the next-up
      // badge is meaningful on page load (regression: used to report nextUpId=null).
      const early = await originalFetch(new URL("/api/providers/key-schedule?name=pooled", server.url));
      const earlyState = await early.json() as { nextUpId: string | null };
      expect(earlyState.nextUpId).toBe("k2");
      expect(seenAuth).toHaveLength(0); // warming must not dispatch any generation call

      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pooled/some-model", input: "hello", stream: false }),
      });
      expect(res.status).toBe(200);
      expect(seenAuth).toEqual(["Bearer key-alpha-000111222333"]);

      const sched = await originalFetch(new URL("/api/providers/key-schedule?name=pooled", server.url));
      const state = await sched.json() as { activeId: string | null; nextUpId: string | null; events: unknown[] };
      expect(state.activeId).toBe("k1");
      expect(state.nextUpId).toBe("k2"); // standby ranked and visible to the UI badge
      expect(state.events).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });
});
