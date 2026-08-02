export interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  customWindows?: { label: string; percent: number; resetAt?: number }[];
  resetCredits?: number;
  /** Plan display label (e.g. "旗舰版・69.9 元"). Provider-specific. */
  planLabel?: string;
  /** Plan expiry timestamp (ms since epoch). Provider-specific. */
  expiresAt?: number;
  /** Per-key quota breakdown when the provider has multiple keys (apiKeyPool). */
  keys?: Array<{
    id: string;
    label?: string;
    masked: string;
    active: boolean;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    expiresAt?: number;
    planLabel?: string;
    updatedAt: number;
  }>;
  updatedAt: number;
}

export function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

export function normalizeQuotaForPlan(quota: AccountQuota | null, plan: string | null | undefined): AccountQuota | null {
  if (!quota || !isThirtyDayOnlyPlan(plan)) return quota;
  return {
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.resetCredits !== undefined ? { resetCredits: quota.resetCredits } : {}),
    updatedAt: quota.updatedAt,
  };
}

/** "刚刚 / 5 秒前 / 12 分钟前 / 3 小时前 / 2 天前 / 2026-08-31" — picked by elapsed time. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(ts);
}

/** "2026-08-31 23:25" — local-tz YYYY-MM-DD HH:MM. Avoids the GBK-encoded "\u30fb" / "-" */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Days from now until ts; negative if ts is in the past. */
export function daysUntil(ts: number, now: number = Date.now()): number {
  const diffMs = ts - now;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}
