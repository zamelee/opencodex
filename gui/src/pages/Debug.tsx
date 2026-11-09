import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconRefresh } from "../icons";
import { Switch } from "../ui";

interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage" | "injection", boolean>>;
  env: Record<"debug" | "usage" | "injection", boolean>;
}

interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

interface ConsoleLogEntry {
  seq: number;
  at: number;
  level: string;
  line: string;
}

type LogStream = "provider" | "usage" | "console";

/** Console-log level filter. "all" keeps every level. */
type LevelFilter = "all" | "warn" | "error";

/** The three opt-in debug switches, with the sensitivity label each one carries. */
const DEBUG_FLAGS = [
  { flag: "debug", hint: "debug.hintDebug", sensitivity: "debug.sensitivityMedium", note: "debug.sensitivityMediumNote" },
  { flag: "usage", hint: "debug.hintUsage", sensitivity: "debug.sensitivityHigh", note: "debug.sensitivityHighNote" },
  { flag: "injection", hint: "debug.hintInjection", sensitivity: "debug.sensitivityLow", note: "debug.sensitivityLowNote" },
] as const;

export default function Debug({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [debug, setDebug] = useState<DebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  // The console mirror is always on, so it is the useful default: the page has
  // something to show before any debug switch is touched.
  const [stream, setStream] = useState<LogStream>("console");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const fetchDebug = async () => {
      try {
        const res = await fetch(`${apiBase}/api/debug`);
        if (res.ok) setDebug(await res.json());
      } catch { /* ignore */ }
    };
    void fetchDebug();
    const interval = setInterval(() => void fetchDebug(), 2000);
    return () => clearInterval(interval);
  }, [apiBase]);

  useEffect(() => {
    if (!debug) return;
    // The console stream is always available, so it is the fallback when the
    // selected stream's switch is off — never the other way round.
    if (stream === "usage" && !debug.usage) setStream("console");
    if (stream === "provider" && !debug.enabled) setStream("console");
  }, [debug, stream]);

  // The console mirror is always on, so it never needs a toggle to become readable.
  const streamEnabled = stream === "console"
    ? true
    : stream === "provider" ? !!debug?.enabled : !!debug?.usage;
  const logsPath = stream === "provider"
    ? `${apiBase}/api/debug/logs`
    : stream === "usage" ? `${apiBase}/api/debug/usage-logs` : `${apiBase}/api/debug/console-logs`;

  const fetchLogs = useCallback(async (initial: boolean) => {
    if (!streamEnabled) {
      setLines([]);
      afterRef.current = 0;
      return;
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (!initial && afterRef.current > 0) params.set("after", String(afterRef.current));
      if (stream === "console" && level !== "all") {
        params.set("levels", level === "error" ? "error" : "warn,error");
      }
      const res = await fetch(`${logsPath}?${params}`);
      if (!res.ok) return;
      const entries = await res.json() as Array<DebugLogEntry | ConsoleLogEntry>;
      if (entries.length === 0) return;
      setLines(prev => initial
        ? entries.map(entry => entry.line)
        : [...prev, ...entries.map(entry => entry.line)].slice(-2000));
      afterRef.current = entries[entries.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled, stream, level]);

  useEffect(() => {
    afterRef.current = 0;
    setLines([]);
    void fetchLogs(true);
  }, [stream, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => void fetchLogs(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, follow]);

  const setDebugFlag = async (flag: "debug" | "usage" | "injection", enabled: boolean) => {
    setDebugBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [flag]: enabled }),
      });
      if (res.ok) setDebug(await res.json());
    } catch { /* ignore */ } finally {
      setDebugBusy(false);
    }
  };

  const resetDebug = async () => {
    setDebugBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (res.ok) setDebug(await res.json());
    } catch { /* ignore */ } finally {
      setDebugBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t("debug.title")}</h2>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing || !streamEnabled}
            onClick={() => void fetchLogs(true)}
          >
            <IconRefresh /> {t("debug.refresh")}
          </button>
          <label className="muted" style={{ fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
            {t("debug.follow")}
          </label>
        </div>
      </div>
      <p className="page-sub">{t("debug.subtitle")}</p>

      {!debug ? (
        <div className="empty">{t("debug.loading")}</div>
      ) : (
        <div className="card debug-switches">
          <div className="debug-switch-legend">
            <span className="muted">{t("debug.sensitivity")}</span>
          </div>
          <div className="debug-switch-list">
            {DEBUG_FLAGS.map(({ flag, hint, sensitivity, note }) => {
              const checked = flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : debug.injection;
              return (
                <div key={flag} className="debug-switch-item">
                  <div className="debug-switch-head">
                    <Switch
                      on={checked}
                      disabled={debugBusy}
                      label={t(`debug.${flag}`)}
                      onClick={() => void setDebugFlag(flag, !checked)}
                    />
                    <span className="debug-switch-name">{t(`debug.${flag}`)}</span>
                    <span className="badge badge-muted debug-switch-badge">
                      {t(sensitivity)}
                    </span>
                  </div>
                  <p className="debug-switch-hint">
                    <span className="debug-switch-note">({t(note)})</span>{" "}
                    {t(hint)}
                  </p>
                </div>
              );
            })}
            <div className="debug-switch-item">
              <div className="debug-switch-head">
                <span className="debug-switch-dot" aria-hidden="true" />
                <span className="debug-switch-name">{t("debug.console")}</span>
                <span className="badge badge-green debug-switch-badge">
                  {t("debug.sensitivityLow")}
                </span>
              </div>
              <p className="debug-switch-hint">
                <span className="debug-switch-note">({t("debug.sensitivityLowNote")})</span>{" "}
                {t("debug.hintConsole")}
              </p>
            </div>
          </div>

          <div className="debug-switch-foot">
            <div className="debug-streams">
              <button
                type="button"
                className={`btn btn-sm${stream === "console" ? " btn-primary" : " btn-ghost"}`}
                onClick={() => setStream("console")}
              >
                {t("debug.streamConsole")}
              </button>
              {debug.enabled && (
                <button
                  type="button"
                  className={`btn btn-sm${stream === "provider" ? " btn-primary" : " btn-ghost"}`}
                  onClick={() => setStream("provider")}
                >
                  {t("debug.streamProvider")}
                </button>
              )}
              {debug.usage && (
                <button
                  type="button"
                  className={`btn btn-sm${stream === "usage" ? " btn-primary" : " btn-ghost"}`}
                  onClick={() => setStream("usage")}
                >
                  {t("debug.streamUsage")}
                </button>
              )}
            </div>
            {stream === "console" && (
              <div className="debug-levels">
                <span className="muted">{t("debug.levels")}</span>
                {(["all", "warn", "error"] as const).map(option => (
                  <button
                    key={option}
                    type="button"
                    className={`btn btn-sm${level === option ? " btn-primary" : " btn-ghost"}`}
                    onClick={() => setLevel(option)}
                  >
                    {t(option === "all" ? "debug.levelAll" : option === "warn" ? "debug.levelWarn" : "debug.levelError")}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={debugBusy} onClick={() => void resetDebug()}>
              {t("debug.reset")}
            </button>
          </div>

          <p className="debug-remote-hint">{t("debug.hintRemote")}</p>
        </div>
      )}

      {debug && !streamEnabled ? (
        <div className="empty">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("debug.emptyTitle")}</div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 560 }}>{t("debug.empty")}</div>
        </div>
      ) : debug && streamEnabled && lines.length === 0 ? (
        <div className="empty">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {t(stream === "console" ? "debug.consoleEmptyTitle" : "debug.noLinesTitle")}
          </div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 560 }}>
            {t(stream === "console" ? "debug.consoleEmpty" : "debug.noLines")}
          </div>
        </div>
      ) : debug && streamEnabled ? (
        <pre ref={logRef} className="log-detail-json" style={{ maxHeight: "calc(100vh - 280px)" }}>{lines.join("\n")}</pre>
      ) : null}
    </>
  );
}
