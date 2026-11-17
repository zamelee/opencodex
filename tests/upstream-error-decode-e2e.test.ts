import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResolvedConfigDirCache, saveConfig } from "../src/config";
import {
  learnedUpstreamPromptLimit,
  resetLearnedUpstreamLimits,
} from "../src/lib/upstream-prompt-budget";
import { resetLearnedTokenScales, upstreamTokenScaleFactor } from "../src/lib/upstream-token-scale";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * End-to-end coverage for the decode that was missing on 2026-11-16.
 *
 * The upstream (a Go service) marshals its error message with HTML-safe escaping, so ">"
 * becomes the six characters `\u003e`; the message is then embedded in the outer envelope as
 * a STRING, which escapes that backslash a second time. The wire therefore carries
 * `\\u003e` - two backslashes.
 *
 * The old parser read the raw body with a regex after ONE unescape pass, which left a
 * stray backslash in front of ">" and made the pattern miss. The proxy then reported six
 * refusals that named no ceiling, learned no gate and no token scale, and kept sending a
 * 5M-token body at a 1M-token upstream.
 *
 * This test drives the REAL server against a REAL upstream that answers with exactly that
 * body, and requires the ceiling and the scale to come out of it.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;

/** The message the upstream marshals: ">" escaped once, as Go's encoder does. */
const GO_ESCAPED_MESSAGE =
  '{"code":11115,"msg":"prompt is too long: 5010629 tokens \\u003e 1048576 maximum",'
  + '"requestId":"df35bba01d08047aee83b57cd0739284","retry_policy":{"retry":false}}';

/** The body on the wire: the message is a string, so its backslash is escaped again. */
const DOUBLE_ENCODED_BODY = JSON.stringify({
  error: { type: "prompt_too_long", message: GO_ESCAPED_MESSAGE },
});

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-decode-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-decode-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearResolvedConfigDirCache();
  resetLearnedUpstreamLimits();
  resetLearnedTokenScales();
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
  clearResolvedConfigDirCache();
  resetLearnedUpstreamLimits();
  resetLearnedTokenScales();
});

describe("a doubly-encoded upstream refusal still teaches the brake (end-to-end)", () => {
  test("the ceiling and the token scale are learned from the 2026-11-16 body", async () => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        upstreamHits += 1;
        return new Response(DOUBLE_ENCODED_BODY, {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "double",
      providers: {
        double: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-decode-000111222333",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "double/some-model", input: "x".repeat(600_000), stream: false }),
      });
      expect(res.status).toBe(400);
      expect(upstreamHits).toBe(1);

      // The ceiling the upstream named, learned from a body that had it buried under two
      // levels of JSON encoding. Gates are model-scoped on purpose: one provider fronts
      // models with different windows.
      expect(learnedUpstreamPromptLimit("double", "some-model")).toBe(1_048_576);

      // And the ratio between the upstream's count and ours, so the NEXT request is braked
      // in the upstream's unit instead of being sent into the same wall.
      expect(upstreamTokenScaleFactor("double")).toBeGreaterThan(1.5);
    } finally {
      server.stop(true);
    }
  });
});
