import { describe, test, expect } from "bun:test";
import { AUTH_STRATEGIES, buildAuthHeaders, defaultStrategiesFor, isReverseProxyProvider, parseModelIds } from "../src/providers/auth-matrix";
import type { OcxProviderConfig } from "../src/types";

describe("auth-matrix", () => {
  test("buildAuthHeaders produces correct headers per strategy", () => {
    expect(buildAuthHeaders("bearer", "k")).toEqual({
      Authorization: "Bearer k",
      Accept: "application/json",
    });
    expect(buildAuthHeaders("x-api-key", "k")).toEqual({
      "x-api-key": "k",
    });
    expect(buildAuthHeaders("x-api-key+anthropic-version", "k")).toEqual({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    });
  });

  test("isReverseProxyProvider matches m.aiio.chat + minimax.chat", () => {
    expect(isReverseProxyProvider("https://m.aiio.chat/v1")).toBe(true);
    expect(isReverseProxyProvider("https://minnimax.chat/v1")).toBe(true);
    expect(isReverseProxyProvider("https://baollm.rqez.cn/v1")).toBe(false);
    expect(isReverseProxyProvider("https://api.openai.com/v1")).toBe(false);
    expect(isReverseProxyProvider("")).toBe(false);
  });

  test("defaultStrategiesFor: explicit modelListAuth wins", () => {
    const p: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://example.com/v1",
      modelListAuth: "x-api-key",
    };
    expect(defaultStrategiesFor(p)).toEqual(["x-api-key"]);
  });

  test("defaultStrategiesFor: reverse proxy uses x-api-key only (preserve old behavior)", () => {
    const p: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://m.aiio.chat/v1",
    };
    expect(defaultStrategiesFor(p)).toEqual(["x-api-key"]);
  });

  test("defaultStrategiesFor: non-reverse-proxy prefers Bearer first", () => {
    const p: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://baollm.rqez.cn/v1",
    };
    expect(defaultStrategiesFor(p)).toEqual(["bearer", "x-api-key+anthropic-version", "x-api-key"]);
  });

  test("parseModelIds handles OpenAI data[] shape", () => {
    expect(parseModelIds({ data: [{ id: "gpt-5" }, { id: "gpt-4" }, {}] })).toEqual(["gpt-5", "gpt-4"]);
  });

  test("parseModelIds handles Anthropic models[] shape", () => {
    expect(parseModelIds({ models: [{ id: "claude-opus" }, { name: "models/claude-haiku" }] }))
      .toEqual(["claude-opus", "claude-haiku"]);
  });

  test("parseModelIds returns [] for non-object / missing arrays", () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds("str")).toEqual([]);
    expect(parseModelIds({ data: "not-array" })).toEqual([]);
  });

  test("AUTH_STRATEGIES has 3 entries in the right order (Bearer first)", () => {
    expect(AUTH_STRATEGIES.length).toBe(3);
    expect(AUTH_STRATEGIES[0]).toBe("bearer");
    expect(AUTH_STRATEGIES[1]).toBe("x-api-key+anthropic-version");
    expect(AUTH_STRATEGIES[2]).toBe("x-api-key");
  });
});
