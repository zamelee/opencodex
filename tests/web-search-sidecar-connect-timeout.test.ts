import { describe, expect, test } from "bun:test";
import { planWebSearch } from "../src/web-search";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    defaultProvider: "m.aiio.chat",
    providers: {
      "m.aiio.chat": {
        adapter: "anthropic",
        baseUrl: "https://m.aiio.chat",
        apiKey: "k",
      },
      chatgpt: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    ...overrides,
  } as unknown as OcxConfig;
}

function optedInConfig(): OcxConfig {
  const cfg = config();
  (cfg.providers["m.aiio.chat"] as { supportsSearchTool?: boolean }).supportsSearchTool = true;
  return cfg;
}

function parsed(): OcxParsedRequest {
  return { _webSearch: { type: "web_search" } } as unknown as OcxParsedRequest;
}

describe("the web-search sidecar gets its own header budget", () => {
  test("the sidecar only runs for a provider that opted in", () => {
    const notOptedIn = planWebSearch(
      config(),
      parsed(),
      false,
      new Headers({ authorization: "Bearer x" }),
      config().providers["m.aiio.chat"],
      "MiniMax-M3.1-Flash-Preview",
    );
    expect(notOptedIn).toBeUndefined();

    const optedIn = planWebSearch(
      optedInConfig(),
      parsed(),
      false,
      new Headers({ authorization: "Bearer x" }),
      optedInConfig().providers["m.aiio.chat"],
      "MiniMax-M3.1-Flash-Preview",
    );
    expect(optedIn).toBeDefined();
  });

  test("the routed model's call inside the sidecar is capped at 90s, not the global 200s", () => {
    const cfg = optedInConfig();
    const plan = planWebSearch(
      cfg,
      parsed(),
      false,
      new Headers({ authorization: "Bearer x" }),
      cfg.providers["m.aiio.chat"],
      "MiniMax-M3.1-Flash-Preview",
    );
    expect(plan).toBeDefined();
    expect(plan!.connectTimeoutMs).toBe(90_000);
  });

  test("a configured value wins, and the global connect timeout still caps it", () => {
    const withCfg = optedInConfig();
    Object.assign(withCfg, {
      webSearchSidecar: { connectTimeoutMs: 45_000 },
    } as Partial<OcxConfig>);
    const plan = planWebSearch(
      withCfg,
      parsed(),
      false,
      new Headers({ authorization: "Bearer x" }),
      withCfg.providers["m.aiio.chat"],
      "MiniMax-M3.1-Flash-Preview",
    );
    expect(plan!.connectTimeoutMs).toBe(45_000);

    const global30s = optedInConfig();
    Object.assign(global30s, { connectTimeoutMs: 30_000 } as Partial<OcxConfig>);
    const plan2 = planWebSearch(
      global30s,
      parsed(),
      false,
      new Headers({ authorization: "Bearer x" }),
      global30s.providers["m.aiio.chat"],
      "MiniMax-M3.1-Flash-Preview",
    );
    expect(plan2!.connectTimeoutMs).toBe(30_000);
  });
});
