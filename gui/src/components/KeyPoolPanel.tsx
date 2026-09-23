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
   * Per-key upstream probe. When set, a Test button + result pill appear
   * in the right action column.
   */
  onTest?: () => Promise<void> | void;
  testStatus?: TestStatus;
  testLatencyMs?: number;
  /** Backend error message when testStatus === "fail". Surfaces the real reason. */
  testError?: string;
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

/** Compact result pill for the per-key upstream probe. */
function TestPill({
  status,
  latencyMs,
  errorText,
  t,
}: {
  status: TestStatus;
  latencyMs?: number;
  errorText?: string;
  t: TFn;
}) {
  if (status === "loading") {
    return (
      <span className="prov-key-test-pill prov-key-test-loading" data-testid="key-test-loading">
        {t("prov.keyTestLoading")}
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="prov-key-test-pill prov-key-test-ok">
        {t("prov.keyTestOk", { ms: latencyMs ?? 0 })}
      </span>
    );
  }
  if (status === "fail") {
    // Prefer the actual backend error. Fall back to the generic "rejected" string
    // when the backend didn't surface one.
    const label = errorText ? errorText : t("prov.keyTestFail");
    return (
      <span
        className="prov-key-test-pill prov-key-test-fail"
        data-testid="key-test-fail"
        title={errorText ?? undefined}
      >
        {label}
      </span>
    );
  }
  // "unknown" - backend reachable but unsure.
  return (
    <span className="prov-key-test-pill prov-key-test-unknown">
      {t("prov.keyTestUnknown", { ms: latencyMs ?? 0 })}
    </span>
  );
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
  onSwitch,
  onRemove,
  revealedKey,
  onReveal,
  onHide,
  onTest,
  testStatus,
  testLatencyMs,
  testError,
}: Props) {
  const id = `(${String(index + 1).padStart(2, "0")})`;
  const isRevealed = revealedKey !== undefined;
  const showReveal = !!onReveal && !only;
  const showTest = !!onTest && !only;
  const showActions = !only && (onSwitch || onRemove);
  // When a result is in, hide the Test button - the pill says everything.
  const showTestButton = showTest && !testStatus;

  return (
    <div
      className={`prov-account-row key-pool-row${active ? " active" : ""}`}
      style={{
        display: "grid",
        gridTemplateColumns: showActions
          ? "44px minmax(0,1fr) auto auto"
          : "44px minmax(0,1fr) auto",
        gridTemplateRows: "auto auto",
        columnGap: 12,
        rowGap: 4,
        alignItems: "center",
        padding: "6px 8px",
        fontSize: 12,
      }}
    >
      {/* Row 1: (NN) chip */}
      <code
        className="chip"
        style={{ fontSize: 11, fontWeight: 600, gridRow: 1, gridColumn: 1 }}
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
          gridRow: 1,
          gridColumn: 2,
        }}
      >
        {quota.label ? <span className="muted">{quota.label} · </span> : null}
        {isRevealed ? (
          <span
            className="prov-key-revealed"
            data-testid="key-revealed"
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
            style={{ fontSize: 11 }}
          >
            {isRevealed ? t("prov.keyHide") : t("prov.keyReveal")}
          </button>
        ) : null}
      </span>

      {/* Row 1: active badge */}
      <span
        style={{
          display: "inline-flex",
          justifyContent: "flex-start",
          gridRow: 1,
          gridColumn: 3,
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
            gridRow: 1,
            gridColumn: 4,
          }}
        >
          {testStatus ? (
            <TestPill
              status={testStatus}
              latencyMs={testLatencyMs}
              errorText={testError}
              t={t}
            />
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
          {showTestButton ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onTest}
              title={t("prov.keyTestTitle") + " - " + t("prov.keyPoolTestHint")}
              aria-label={t("prov.keyTestAria", { key: quota.label ?? quota.masked })}
              data-testid="key-test"
              style={{ fontSize: 11 }}
            >
              {t("prov.keyTest")}
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
