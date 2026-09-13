import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-first-000111222333" },
      "minnimax-chat": { adapter: "anthropic", baseUrl: "https://minnimax.chat/", apiKey: "" },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-keys-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-keys-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("provider API key pool", () => {
  test("GET seeds legacy bare apiKey into a one-entry pool with masked value", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeId: string | null; keys: Array<{ id: string; masked: string; active: boolean }> };
      expect(body.keys.length).toBe(1);
      expect(body.keys[0]!.active).toBe(true);
      expect(body.keys[0]!.masked.includes("****")).toBe(true);
      expect(JSON.stringify(body).includes("key-first-000111222333")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("POST adds + activates; PUT switches; DELETE removes and promotes", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777" }),
      });
      expect(add.status).toBe(201);
      const { id: secondId } = await add.json() as { id: string };

      let list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { activeId: string; keys: Array<{ id: string; active: boolean }> };
      expect(list.keys.length).toBe(2);
      expect(list.activeId).toBe(secondId); // new key becomes active

      // config.json mirrors the active key into apiKey
      const cfg = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg.providers["opencode-go"].apiKey).toBe("key-second-444555666777");

      const firstId = list.keys.find(k => k.id !== secondId)!.id;
      const put = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: firstId }),
      });
      expect(put.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.activeId).toBe(firstId);

      // Remove the active key: the other one is promoted.
      const del = await fetch(new URL(`/api/providers/keys?name=opencode-go&id=${firstId}`, server.url), { method: "DELETE" });
      expect(del.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.keys.length).toBe(1);
      expect(list.activeId).toBe(secondId);
      const cfg2 = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg2.providers["opencode-go"].apiKey).toBe("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider 404; empty key 400", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys?name=nope", server.url));
      expect(missing.status).toBe(404);
      const bad = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/providers/keys/reveal returns full key (audit logs only id)", async () => {
    const server = startServer(0);
    try {
      // Seed a second key so we have something to reveal.
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777", label: "second" }),
      });
      const { id: secondId } = await add.json() as { id: string };

      const reveal = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: secondId }),
      });
      expect(reveal.status).toBe(200);
      const body = await reveal.json() as { id: string; label?: string; masked: string; key: string };
      expect(body.id).toBe(secondId);
      expect(body.label).toBe("second");
      expect(body.masked).toBe("key-****6777");
      expect(body.key).toBe("key-second-444555666777");

      // Env-referenced keys are exposed verbatim (mask already returns the literal).
      const seedEnv = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "${MY_ENV_VAR}" }),
      });
      const { id: envId } = await seedEnv.json() as { id: string };
      const envReveal = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: envId }),
      });
      expect(envReveal.status).toBe(200);
      const envBody = await envReveal.json() as { key: string };
      expect(envBody.key).toBe("${MY_ENV_VAR}");
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/providers/keys/reveal rejects bad inputs", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "nope", id: "x" }),
      });
      expect(missing.status).toBe(404);

      const noId = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go" }),
      });
      expect(noId.status).toBe(400);

      const noKey = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: "deadbeef" }),
      });
      expect(noKey.status).toBe(404);

      const badJson = await fetch(new URL("/api/providers/keys/reveal", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(badJson.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/providers/keys/test returns ok=true when upstream /models returns 200", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      // Only intercept the openai-chat /models probe; let everything else (e.g. the local server)
      // pass through unchanged.
      if (url.includes("/v1/models") || url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input as Request | string | URL, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "test-key-aaaaaaaaaaaaa" }),
      });
      const { id } = await add.json() as { id: string };

      const test = await fetch(new URL("/api/providers/keys/test", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id }),
      });
      expect(test.status).toBe(200);
      const body = await test.json() as { ok: boolean | "unknown"; latencyMs: number };
      expect(body.ok).toBe(true);
      expect(typeof body.latencyMs).toBe("number");
      expect(calls.some(c => c.endsWith("/models"))).toBe(true);
    } finally {
      await server.stop(true);
      globalThis.fetch = realFetch;
    }
  });

  test("POST /api/providers/keys/test returns ok=false on 401", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/models")) return new Response("unauthorized", { status: 401 });
      return realFetch(input as Request | string | URL, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "bad-key-bbbbbbbbbbbbb" }),
      });
      const { id } = await add.json() as { id: string };

      const test = await fetch(new URL("/api/providers/keys/test", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id }),
      });
      const body = await test.json() as { ok: boolean | "unknown" };
      expect(body.ok).toBe(false);
    } finally {
      await server.stop(true);
      globalThis.fetch = realFetch;
    }
  });

  test("POST /api/providers/keys/test rejects env-referenced keys", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "${MY_ENV_VAR}" }),
      });
      const { id } = await add.json() as { id: string };

      const test = await fetch(new URL("/api/providers/keys/test", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id }),
      });
      expect(test.status).toBe(400);
      const body = await test.json() as { error: string };
      expect(body.error).toMatch(/env/);
    } finally {
      await server.stop(true);
    }
  });

  test("POST /api/providers/keys/test routes to /v1/usage for minimax.chat reverse proxy", async () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      // Match /v1/usage (minimax.chat probe) — return 200 OK.
      // Match /v1/messages — would be a bug, fail the test if hit.
      if (url.endsWith("/v1/usage") && method === "GET") {
        return new Response(JSON.stringify({ rolling_5h: { used: 0 }, weekly: { used: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/messages")) {
        throw new Error(`/v1/messages should not be probed for minimax.chat (got call #${calls.length})`);
      }
      return realFetch(input as Request | string | URL, init);
    }) as typeof fetch;

    // Configure a provider whose baseUrl matches the minimax.chat reverse-proxy detector
    // (any name, any id — detection is baseUrl-driven).
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "minnimax-chat", key: "live-key-zzzzzzzzzzzz" }),
      });
      const { id } = await add.json() as { id: string };

      const test = await fetch(new URL("/api/providers/keys/test", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "minnimax-chat", id }),
      });
      expect(test.status).toBe(200);
      const body = await test.json() as { ok: boolean | "unknown"; latencyMs: number };
      expect(body.ok).toBe(true);
      expect(calls.some(c => c.url.endsWith("/v1/usage") && c.method === "GET")).toBe(true);
      expect(calls.some(c => c.url.endsWith("/v1/messages"))).toBe(false);
    } finally {
      await server.stop(true);
      globalThis.fetch = realFetch;
    }
  });

  test("POST /api/providers/keys/test returns ok=false when minimax.chat /v1/usage returns 401", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/usage")) return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Invalid API key" } }), { status: 401 });
      return realFetch(input as Request | string | URL, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "minnimax-chat", key: "revoked-key-rrrrrrrrrrr" }),
      });
      const { id } = await add.json() as { id: string };

      const test = await fetch(new URL("/api/providers/keys/test", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "minnimax-chat", id }),
      });
      const body = await test.json() as { ok: boolean | "unknown" };
      expect(body.ok).toBe(false);
    } finally {
      await server.stop(true);
      globalThis.fetch = realFetch;
    }
  });
});
