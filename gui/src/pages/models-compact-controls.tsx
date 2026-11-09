/**
 * Controls for the "compact point" of a model row.
 *
 * Two things live here:
 *   - CompactRatioSlider: the ratio IS the control (the old read-only "630k compact" text was
     the most opaque number on the page, because it was derived from two invisible inputs).
 *   - ProbeTrace: the probe's reasoning chain, rendered inline under the row so "why is my
     window 700k?" is answerable without leaving the page.
 */
import { useState } from "react";
import { useT, type TKey } from "../i18n";

export function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

/** One line of the probe's reasoning chain: where a number came from (or why it is missing). */
export interface ProbeStep {
  key: string;
  label: string;
  value: number | null;
  source: string;
  /** When the gate was observed (ISO), for the learned step. */
  observedAt?: string;
  /** The request size the upstream quoted alongside the gate. */
  observedInputTokens?: number;
  /** A non-numeric value (the "confirmed" step carries a count, not a token number). */
  valueText?: string;
  /** How many refusals the upstream made for this route. */
  refusalCount?: number;
  /** How many of those refusals named no ceiling. */
  refusalWithoutLimitCount?: number;
  /** When the upstream last refused this route (ISO). */
  refusalLastSeenAt?: string;
}

export interface ProbeResult {
  declared?: number;
  learned?: number;
  current?: number;
  suggestion?: number;
  source?: string;
  safetyMargin?: number;
  steps?: ProbeStep[];
  /** What we actually wrote as the model's limit after the probe (null = nothing applied). */
  applied?: number | null;
  error?: string;
}

/** One step of the ACTIVE probe: what we sent, and what the upstream said. */
export interface GateProbeAttempt {
  action: string;
  targetTokens: number;
  status?: number;
  reportedTokens?: number;
  limit?: number;
  lowerBoundTokens?: number;
  outcome: "rejected" | "accepted" | "unknown";
  /** Why the attempt ended the way it did. */
  reason?: string;
  detail?: string;
}

export interface GateProbeLiveResult {
  attempts: GateProbeAttempt[];
  limit?: number;
  lowerBound?: number;
  ok: boolean;
  reason?: string;
  error?: string;
}

/**
 * The compact point, as a slider.
 *
 * Dragging does not write on every pixel: the value is committed on release (pointerup / keyup /
 * blur), so one drag is one config write.
 */
export function CompactRatioSlider({
  percent,
  contextWindow,
  pinned,
  followPercent,
  disabled,
  onCommit,
  onReset,
}: {
  percent: number;
  /** The window we advertise for this model; the compact point is a fraction of it. */
  contextWindow?: number;
  pinned: boolean;
  followPercent: number;
  disabled: boolean;
  onCommit: (percent: number) => void;
  onReset: () => void;
}) {
  const t = useT();
  // Local draft while dragging: one drag must be ONE config write, not one write per pixel.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? percent;
  // Derived live so the number next to the knob moves with the knob.
  const tokenLimit = typeof contextWindow === "number" && contextWindow > 0
    ? Math.floor(contextWindow * (shown / 100))
    : undefined;
  const commit = () => {
    if (draft !== null && draft !== percent) onCommit(draft);
    setDraft(null);
  };
  return (
    <span className="ratio-cell">
      <input
        type="range"
        min={50}
        max={95}
        step={1}
        value={shown}
        disabled={disabled}
        onChange={e => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label={t("models.ratioLabel")}
        title={t("models.ratioHint")}
        style={{ width: 80, accentColor: "var(--accent)", cursor: disabled ? "not-allowed" : "pointer" }}
      />
      <span
        className="ratio-pct mono"
        title={typeof tokenLimit === "number" ? t("models.compactAt", { value: fmtK(tokenLimit) }) : undefined}
      >
        {shown}%
      </span>
      {pinned ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm ratio-reset"
          disabled={disabled}
          onClick={onReset}
          title={t("models.ratioFollowProvider", { value: followPercent })}
        >
          {t("models.ratioReset")}
        </button>
      ) : (
        // Not pinned = this model has no ratio of its own; it rides on the provider-wide one.
        <span
          className="muted ratio-inherit"
          title={t("models.ratioInheritTitle", { value: followPercent })}
        >
          {t("models.ratioInherit")}
        </span>
      )}
    </span>
  );
}

/**
 * The probe's reasoning chain, shown inline under the model row.
 *
 * Every number the probe used is listed with where it came from AND what it actually means, so
 * the answer is readable in place. A missing input says so explicitly instead of silently
 * rendering as "-".
 */

/** The step id -> our label. The server sends an English label too; the id is the stable key. */
const PROBE_STEP_LABEL: Record<string, TKey> = {
  declared: "models.probeStepDeclared",
  learned: "models.probeStepLearned",
  current: "models.probeStepCurrent",
  brake: "models.probeStepBrake",
  confirmed: "models.probeStepConfirmed",
  suggestion: "models.probeStepSuggested",
};

/** Where a step's number came from -> our label. */
const PROBE_SOURCE_LABEL: Record<string, TKey> = {
  "codex-catalog": "models.probeSrcCodexCatalog",
  "upstream-metadata": "models.probeSrcUpstreamMetadata",
  unavailable: "models.probeSrcUnavailable",
  "upstream-error": "models.probeSrcUpstreamError",
  "not-observed-yet": "models.probeSrcNotObserved",
  override_value: "models.probeSrcOverrideValue",
  override_exempt: "models.probeSrcOverrideExempt",
  provider: "models.probeSrcProvider",
  none: "models.probeSrcNone",
  unknown: "models.probeSrcUnknown",
  learned: "models.probeSrcLearned",
  declared: "models.probeSrcDeclared",
  "proxy-side": "models.probeSrcProxySide",
  "upstream-rejection": "models.probeSrcUpstreamRejection",
};

/** What the step means, in one sentence. This is the column people actually need. */
const PROBE_STEP_NOTE: Record<string, TKey> = {
  declared: "models.probeNoteDeclared",
  learned: "models.probeNoteLearned",
  current: "models.probeNoteCurrent",
  brake: "models.probeNoteBrake",
  confirmed: "models.probeNoteConfirmed",
  suggestion: "models.probeNoteSuggested",
};

export function ProbeTrace({ result }: { result: ProbeResult }) {
  const t = useT();
  if (result.error) {
    return (
      <div className="probe-trace" role="status">
        <span className="muted mono" style={{ fontSize: 11 }}>
          {t("models.probeFailed", { error: result.error })}
        </span>
      </div>
    );
  }
  const steps = result.steps ?? [];
  const summary = typeof result.learned === "number"
    ? t("models.probeSummaryLearned", { learned: fmtK(result.learned), suggested: fmtK(result.suggestion ?? 0) })
    : typeof result.declared === "number"
      ? t("models.probeSummaryDeclared", { declared: fmtK(result.declared), suggested: fmtK(result.suggestion ?? 0) })
      : t("models.probeSummaryNone");
  return (
    <div className="probe-trace" role="status">
      <div className="probe-head">
        <span className="probe-head-title">{t("models.probeTitle")}</span>
        <p className="probe-summary">{summary}</p>
      </div>
      <table className="probe-table">
        <thead>
          <tr>
            <th>{t("models.probeTableItem")}</th>
            <th>{t("models.probeTableValue")}</th>
            <th>{t("models.probeTableSource")}</th>
            <th>{t("models.probeTableNote")}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map(s => (
            <tr key={s.key}>
              <td className="probe-td-item">
                {PROBE_STEP_LABEL[s.key] ? t(PROBE_STEP_LABEL[s.key]) : s.label}
              </td>
              <td className="probe-td-value mono">
                {s.valueText
                  ?? (typeof s.value === "number" ? fmtK(s.value) : t("models.probeUnavailable"))}
              </td>
              <td className="probe-td-source">
                <span className="probe-chip">
                  {PROBE_SOURCE_LABEL[s.source] ? t(PROBE_SOURCE_LABEL[s.source]) : s.source}
                </span>
              </td>
              <td className="probe-td-note">
                {PROBE_STEP_NOTE[s.key]
                  ? (
                    s.key === "confirmed" && s.refusalCount === undefined
                      // Nothing observed yet: the "{count}" note would be a lie, so the
                      // row says plainly that there is no observation.
                      ? t("models.probeNoteConfirmedNone")
                      : t(PROBE_STEP_NOTE[s.key], s.refusalCount !== undefined ? { count: s.refusalCount } : undefined)
                  )
                  : ""}
                {s.refusalLastSeenAt ? (
                  <span className="muted" style={{ display: "block", fontSize: 11 }}>
                    {t("models.probeObservedAt", { at: s.refusalLastSeenAt })}
                  </span>
                ) : null}
                {s.observedAt ? (
                  <span className="muted" style={{ display: "block", fontSize: 11 }}>
                    {t("models.probeObservedAt", { at: s.observedAt })}
                    {typeof s.observedInputTokens === "number"
                      ? ` · ${t("models.probeObservedTokens", { tokens: s.observedInputTokens })}`
                      : ""}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The ACTIVE probe, and the trace of what it did.
 *
 * The read-only probe above only rearranges evidence we already have. This one spends a
 * request: it sends a body far larger than any plausible window and lets the upstream
 * name its own ceiling. The steps are shown one by one, so "what happened" is never a
 * black box - and the cost is stated before the button is pressed.
 */
export function LiveProbe({
  result,
  running,
  onRun,
  testId,
}: {
  result?: GateProbeLiveResult;
  running: boolean;
  onRun: () => void;
  testId?: string;
}) {
  const t = useT();
  const outcomeLabel: Record<GateProbeAttempt["outcome"], TKey> = {
    rejected: "models.liveProbeOutcomeRejected",
    accepted: "models.liveProbeOutcomeAccepted",
    unknown: "models.liveProbeOutcomeUnknown",
  };
  const reasonLabel: Record<string, TKey> = {
    "gate-learned": "models.liveProbeReasonLearned",
    "rejected-no-limit": "models.liveProbeReasonNoLimit",
    "accepted-lower-bound": "models.liveProbeReasonLowerBound",
    "rate-limited": "models.liveProbeReasonRateLimited",
    "no-balance": "models.liveProbeReasonNoBalance",
    "bad-key": "models.liveProbeReasonBadKey",
    "model-not-found": "models.liveProbeReasonNotFound",
    "upstream-error": "models.liveProbeReasonUpstreamError",
    timeout: "models.liveProbeReasonTimeout",
    "unsupported-adapter": "models.liveProbeReasonUnsupported",
  };
  return (
    <div className="probe-live">
      <div className="probe-live-head">
        <span className="muted" style={{ fontSize: 12 }}>{t("models.liveProbeHint")}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={running}
          onClick={onRun}
          data-testid={testId}
          title={t("models.liveProbeHint")}
        >
          {running ? t("models.liveProbeRunning") : t("models.liveProbeRun")}
        </button>
      </div>
      {result && (
        <>
          {result.error && (
            <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
              {result.reason && reasonLabel[result.reason] ? t(reasonLabel[result.reason]) : result.error}
            </p>
          )}
          <table className="probe-table">
            <thead>
              <tr>
                <th>{t("models.probeTableItem")}</th>
                <th>{t("models.probeTableValue")}</th>
                <th>{t("models.liveProbeColStatus")}</th>
                <th>{t("models.probeTableNote")}</th>
              </tr>
            </thead>
            <tbody>
              {result.attempts.map((a, i) => (
                <tr key={i}>
                  <td className="probe-td-item">{t("models.liveProbeSent")}</td>
                  <td className="probe-td-value mono">{fmtK(a.targetTokens)}</td>
                  <td className="probe-td-source">
                    {a.status ?? "-"} · {a.reason && reasonLabel[a.reason]
                      ? t(reasonLabel[a.reason])
                      : a.outcome === "rejected" && a.limit === undefined
                        ? t("models.liveProbeOutcomeRejectedNoLimit")
                        : t(outcomeLabel[a.outcome])}
                  </td>
                  <td className="probe-td-note">
                    {a.limit !== undefined
                      ? t("models.liveProbeLearned", { value: fmtK(a.limit) })
                      : a.lowerBoundTokens !== undefined
                        ? t("models.liveProbeLowerBound", { value: fmtK(a.lowerBoundTokens) })
                        : ""}
                    {a.detail ? (
                      <span className="muted" style={{ display: "block", fontSize: 11 }}>
                        {t("models.liveProbeUpstreamSaid")} {a.detail}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
