import { describe, expect, test } from "bun:test";
import {
  isMalformedBodyRefusal,
  MALFORMED_BODY_MAX_ATTEMPTS,
} from "../src/lib/upstream-malformed-body";

describe("isMalformedBodyRefusal", () => {
  test("recognises the relay/gateway refusal we saw in the field", () => {
    const body = JSON.stringify({
      error: {
        type: "invalid_request",
        message: "Request body must be a valid JSON object. (request id: 202611101155375552668738268d9d6OAkJoKoz)",
      },
      type: "error",
    });
    expect(isMalformedBodyRefusal(400, body)).toBe(true);
  });

  test("ignores an ordinary invalid-request refusal", () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "max_tokens: must be greater than thinking.budget_tokens" },
    });
    expect(isMalformedBodyRefusal(400, body)).toBe(false);
  });

  test("ignores a quota refusal", () => {
    const body = JSON.stringify({
      error: { message: "预扣费额度失败, 用户剩余额度: ¥0.000000" },
    });
    expect(isMalformedBodyRefusal(403, body)).toBe(false);
  });

  test("only applies to 4xx statuses", () => {
    const body = "Request body must be a valid JSON object.";
    expect(isMalformedBodyRefusal(500, body)).toBe(false);
    expect(isMalformedBodyRefusal(200, body)).toBe(false);
  });

  test("handles an empty body", () => {
    expect(isMalformedBodyRefusal(400, "")).toBe(false);
    expect(isMalformedBodyRefusal(400, null)).toBe(false);
  });

  test("the retry budget is bounded", () => {
    expect(MALFORMED_BODY_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(MALFORMED_BODY_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
