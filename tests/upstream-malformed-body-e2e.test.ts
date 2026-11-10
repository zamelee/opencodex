/**
 * End-to-end: an upstream that answers "I received a body that is not valid
 * JSON" must not kill the turn.
 *
 * OUR body is built by JSON.stringify, so it is valid JSON by construction.
 * The refusal comes from a relay that mangled the body on the way out, and it
 * is transient - the same conversation succeeds seconds later. Passing it
 * through as a 400 is fatal to the conversation in Codex, so the proxy
 * retries on a fresh connection and only reports a server fault if the
 * upstream keeps refusing.
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

const MALFORMED_BODY = JSON.stringify({
  error: {
    type: "invalid_request",
    message: "Request body must be a valid JSON object. (request id: 202611101155375552668738268d9d6OAkJoKoz)",
  },
  type: "error",
});

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-malformed-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-malformed-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
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

function makeConfig(): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
    providers: {
      pooled: {
        adapter: "openai-chat",
        baseUrl: `http://127.0.0.1:${upstream!.port}/v1`,
        apiKey: "key-alpha-000111222333",
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

describe("an upstream that refuses a body as invalid JSON (end-to-end)", () => {
  test("the turn survives a single mangled-body refusal", async () => {
    let hits = 0;
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        hits += 1;
        if (hits === 1) {
          return new Response(MALFORMED_BODY, { status: 400, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          id: "chatcmpl-1", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok after resend" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    saveConfig(makeConfig());
    const server = startServer(0);
    try {
      const res = await post(server);
      expect(res.status).toBe(200);
      expect(hits).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a persistent refusal ends as a server fault, not a fatal 400", async () => {
    let hits = 0;
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        hits += 1;
        return new Response(MALFORMED_BODY, { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    saveConfig(makeConfig());
    const server = startServer(0);
    try {
      const res = await post(server);
      // 502: a server fault Codex can retry. A 400 would kill the conversation.
      expect(res.status).toBe(502);
      expect(hits).toBe(4);
      const error = res.body.error as { message?: string };
      expect(error?.message).toContain("malformed");
    } finally {
      server.stop(true);
    }
  });
});
