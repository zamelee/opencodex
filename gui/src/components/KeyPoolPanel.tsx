import type { TFn } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import { formatDate, formatRelativeTime, daysUntil } from "../codex-quota-utils";

interface Props {
  quota: AccountQuota;
  t: TFn;
}

/**
 * Per-provider extras rendered under QuotaBars:
 *   - Plan label + days-until-expiry (when present)
 *   - "Refreshed 5m ago" relative timestamp (always, derived from quota.updatedAt)
 *   - Per-key breakdown when the provider has multiple keys (apiKeyPool)
 */
export default function KeyPoolPanel({ quota, t }: Props) {
  const refresh = quota.updatedAt > 0 ? formatRelativeTime(quota.updatedAt) : null;
  const expiresIn = quota.expiresAt !== undefined ? daysUntil(quota.expiresAt) : null;

  return (
    <div className="provider-plan" style={{ marginTop: 6 }}>
      <div className="muted" style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        {quota.planLabel && (
          <span><strong>{quota.planLabel}</strong></span>
        )}
        {quota.expiresAt !== undefined && expiresIn !== null && (
          expiresIn >= 0
            ? <span>{t("prov.expiresIn", { n: String(expiresIn) })}</span>
            : <span style={{ color: "var(--err, #e5484d)" }}>{formatDate(quota.expiresAt)}</span>
        )}
        {refresh && <span>· {refresh}</span>}
      </div>
      {quota.keys && quota.keys.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
            {t("prov.keys", { n: String(quota.keys.length) })}
          </summary>
          <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
            {quota.keys.map(k => (
              <li key={k.id} style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <code className="chip" style={{ fontSize: 11 }}>{k.masked}</code>
                {k.active && <span className="badge badge-green" style={{ fontSize: 10 }}>active</span>}
                {k.weeklyPercent !== undefined && (
                  <span>week <strong>{k.weeklyPercent.toFixed(1)}%</strong></span>
                )}
                {k.fiveHourPercent !== undefined && (
                  <span>5h <strong>{k.fiveHourPercent.toFixed(1)}%</strong></span>
                )}
                {k.expiresAt !== undefined && (
                  <span className="muted">exp {formatDate(k.expiresAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
