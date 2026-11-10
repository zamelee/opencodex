/**
 * "The balance is empty" is not "the key is broken".
 *
 * The relays answer an exhausted balance with HTTP 403 and a body like
 * "预扣费额度失败, 用户剩余额度: ¥0.000000". That refusal is classified as an
 * exhausted balance, recovers by switching to another key in the pool (each
 * key carries its own balance), and only then falls back to a bounded
 * wait-and-retry.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUOTA_RETRY,
  isQuotaExhausted,
  isQuotaExhaustedBody,
  resolveQuotaRetryPolicy,
  sleepWithAbort,
} from "../src/providers/quota-retry";
import { classifyError } from "../src/lib/errors";
import { requestLogErrorCode } from "../src/server/request-log";

describe("isQuotaExhausted", () => {
  test("recognizes the upstream shapes we actually saw", () => {
    expect(isQuotaExhausted(403, "预扣费额度失败, 用户剩余额度: ¥0.000000")).toBe(true);
    expect(isQuotaExhausted(403, "用户额度不足, 剩余额度: ¥0.000000")).toBe(true);
    expect(isQuotaExhausted(403, '{"error":{"message":"用户额度不足"}}')).toBe(true);
    expect(isQuotaExhausted(429, "insufficient_quota")).toBe(true);
  });

  test("a credential refusal is not a quota refusal", () => {
    expect(isQuotaExhausted(401, "invalid api key")).toBe(false);
    expect(isQuotaExhausted(403, "invalid_api_key: 剩余额度 unknown")).toBe(false);
    expect(isQuotaExhausted(403, "unauthorized")).toBe(false);
  });

  test("other statuses and other reasons are not quota", () => {
    expect(isQuotaExhausted(500, "Provider unreachable")).toBe(false);
    expect(isQuotaExhausted(403, "model not allowed in your plan")).toBe(false);
    expect(isQuotaExhausted(403, null)).toBe(false);
  });

  test("isQuotaExhaustedBody does not fire on a rate limit", () => {
    expect(isQuotaExhaustedBody("rate limit exceeded")).toBe(false);
  });
});

describe("classifyError", () => {
  test("an exhausted balance is a quota error, not an invalid key", () => {
    expect(classifyError(403, "upstream_error", "用户额度不足, 剩余额度: ¥0.000000")).toMatchObject({
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
  });

  test("a real credential failure still reads as one", () => {
    expect(classifyError(403, "upstream_error", "invalid api key").code).toBe("invalid_api_key");
  });
});

describe("requestLogErrorCode", () => {
  test("a 403 about the balance is logged as a quota problem", () => {
    expect(requestLogErrorCode(403, "用户额度不足, 剩余额度: ¥0.000000")).toBe("insufficient_quota");
  });

  test("a 403 without a balance hint stays a credential problem", () => {
    expect(requestLogErrorCode(403, "invalid api key")).toBe("invalid_api_key");
  });
});

describe("resolveQuotaRetryPolicy", () => {
  test("defaults to enabled, 20s, 3 attempts", () => {
    expect(resolveQuotaRetryPolicy(undefined)).toEqual(DEFAULT_QUOTA_RETRY);
    expect(resolveQuotaRetryPolicy({})).toEqual(DEFAULT_QUOTA_RETRY);
  });

  test("clamps nonsense", () => {
    expect(resolveQuotaRetryPolicy({ quotaRetry: { intervalMs: 999_999 } }).intervalMs).toBe(30_000);
    expect(resolveQuotaRetryPolicy({ quotaRetry: { intervalMs: 1 } }).intervalMs).toBe(1_000);
    // 5 attempts x the default 20s would hold the client for 100s, so the
    // 90s total-wait budget trims it to 4.
    expect(resolveQuotaRetryPolicy({ quotaRetry: { maxAttempts: 99 } }).maxAttempts).toBe(4);
    expect(resolveQuotaRetryPolicy({ quotaRetry: { intervalMs: 5_000, maxAttempts: 99 } }).maxAttempts).toBe(5);
    expect(resolveQuotaRetryPolicy({ quotaRetry: { enabled: false } }).enabled).toBe(false);
  });

  test("the total wait never exceeds the budget", () => {
    const policy = resolveQuotaRetryPolicy({ quotaRetry: { intervalMs: 30_000, maxAttempts: 5 } });
    expect(policy.intervalMs * policy.maxAttempts).toBeLessThanOrEqual(90_000);
  });
});

describe("sleepWithAbort", () => {
  test("resolves after the delay", async () => {
    const ac = new AbortController();
    const started = Date.now();
    expect(await sleepWithAbort(30, ac.signal)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("wakes up when the client goes away", async () => {
    const ac = new AbortController();
    const pending = sleepWithAbort(10_000, ac.signal);
    ac.abort();
    expect(await pending).toBe(false);
  });
});
