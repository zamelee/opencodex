/**
 * A content-policy refusal is NOT a server fault.
 *
 * The MiniMax-family upstreams answer it with HTTP 500 and a body like
 * `input new_sensitive (1026)`. Codex reads every 5xx as transient, so it
 * retried the same turn five times and finally showed "We're currently
 * experiencing high demand" -- hiding the real reason and spending quota on
 * every round.
 */
import { describe, expect, test } from "bun:test";
import { classifyError, httpStatusFromTerminalError, isContentPolicyRejection } from "../src/lib/errors";

describe("isContentPolicyRejection", () => {
  test("recognizes the upstream shapes we actually saw", () => {
    expect(isContentPolicyRejection("input new_sensitive (1026)")).toBe(true);
    expect(isContentPolicyRejection('{"error":{"message":"input new_sensitive (1026)"}}')).toBe(true);
    expect(isContentPolicyRejection("content moderation triggered")).toBe(true);
    expect(isContentPolicyRejection("内容审核不通过")).toBe(true);
    expect(isContentPolicyRejection("违规内容")).toBe(true);
  });

  test("does not fire on ordinary faults", () => {
    expect(isContentPolicyRejection("Provider unreachable: Unable to connect")).toBe(false);
    expect(isContentPolicyRejection("prompt is too long: 2010775 tokens > 1048576 maximum")).toBe(false);
    expect(isContentPolicyRejection("用户剩余额度: ¥0.000000")).toBe(false);
    expect(isContentPolicyRejection("")).toBe(false);
    expect(isContentPolicyRejection(null)).toBe(false);
  });
});

describe("classifyError", () => {
  test("a 500 content-policy refusal is classified as a caller error, not a server fault", () => {
    expect(classifyError(500, "upstream_error", "Provider error 500: input new_sensitive (1026)")).toMatchObject({
      type: "invalid_request_error",
      code: "content_policy_violation",
    });
  });

  test("an ordinary 500 stays a server error", () => {
    expect(classifyError(500, "upstream_error", "Provider error 500: Provider unreachable")).toMatchObject({
      type: "server_error",
      code: "upstream_server_error",
    });
  });
});

describe("httpStatusFromTerminalError", () => {
  test("a content-policy violation is a 400, so Codex stops retrying", () => {
    expect(httpStatusFromTerminalError({
      type: "invalid_request_error",
      code: "content_policy_violation",
      message: "上游内容审核拒绝",
    })).toBe(400);
  });
});
