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
import { useT } from "../i18n";

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
        style={{ width: 96, accentColor: "var(--accent)", cursor: disabled ? "not-allowed" : "pointer" }}
      />
      <span className="ratio-pct mono">
        {shown}%
      </span>
      {typeof tokenLimit === "number" ? (
        <span className="muted mono ratio-token">
          {t("models.compactAt", { value: fmtK(tokenLimit) })}
        </span>
      ) : (
        /* Keep the slot: without it the percentage slides left on rows that have no
           token, and the column stops reading as a table. */
        <span className="muted mono ratio-token" aria-hidden="true" />
      )}
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
 * Every number the probe used is listed with where it came from, so the answer is readable in
 * place. A missing input says so explicitly instead of silently rendering as "-".
 */
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
  return (
    <div className="probe-trace" role="status">
      {steps.map(s => (
        <div key={s.key} className="row" style={{ gap: 6, fontSize: 11, alignItems: "baseline" }}>
          <span className="muted" style={{ minWidth: 210 }}>{s.label}</span>
          <span className="mono" style={{ minWidth: 74, color: "var(--text)" }}>
            {typeof s.value === "number" ? fmtK(s.value) : t("models.probeUnavailable")}
          </span>
          <span className="muted mono" style={{ fontSize: 10 }}>{s.source}</span>
        </div>
      ))}
      <div className="row" style={{ gap: 6, fontSize: 11, alignItems: "baseline" }}>
        <span className="muted" style={{ minWidth: 210 }}>{t("models.probeAppliedLabel")}</span>
        <span className="mono" style={{ color: "var(--text)" }}>
          {typeof result.applied === "number" ? fmtK(result.applied) : t("models.probeNotApplied")}
        </span>
      </div>
    </div>
  );
}
