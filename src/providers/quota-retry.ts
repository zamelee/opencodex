/**
 * "The account has no money left" handling for relays that report it as a 403.
 *
 * The upstream relays answer an exhausted balance with HTTP 403 and a body
 * like "预扣费额度失败, 用户剩余额度: ¥0.000000" or "用户额度不足". Two facts
 * make this worth handling on its own:
 *
 *  1. It is NOT a credential problem. Classifying it as `invalid_api_key`
 *     makes the operator hunt for a broken key while the key is perfectly
 *     fine and the balance is simply empty.
 *  2. The refusal happens BEFORE the upstream runs the model (the relay
 *     pre-empts the call because it cannot pre-deduct the money). A retry
 *     therefore costs the upstream nothing and is never billed twice.
 *
 * The recovery has two layers, cheapest first:
 *
 *  - LAYER 2 (instant): the pool holds several keys and, on these relays,
 *    each key carries its OWN balance (the observed remaining amounts jump
 *    around between keys instead of falling monotonically). Switching to
 *    another key recovers the turn in about a second.
 *  - LAYER 3 (patient): when there is no other key to try, wait and retry.
 *    A relay's balance can come back (settlement lag, a refund, a top-up
 *    landing while we wait), so a bounded wait is worth it - but it must be
 *    bounded, because the client is waiting and Codex has its own retry
 *    budget on top of ours.
 */

export interface QuotaRetryPolicy {
  /** Whether the quota path may retry at all. */
  enabled: boolean;
  /** How long to wait between attempts. */
  intervalMs: number;
  /** How many EXTRA attempts we may make after the first refusal. */
  maxAttempts: number;
}

export const DEFAULT_QUOTA_RETRY: QuotaRetryPolicy = {
  enabled: true,
  intervalMs: 20_000,
  maxAttempts: 3,
};

/** Hard ceiling on the total time we are willing to hold a client for. */
const TOTAL_WAIT_BUDGET_MS = 90_000;

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 5;

/**
 * Phrases that name an exhausted balance. Kept narrow on purpose: a generic
 * "quota" also shows up in rate-limit answers, and those have their own
 * (faster) failover path.
 */
const QUOTA_PHRASES: RegExp[] = [
  /剩余额度/,
  /额度不足/,
  /预扣费额度失败/,
  /余额不足/,
  /账户余额/,
  /insufficient[_ ]quota/i,
  /quota (?:exceeded|exhausted|depleted)/i,
  /insufficient balance/i,
  /balance not enough/i,
  /not enough balance/i,
  /arrears/i,
];

/** Whether an upstream error body names an exhausted balance. */
export function isQuotaExhaustedBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return QUOTA_PHRASES.some((re) => re.test(body));
}

/**
 * Whether an upstream refusal is "the balance is empty".
 *
 * Only the statuses that these relays actually use qualify. A 401, or a 403
 * that names an invalid key, is a credential problem and must NOT be
 * retried here.
 */
export function isQuotaExhausted(
  status: number,
  body: string | null | undefined,
): boolean {
  if (status !== 403 && status !== 402 && status !== 429) return false;
  if (!isQuotaExhaustedBody(body)) return false;
  // A credential refusal that happens to mention a balance stays a credential
  // refusal: rotating keys or waiting cannot fix a revoked key.
  if (/invalid[_ ]api[_ ]key|unauthorized|authentication|api key not found|密钥无效|无效的?密钥/i.test(body ?? "")) {
    return false;
  }
  return true;
}

/** Read the provider's policy, clamped to sane bounds. */
export function resolveQuotaRetryPolicy(
  provider: { quotaRetry?: { enabled?: boolean; intervalMs?: number; maxAttempts?: number } } | undefined,
): QuotaRetryPolicy {
  const raw = provider?.quotaRetry;
  const enabled = raw?.enabled ?? DEFAULT_QUOTA_RETRY.enabled;
  const intervalMs = clampInterval(raw?.intervalMs);
  const maxAttempts = clampAttempts(raw?.maxAttempts, intervalMs);
  return { enabled, intervalMs, maxAttempts };
}

function clampInterval(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUOTA_RETRY.intervalMs;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)));
}

function clampAttempts(value: number | undefined, intervalMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUOTA_RETRY.maxAttempts;
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(0, Math.round(value)));
  // Never hold the client longer than the budget, whatever the user asked for.
  const affordable = Math.floor(TOTAL_WAIT_BUDGET_MS / intervalMs);
  return Math.min(attempts, Math.max(0, affordable));
}

/**
 * Sleep, but wake up immediately when the client goes away.
 *
 * Returns false when the request was aborted - the caller must then stop
 * retrying instead of holding a dead connection open.
 */
export function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
