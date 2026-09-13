import type { TFn } from "../i18n";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

interface RowData {
  label: string;
  percent: number;
  resetAt?: number;
  used?: number;
  limit?: number;
}

/** Sum the given numeric field across all keys in the pool. Returns undefined when no
 *  key reports a value (so the row can fall back to "—" instead of showing "0 / 0"). */
function sumUsed(keys: AccountQuota["keys"], field: "weeklyUsed" | "weeklyLimit" | "fiveHourUsed" | "fiveHourLimit"): number | undefined {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  let total: number | undefined;
  for (const k of keys) {
    const v = (k as unknown as Record<string, unknown>)[field];
    if (typeof v !== "number") continue;
    total = (total ?? 0) + v;
  }
  return total;
}

export default function QuotaBars({ quota, plan, threshold, t, className }: {
  quota: AccountQuota | null;
  plan?: string | null;
  threshold: number;
  t: TFn;
  className?: string;
}) {
  const displayQuota = normalizeQuotaForPlan(quota, plan);
  if (!displayQuota) return null;
  const rows: RowData[] = [
    typeof displayQuota.fiveHourPercent === "number"
      ? { label: t("codexAuth.fiveHour"), percent: displayQuota.fiveHourPercent, resetAt: displayQuota.fiveHourResetAt, used: sumUsed(displayQuota.keys, "fiveHourUsed"), limit: sumUsed(displayQuota.keys, "fiveHourLimit") }
      : null,
    typeof displayQuota.weeklyPercent === "number"
      ? { label: t("codexAuth.weekly"), percent: displayQuota.weeklyPercent, resetAt: displayQuota.weeklyResetAt, used: sumUsed(displayQuota.keys, "weeklyUsed"), limit: sumUsed(displayQuota.keys, "weeklyLimit") }
      : null,
    typeof displayQuota.monthlyPercent === "number"
      ? { label: t("codexAuth.monthly"), percent: displayQuota.monthlyPercent, resetAt: displayQuota.monthlyResetAt }
      : null,
    ...(displayQuota.customWindows ?? []),
  ].filter((row): row is RowData => row !== null);
  if (rows.length === 0) return null;
  return (
    <div className={`quota-compact${className ? ` ${className}` : ""}`}>
      {rows.map((row, index) => (
        <QuotaRow
          key={`${row.label}-${index}`}
          label={row.label}
          percent={row.percent}
          resetAt={row.resetAt}
          used={row.used}
          limit={row.limit}
          threshold={threshold}
          t={t}
        />
      ))}
    </div>
  );
}

function QuotaRow({ label, percent, resetAt, used, limit, threshold, t }: {
  label: string;
  percent: number;
  resetAt?: number;
  used?: number;
  limit?: number;
  threshold: number;
  t: TFn;
}) {
  // Show used / limit (e.g. "5,094 / 21,250") alongside the percentage so users can see
  // the absolute numbers behind the percentage. Falls back to an em dash when the
  // provider quota poll doesn't surface used/limit (e.g. OAuth providers).
  const usedAndLimit = typeof used === "number" && typeof limit === "number"
    ? `${used.toLocaleString()} / ${limit.toLocaleString()}`
    : "\u2014";
  const color = threshold > 0 && percent >= threshold ? "bar-amber" : "bar-green";
  const reset = formatResetAt(resetAt, t);
  return (
    <div className="quota-row">
      <span className="quota-label">{label}</span>
      <span className="quota-reset-label">{t("codexAuth.resets")}</span>
      <span className="quota-reset-day">{reset.day}</span>
      <span className="quota-reset-time">{reset.time}</span>
      <div className="bar"><div className={`bar-fill ${color}`} style={{ width: `${clampPercent(percent)}%` }} /></div>
      <span className="quota-val" style={{ whiteSpace: "nowrap" }}>{Math.round(percent)}%<span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{usedAndLimit}</span></span>
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatResetAt(resetAt: number | undefined, t: TFn): { day: string; time: string } {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return { day: "", time: "" };
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const date = new Date(ms);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return { day: t("codexAuth.today"), time };
  const day = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(date);
  return { day, time };
}
