import { describe, expect, test } from "bun:test";
import {
  ERROR_DECODE_MAX_BODY_CHARS,
  ERROR_DECODE_MAX_DEPTH,
  isSizeRejection,
  normalizeUpstreamError,
} from "../src/lib/upstream-error-normalize";
import { parseUpstreamPromptGate, parseUpstreamRejection } from "../src/lib/upstream-prompt-budget";

/**
 * Build the body the way the upstream builds it.
 *
 * The upstream is a Go service: `json.Marshal` escapes ">" as the six characters `\u003e`
 * (HTML-safety escaping), and the inner error object is then embedded in the outer envelope
 * as a STRING, so the envelope's own encoding escapes that backslash a second time. The
 * result on the wire is `\\u003e` - two backslashes - which is exactly what defeated the
 * old single-unescape regex.
 */
function buildUpstreamBody(inner: unknown, type?: string): string {
  const escaped = JSON.stringify(inner).replace(/>/g, "\\u003e");
  return JSON.stringify({ error: { type, message: escaped } });
}

/** The body that broke the brake on 2026-11-16, shaped like the upstream's. */
const INCIDENT_BODY = buildUpstreamBody(
  {
    code: 11115,
    msg: "prompt is too long: 5010629 tokens > 1048576 maximum",
    requestId: "df35bba01d08047aee83b57cd0739284",
    retry_policy: { max: 1 },
  },
  "prompt_too_long",
);

/** The same body with ONE level of encoding - the shape the old parser did understand. */
const SINGLE_ESCAPED_BODY = JSON.stringify({
  error: {
    type: "prompt_too_long",
    message: '{"code":11115,"msg":"prompt is too long: 2010775 tokens \\u003e 1048576 maximum"}',
  },
});

describe("upstream error normalization (the decode the brake was missing)", () => {
  test("reads both numbers out of the doubly-encoded incident body", () => {
    const normalized = normalizeUpstreamError(INCIDENT_BODY);
    expect(normalized.family).toBe("prompt_too_long");
    expect(normalized.familySource).toBe("structured");
    expect(normalized.contextLimit).toBe(1_048_576);
    expect(normalized.observedTokens).toBe(5_010_629);
    expect(normalized.providerCode).toBe(11115);
    expect(normalized.classificationConflict).toBe(false);
  });

  test("the same body now yields a gate through the old public API", () => {
    expect(parseUpstreamPromptGate(INCIDENT_BODY)).toEqual({
      limit: 1_048_576,
      observedInputTokens: 5_010_629,
    });
    expect(parseUpstreamRejection(INCIDENT_BODY)).toMatchObject({
      rejected: true,
      rejectedWithoutLimit: false,
      limit: 1_048_576,
      observedInputTokens: 5_010_629,
    });
  });

  test("the singly-encoded body still parses (no regression)", () => {
    expect(parseUpstreamPromptGate(SINGLE_ESCAPED_BODY)).toEqual({
      limit: 1_048_576,
      observedInputTokens: 2_010_775,
    });
    expect(parseUpstreamRejection(SINGLE_ESCAPED_BODY)).toMatchObject({
      rejected: true,
      rejectedWithoutLimit: false,
    });
  });

  test("the other upstream wordings still yield their ceiling", () => {
    expect(parseUpstreamPromptGate("maximum context length is 262144 tokens")?.limit).toBe(262_144);
    expect(parseUpstreamPromptGate("context_length_exceeded: 131072")?.limit).toBe(131_072);
    expect(parseUpstreamPromptGate("input length and max_tokens exceed context limit: 8192")?.limit)
      .toBe(8_192);
  });

  test("a refusal that names no ceiling is still a refusal", () => {
    // "(2013)" is an upstream error code, not a token count - treating it as a ceiling would
    // put a wrong number in front of the brake.
    const raw = '{"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"invalid params, context window exceeds limit (2013)"}}';
    expect(parseUpstreamPromptGate(raw)).toBeUndefined();
    expect(parseUpstreamRejection(raw)).toMatchObject({
      rejected: true,
      rejectedWithoutLimit: true,
    });
  });

  test("an unrelated error yields neither a gate nor a rejection", () => {
    expect(parseUpstreamPromptGate("Provider error 502: upstream unreachable")).toBeUndefined();
    expect(parseUpstreamPromptGate("")).toBeUndefined();
    expect(parseUpstreamRejection("Provider error 502: upstream unreachable")).toMatchObject({
      rejected: false,
      rejectedWithoutLimit: false,
    });
  });

  test("a request id is never mistaken for a token count", () => {
    const raw = '{"error":{"type":"internal_error","message":"upstream node 999999 failed, '
      + 'see request 888888888 for details"}}';
    const normalized = normalizeUpstreamError(raw);
    expect(normalized.contextLimit).toBeUndefined();
    expect(normalized.observedTokens).toBeUndefined();
    expect(normalized.family).toBe("unknown");
  });

  test("families are separated: a plan refusal is not a credential failure", () => {
    const plan = normalizeUpstreamError(
      '{"error":{"type":"invalid_request_error","message":"model X is not allowed in your plan"}}',
    );
    expect(plan.family).toBe("quota_exhausted");
    expect(isSizeRejection(plan.family)).toBe(false);

    const policy = normalizeUpstreamError(
      '{"error":{"message":"Your request was rejected by our content policy."}}',
    );
    expect(policy.family).toBe("content_policy");

    const key = normalizeUpstreamError(
      '{"error":{"type":"authentication_error","message":"invalid api key"}}',
    );
    expect(key.family).toBe("auth");
  });

  test("a structured type that names a different family than the text is flagged", () => {
    const raw = '{"error":{"type":"context_length_exceeded","message":"prompt is too long"}}';
    const normalized = normalizeUpstreamError(raw);
    expect(normalized.classificationConflict).toBe(true);
    expect(normalized.family).toBe("context_length_exceeded");
  });

  test("malformed bodies never throw", () => {
    const bodies = [
      "{",
      "{]",
      '{"error":',
      "not json at all",
      "[]",
      "[1,2,3]",
      '"just a string"',
      "null",
      "12345",
      '{"a":'.repeat(500) + "1" + "}".repeat(500),
    ];
    for (const body of bodies) {
      const normalized = normalizeUpstreamError(body);
      expect(normalized.family).toBeString();
      expect(() => parseUpstreamPromptGate(body)).not.toThrow();
      expect(() => parseUpstreamRejection(body)).not.toThrow();
    }
  });

  test("a huge body is truncated instead of parsed whole", () => {
    const filler = "x".repeat(ERROR_DECODE_MAX_BODY_CHARS * 2);
    const raw = `{"error":{"type":"prompt_too_long","message":"${filler}"}}`;
    const normalized = normalizeUpstreamError(raw);
    expect(normalized.truncated).toBe(true);
    expect(normalized.family).toBe("prompt_too_long");
  });

  test("numbers deeper than the depth budget are not invented", () => {
    // Wrap the incident body in two more layers of JSON string: the numbers are now behind
    // four escapes. The family is still visible in the prose, but the numbers are not
    // readable within the budget - and a ceiling we cannot read is not a ceiling we store.
    let body = INCIDENT_BODY;
    for (let i = 0; i < ERROR_DECODE_MAX_DEPTH; i++) {
      body = JSON.stringify({ error: { type: "prompt_too_long", message: body } });
    }
    const normalized = normalizeUpstreamError(body);
    expect(normalized.family).toBe("prompt_too_long");
    expect(normalized.contextLimit).toBeUndefined();
  });

  test("a body that is one huge string does not blow up the collector", () => {
    const raw = JSON.stringify({ error: { message: "a".repeat(200_000) } });
    const normalized = normalizeUpstreamError(raw);
    expect(normalized.truncated).toBe(true);
  });
});
