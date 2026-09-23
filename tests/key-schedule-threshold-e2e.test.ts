import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyScheduleState } from "../src/providers/key-scheduler";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * End-to-end for the PATCH /api/providers/key-schedule endpoint that drives the
 * quota-aware scheduler threshold from the GUI. Confirms input validation
 * ([0.5, 0.99]) and that a successful patch persists + returns the updated
 * getKeyScheduleState body.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-thresh-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-thresh-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyScheduleState();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearKeyScheduleState();
});

function makePoolConfig(): OcxConfig {
  const cfg: OcxConfig = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "pooled",
    providers: {
      pooled: {
        adapter: "anthropic",
        baseUrl: "https://m.aiio.chat/",
        apiKey: "key-alpha-000111222333",
        apiKeyPool: [
          { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
          { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
        ],
      },
    },
  } as OcxConfig;
  saveConfig(cfg);
  return cfg;
}

describe("PATCH /api/providers/key-schedule", () => {
  test("updates threshold, persists, returns updated state", async () => {
    makePoolConfig();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.7 }),
      });
      expect(res.status).toBe(200);
      const state = await res.json() as { threshold: number; enabled?: boolean };
      expect(state.threshold).toBeCloseTo(0.7, 5);
      // Confirm persistence by reading the config back via /api/config.
      const configRes = await fetch(new URL("/api/config", server.url));
      const cfg = await configRes.json() as { providers: { pooled: { keySchedule?: { threshold?: number } } } };
      expect(cfg.providers.pooled.keySchedule?.threshold).toBeCloseTo(0.7, 5);
        // Round-trip via /api/providers/key-schedule to confirm the state is the
        // source of truth the GUI consumes.
        const stateRes = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url));
        const state2 = await stateRes.json() as { threshold: number };
        expect(state2.threshold).toBeCloseTo(0.7, 5);
    } finally {
      server.stop(true);
    }
  });

  test("rejects threshold out of [0.5, 0.99] range", async () => {
    makePoolConfig();
    const server = startServer(0);
    try {
      // Inclusive bounds: 0.5 and 0.99 are accepted; only values strictly outside
      // [0.5, 0.99] are rejected. NaN and non-numeric strings are also rejected.
      for (const bad of [0.1, 0.499, 0.991, 1.5, -0.5, NaN, "abc"]) {
        const res = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threshold: bad }),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      server.stop(true);
    }
  });

  test("rejects unknown provider", async () => {
    makePoolConfig();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/key-schedule?name=does-not-exist", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.8 }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("rejects empty body", async () => {
    makePoolConfig();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("toggles enabled flag", async () => {
    makePoolConfig();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const state = await res.json() as { enabled?: boolean };
      expect(state.enabled).toBe(false);
      // And back to true.
      const res2 = await fetch(new URL("/api/providers/key-schedule?name=pooled", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res2.status).toBe(200);
      const state2 = await res2.json() as { enabled?: boolean };
      expect(state2.enabled).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
