/**
 * Detect the upstream's "I received a body that is not valid JSON" refusal.
 *
 * Some relays do not answer directly: they forward our request to a gateway
 * (the `request id: ...` in the message has the shape of a cloud API gateway)
 * and that gateway rejects the body it was handed:
 *
 *   {"error":{"type":"invalid_request","message":"Request body must be a valid JSON object.
 *    (request id: 202611101155375552668738268d9d6OAkJoKoz)"}}
 *
 * OUR body is produced by `JSON.stringify`, so it is syntactically valid JSON
 * by construction - the corruption happened on the way out (a truncated or
 * mangled relay). The observed signature is therefore TRANSIENT, not a
 * verdict on the request: the very same conversation succeeds seconds later
 * with the same shape.
 *
 * Codex treats a 400 as fatal and kills the turn, so this refusal must be
 * retried inside the proxy instead of being passed through.
 */

const MALFORMED_BODY_PATTERNS = [
  /must be a valid json object/i,
  /invalid json (?:object|body)/i,
  /body must be (?:a )?valid json/i,
  /request body is not valid json/i,
  /unexpected end of (?:json|input)/i,
];

/**
 * True when the upstream refused because the body it read was not valid JSON.
 *
 * Only 4xx statuses qualify: a 5xx with the same text is a server fault and
 * is handled elsewhere.
 */
export function isMalformedBodyRefusal(status: number, body: string | null | undefined): boolean {
  if (status < 400 || status >= 500) return false;
  const text = body ?? "";
  if (!text) return false;
  return MALFORMED_BODY_PATTERNS.some((re) => re.test(text));
}

/**
 * How many times a malformed-body refusal is retried inside the proxy.
 *
 * One retry already covers the observed case (the next attempt goes through a
 * fresh connection); two more absorb a short gateway hiccup. The attempts are
 * bounded so a genuinely broken upstream cannot hold the turn open.
 */
export const MALFORMED_BODY_MAX_ATTEMPTS = 3;
