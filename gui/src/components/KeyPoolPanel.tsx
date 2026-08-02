import type { TFn } from "../i18n";
import type { KeyQuota } from "../codex-quota-utils";
import { formatDate } from "../codex-quota-utils";

interface Props {
  quota: KeyQuota;
  t: TFn;
  /** Zero-based index in pool (we render as (NN)). Optional — only used in key-row mode. */
  index?: number;
  /** True when this is the only key (no key-pool UI). Optional. */
  only?: boolean;
  /** Optional per-key actions (providers.tsx wires them for the apiKeyPool case). */
  active?: boolean;
  onSwitch?: () => void;
  onRemove?: (e: React.MouseEvent) => void;
}

/** Format "1234 / 2500 (12.3%)" — falls back gracefully when raw counts are absent. */
function fmtCount(pct: number | undefined, used: number | undefined, limit: number | undefined): string {
  if (pct === undefined) return "\u2014";
  const pctText = `${pct.toFixed(1)}%`;
  if (used !== undefined && limit !== undefined) return `${used.toLocaleString()} / ${limit.toLocaleString()} (${pctText})`;
  return pctText;
}

/**
 * One row per key. Includes the (NN) tag, masked id, label (if any), and the per-window
 * quota numbers (5h / weekly). When `onSwitch` / `onRemove` are provided, an action
 * column is rendered. The component does not own the "default open" state for the
 * wrapper (that's a Providers-level concern).
 */
export default function KeyPoolPanel({ quota, t, index = 0, only, active, onSwitch, onRemove }: Props) {
  const id = `(${String(index + 1).padStart(2, "0")})`;
  const showActions = !only && (onSwitch || onRemove);

  return (
    <div
      className={`prov-account-row key-pool-row${active ? " active" : ""}`}
      style={{
        display: "grid",
        gridTemplateColumns: showActions
          ? "44px 130px 1fr auto"
          : "44px 130px 1fr",
        gridTemplateRows: "auto auto",
        columnGap: 12,
        rowGap: 4,
        alignItems: "center",
        padding: "6px 8px",
        fontSize: 12,
      }}
    >
      {/* Row 1: (NN) + masked + active badge + actions */}
      <code className="chip" style={{ fontSize: 11, fontWeight: 600, gridRow: 1, gridColumn: 1 }}>{id}</code>
      <span
        style={{
          fontFamily: "var(--mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          gridRow: 1,
          gridColumn: 2,
        }}
      >
        {quota.label ? <span className="muted">{quota.label} · </span> : null}
        {quota.masked}
      </span>
      <span
        style={{
          display: "inline-flex",
          justifyContent: "flex-start",
          gridRow: 1,
          gridColumn: 3,
        }}
      >
        {active ? <span className="badge badge-primary" style={{ fontSize: 10 }}>active</span> : null}
      </span>
      {showActions ? (
        <span
          style={{
            display: "inline-flex",
            gap: 6,
            gridRow: 1,
            gridColumn: 4,
          }}
        >
          {onSwitch ? (
            <button
              className={`btn btn-sm ${active ? "btn-ghost" : "btn-primary"}`}
              disabled={active}
              onClick={onSwitch}
              title={active ? undefined : t("prov.keySwitchTitle")}
              style={{ fontSize: 11 }}
            >
              {active ? t("prov.accountActive") : t("prov.accountLogin")}
            </button>
          ) : null}
          {onRemove ? (
            <button
              className="btn btn-danger btn-sm"
              onClick={onRemove}
              aria-label={t("prov.keyRemoveAria", { key: quota.label ?? quota.masked })}
              style={{ fontSize: 11 }}
            >
              {t("common.remove")}
            </button>
          ) : null}
        </span>
      ) : null}
      {/* Row 2: quota details (5h, weekly, exp) — aligned under the masked column */}
      <span
        style={{
          fontFamily: "var(--mono)",
          gridRow: 2,
          gridColumn: "2 / -1",
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          fontSize: 11,
        }}
      >
        <span>
          <span className="muted">5h</span>{" "}
          <strong>{fmtCount(quota.fiveHourPercent, quota.fiveHourUsed, quota.fiveHourLimit)}</strong>
        </span>
        <span>
          <span className="muted">weekly</span>{" "}
          <strong>{fmtCount(quota.weeklyPercent, quota.weeklyUsed, quota.weeklyLimit)}</strong>
        </span>
        {quota.expiresAt !== undefined ? (
          <span className="muted">exp {formatDate(quota.expiresAt)}</span>
        ) : null}
      </span>
    </div>
  );
}
