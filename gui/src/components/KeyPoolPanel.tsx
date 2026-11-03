import { useState } from "react";
import { copyToClipboard } from "../clipboard";
import type { TFn } from "../i18n";
import type { KeyQuota } from "../codex-quota-utils";
import { formatDate } from "../codex-quota-utils";

type TestStatus = "loading" | "ok" | "fail" | "unknown";

interface Props {
  quota: KeyQuota;
  t: TFn;
  /** Zero-based index in pool (we render as (NN)). Optional. */
  index?: number;
  /** True when this is the only key (no key-pool UI). Optional. */
  only?: boolean;
  /** Optional per-key actions (providers.tsx wires them for the apiKeyPool case). */
  active?: boolean;
  /** True when the quota scheduler ranked this key as the standby (rotates here next). */
  nextUp?: boolean;
  /**
   * Whether this key takes part in automatic switching. `undefined` = participates
   * (the default). False = the user opted it out — it is skipped by the scheduler and
   * by the 429 failover, but stays visible, probeable and manually selectable.
   */
  autoSwitch?: boolean;
  /** Toggle handler. Omitted when the row is read-only. */
  onToggleAutoSwitch?: (enabled: boolean) => void;
  /** Derived "plan expired" flag (upstream said so). */
  expired?: boolean;
  onSwitch?: () => void;
  onRemove?: (e: React.MouseEvent) => void;
  /**
   * Full key value, set when the user has clicked Reveal for this row.
   * Plan A: the Reveal/Hide button sits inline next to this text, not at the
   * far-right action column.
   */
  revealedKey?: string;
  onReveal?: () => Promise<void> | void;
  onHide?: () => void;
  /**
   * Per-key upstream quota probe (ping only). Opens the shared result dialog.
   */
  onQuotaProbe?: () => Promise<void> | void;
  /**
   * Per-key real chat test (sends a minimal completion). Opens the same dialog,
   * focused on the chat tab.
   */
  onChatTest?: () => Promise<void> | void;
  testStatus?: TestStatus;
  testLatencyMs?: number;
  /** Backend error message when testStatus === "fail". Surfaces the real reason. */
  testError?: string;
  /** Status of the sibling chat test, shown as a small dot next to the 测试 button. */
  chatStatus?: TestStatus;
}

/** Format "1234 / 2500 (12.3%)" — falls back gracefully when raw counts are absent. */
function fmtCount(pct: number | undefined, used: number | undefined, limit: number | undefined): string {
  if (pct === undefined) return "\u2014";
  const pctText = `${pct.toFixed(1)}%`;
  if (used !== undefined && limit !== undefined) {
    return `${used.toLocaleString()} / ${limit.toLocaleString()} (${pctText})`;
  }
  return pctText;
}

/**
 * Compact result indicator for a key action. The detail (latency, replay text, raw
 * upstream error) lives in the result dialog; the row only needs a glanceable colour.
 */
function StatusDot({ status, latencyMs, title }: { status?: TestStatus; latencyMs?: number; title?: string }) {
  if (!status || status === "loading") return null;
  const cls = status === "ok" ? "dot-green" : status === "fail" ? "dot-red" : "dot-amber";
  const label = status === "ok" ? "通过" : status === "fail" ? "失败" : "未知";
  const tooltip = [label, latencyMs !== undefined ? `${latencyMs} ms` : null, title]
    .filter(Boolean).join(" · ");
  return <span className={`dot ${cls}`} title={tooltip} aria-hidden="true" />;
}

/**
 * One row per key in a multi-key (apiKeyPool) provider. Layout:
 *
 *   (NN)  <key text>  [Reveal/Hide]   <active badge>   <Test pill/button>  <Switch>  <Remove>
 *   row 2:  5h | weekly | exp
 *
 * Plan A places Reveal/Hide next to the key text so the eye pairs them.
 * Test stays in the right action column since it is a process action, not
 * a state toggle.
 */
export default function KeyPoolPanel({
  quota,
  t,
  index = 0,
  only,
  active,
  nextUp,
  autoSwitch,
  onToggleAutoSwitch,
  expired,
  onSwitch,
  onRemove,
  revealedKey,
  onReveal,
  onHide,
  onQuotaProbe,
  onChatTest,
  testStatus,
  testLatencyMs,
  testError,
  chatStatus,
}: Props) {
  const id = `(${String(index + 1).padStart(2, "0")})`;
  const isRevealed = revealedKey !== undefined;
  const showReveal = !!onReveal && !only;
  const showQuotaProbe = !!onQuotaProbe && !only;
  const showChatTest = !!onChatTest && !only;
  const showActions = !only && (onSwitch || onRemove);
  const participates = autoSwitch !== false;
  const isExpired = (expired ?? quota.expired) === true;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopyKey = async () => {
    if (!revealedKey) return;
    const ok = await copyToClipboard(revealedKey);
    setCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1600);
  };

  return (
    <div
      className={`prov-account-row key-pool-row${active ? " active" : ""}`}
      data-testid="key-pool-row"
      data-expired={isExpired ? "true" : undefined}
      data-auto-switch={participates ? "true" : "false"}
      style={{
        display: "grid",
        gridTemplateColumns: showActions
          ? "20px 44px minmax(0,1fr) auto auto"
          : "20px 44px minmax(0,1fr) auto",
        gridTemplateRows: "auto auto",
        columnGap: 12,
        rowGap: 4,
        alignItems: "center",
        padding: "6px 8px",
        fontSize: 12,
        // A key that cannot serve (expired) or that the user opted out of automatic
        // switching is dimmed so the pool reads at a glance — the row stays legible.
        opacity: isExpired || !participates ? 0.55 : 1,
      }}
    >
      {/* Row 1: auto-switch checkbox (strategy switch, not an action) */}
      {onToggleAutoSwitch ? (
        <input
          type="checkbox"
          checked={participates}
          onChange={e => onToggleAutoSwitch(e.target.checked)}
          title={participates ? t("prov.keyAutoSwitchOn") : t("prov.keyAutoSwitchOff")}
          aria-label={t("prov.keyAutoSwitchAria", { key: quota.label ?? quota.masked })}
          data-testid="key-auto-switch"
          style={{ gridRow: 1, gridColumn: 1, margin: 0, cursor: "pointer" }}
        />
      ) : (
        <span style={{ gridRow: 1, gridColumn: 1 }} />
      )}

      {/* Row 1: (NN) chip */}
      <code
        className="chip"
        style={{ fontSize: 11, fontWeight: 600, gridRow: 1, gridColumn: 2 }}
      >
        {id}
      </code>

      {/* Row 1: key text + inline Reveal/Hide (Plan A) */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          overflow: "hidden",
          gridRow: 1,
          gridColumn: 3,
        }}
      >
        {quota.label ? <span className="muted">{quota.label} · </span> : null}
        {isRevealed ? (
          <span
            className="prov-key-revealed"
            data-testid="key-revealed"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: "0 1 auto",
            }}
          >
            {revealedKey}
          </span>
        ) : (
          <span
            style={{
              fontFamily: "var(--mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: "0 1 auto",
            }}
          >
            {quota.masked}
          </span>
        )}
        {showReveal ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={isRevealed ? onHide : onReveal}
            title={isRevealed ? t("prov.keyHideTitle") : t("prov.keyRevealTitle")}
            aria-label={
              isRevealed
                ? t("prov.keyHideAria", { key: quota.label ?? quota.masked })
                : t("prov.keyRevealAria", { key: quota.label ?? quota.masked })
            }
            data-testid={isRevealed ? "key-hide" : "key-reveal"}
            style={{ fontSize: 11, flexShrink: 0 }}
          >
            {isRevealed ? t("prov.keyHide") : t("prov.keyReveal")}
          </button>
        ) : null}
        {isRevealed ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleCopyKey}
            title={
              copyState === "copied"
                ? t("prov.keyCopied")
                : copyState === "failed"
                  ? t("prov.keyCopyFail")
                  : t("prov.keyCopyTitle")
            }
            aria-label={t("prov.keyCopyAria", { key: quota.label ?? quota.masked })}
            data-testid="key-copy"
            style={{ fontSize: 11, flexShrink: 0 }}
          >
            {copyState === "copied" ? t("prov.keyCopied") : t("prov.keyCopy")}
          </button>
        ) : null}
      </span>

      {/* Row 1: active badge */}
      <span
        style={{
          display: "inline-flex",
          justifyContent: "flex-start",
          gridRow: 1,
          gridColumn: 4,
        }}
      >
        {active ? (
          <span className="badge badge-primary" style={{ fontSize: 10 }}>
            active
          </span>
        ) : null}
        {nextUp && !active ? (
          <span
            className="badge"
            style={{ fontSize: 10, border: "1px solid var(--border)", color: "var(--muted)" }}
            title={t("prov.keyNextUpTitle")}
          >
            {t("prov.keyNextUp")}
          </span>
        ) : null}
      </span>

      {/* Row 1: action column (Test pill/button + Switch + Remove) */}
      {showActions ? (
        <span
          style={{
            display: "inline-flex",
            gap: 6,
            alignItems: "center",
            justifyContent: "flex-end",
            gridRow: 1,
            gridColumn: 5,
          }}
        >
          {showQuotaProbe ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onQuotaProbe}
                title={t("prov.keyQuotaProbeTitle")}
                aria-label={t("prov.keyQuotaProbeAria", { key: quota.label ?? quota.masked })}
                data-testid="key-quota-probe"
                style={{ fontSize: 11 }}
              >
                {testStatus === "loading" ? <><span className="spin" />{t("prov.keyQuotaProbeLoading")}</> : t("prov.keyQuotaProbe")}
              </button>
              <StatusDot status={testStatus} latencyMs={testLatencyMs} title={testError} />
            </span>
          ) : null}
          {showChatTest ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onChatTest}
                title={t("prov.keyChatTestTitle")}
                aria-label={t("prov.keyChatTestAria", { key: quota.label ?? quota.masked })}
                data-testid="key-chat-test"
                style={{ fontSize: 11 }}
              >
                {chatStatus === "loading" ? <><span className="spin" />{t("prov.keyChatTestLoading")}</> : t("prov.keyChatTest")}
              </button>
              <StatusDot status={chatStatus} />
            </span>
          ) : null}
          {onSwitch ? (
            <button
              type="button"
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
              type="button"
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

      {/* Row 2: quota details - aligned under the masked column */}
      <span
        style={{
          fontFamily: "var(--mono)",
          gridRow: 2,
          gridColumn: "3 / -1",
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          fontSize: 11,
        }}
      >
        {isExpired ? (
          <span style={{ color: "var(--red, #e5484d)", fontWeight: 600 }}>
            {t("prov.keyExpiredBadge")}
          </span>
        ) : null}
        {!participates ? (
          <span style={{ color: "var(--amber)" }}>{t("prov.keyAutoSwitchOffBadge")}</span>
        ) : null}
        <span>
          <span className="muted">5h</span>{" "}
          <strong>{fmtCount(quota.fiveHourPercent, quota.fiveHourUsed, quota.fiveHourLimit)}</strong>
        </span>
        <span>
          <span className="muted">weekly</span>{" "}
          <strong>{fmtCount(quota.weeklyPercent, quota.weeklyUsed, quota.weeklyLimit)}</strong>
        </span>
        {quota.expiresAt !== undefined ? (
          <span className={isExpired ? "" : "muted"} style={isExpired ? { color: "var(--red, #e5484d)" } : undefined}>
            exp {formatDate(quota.expiresAt)}
          </span>
        ) : null}
        {(() => {
          // Scheduler forecast: translate raw quota numbers into "what happens next" for
          // this key. Quiet when the key is healthy; amber when expiry will waste quota.
          if (quota.weeklyPercent !== undefined && quota.weeklyPercent >= 100) {
            return (
              <span className="muted">· {quota.weeklyResetAt !== undefined
                ? t("prov.keyForecastWeeklyOut", { reset: formatDate(quota.weeklyResetAt) })
                : t("prov.keyForecastWeeklyOutNoReset")}</span>
            );
          }
          if (quota.fiveHourPercent !== undefined && quota.fiveHourPercent >= 100) {
            return (
              <span className="muted">· {quota.fiveHourResetAt !== undefined
                ? t("prov.keyForecast5hOut", { reset: new Date(quota.fiveHourResetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
                : t("prov.keyForecast5hOutNoReset")}</span>
            );
          }
          if (quota.expiresAt !== undefined && quota.expiresAt > Date.now()) {
            const days = Math.ceil((quota.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
            if (days <= 14 && (quota.weeklyPercent === undefined || quota.weeklyPercent < 100)) {
              return <span style={{ color: "var(--amber)" }}>· {t("prov.keyForecastExpirySoon", { n: String(days) })}</span>;
            }
          }
          return null;
        })()}
      </span>
    </div>
  );
}
