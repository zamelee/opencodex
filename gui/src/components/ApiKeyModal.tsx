import { useEffect, useRef, useState } from "react";
import { useT, Trans } from "../i18n";
import { IconKey, IconAlert, IconCheck } from "../icons";
import { copyToClipboard } from "../clipboard";

interface ApiKeyModalProps {
  open: boolean;
  onSubmit: (key: string) => void;
  onCancel: () => void;
  error?: string;
}

// Display version: PowerShell-friendly multi-line using backtick line-continuation.
// Backticks MUST stay so the user can copy the block directly into PowerShell.
const CURL_DISPLAY_PS = [
  "curl -X POST `",
  "  -H \"X-OpenCodex-API-Key: <existing-key>\" `",
  "  -H \"Content-Type: application/json\" `",
  "  -d '{\"name\":\"this-device\"}' `",
  "  http://localhost:10100/api/keys",
].join("\n");

const CURL_COPY_PS =
  "curl -X POST -H \"X-OpenCodex-API-Key: <existing-key>\" -H \"Content-Type: application/json\" -d \"{\"name\":\"this-device\"}\" http://localhost:10100/api/keys";

const CONFIG_PATH_DISPLAY = "~/.opencodex/config.json";
const KEY_EXAMPLE = "ocx_9957\u2026<40 hex>";
const KEY_FIELD = "key";
const AUTH_HEADER = "X-OpenCodex-API-Key";
const RESTART_CMD = "ocx stop && ocx gui";

export default function ApiKeyModal({ open, onSubmit, onCancel, error }: ApiKeyModalProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setShow(false);
    setCopyError(undefined);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  const copy = async () => {
    const ok = await copyToClipboard(CURL_COPY_PS);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      setCopyError(t("apiKeys.copyError"));
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <IconKey width={16} /> {t("authKey.title")}
        </h3>
        <p className="modal-desc" style={{ marginTop: 8 }}>
          {t("authKey.desc")}
        </p>
        <div className="notice notice-ok" style={{ marginTop: 4, marginBottom: 12, fontSize: 12 }}>
          <strong>{t("authKey.tipLabel")}:</strong>{" "}
          {t("authKey.localhostTip").replace("{url}", "http://localhost:10100")}
        </div>

        {error && (
          <div className="notice notice-err" style={{ marginBottom: 12 }}>
            <IconAlert width={14} />
            <span>{error}</span>
          </div>
        )}
        {copyError && (
          <div className="notice notice-err" style={{ marginBottom: 12, fontSize: 12 }}>
            <IconAlert width={14} />
            <span>{copyError}</span>
          </div>
        )}

        <label htmlFor="ocx-api-key-input" style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
          {t("authKey.inputLabel")}
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id="ocx-api-key-input"
            ref={inputRef}
            className="input"
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="ocx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
            style={{ flex: 1, fontFamily: "var(--mono)" }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? t("authKey.hideKey") : t("authKey.showKey")}
            title={show ? t("authKey.hideKey") : t("authKey.showKey")}
          >
            {show ? t("authKey.hideKey") : t("authKey.showKey")}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {t("authKey.formatHint").replace("{example}", KEY_EXAMPLE)}
        </div>

        <div className="card" style={{ marginTop: 14, padding: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            <IconKey width={12} /> {t("authKey.howToGetTitle")}
          </div>
          <ol style={{ margin: "0 0 8px", paddingLeft: 20, fontSize: 13 }}>
            <li>{t("authKey.step1")}</li>
            <li>
              <Trans k="authKey.step2" slots={{ configPath: CONFIG_PATH_DISPLAY }} />
            </li>
          </ol>
          <div style={{ position: "relative" }}>
            <pre style={{
              margin: 0, padding: "10px 88px 10px 12px",
              background: "var(--surface-2)", borderRadius: 6,
              overflowX: "auto", fontSize: 12, whiteSpace: "pre", lineHeight: 1.5,
              fontFamily: "var(--mono)", tabSize: 2,
            }}>{CURL_DISPLAY_PS}</pre>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={copy}
              style={{ position: "absolute", top: 6, right: 6, padding: "2px 8px", fontSize: 11 }}
              title={t("authKey.copyCommand")}
            >
              {copied ? <><IconCheck width={12} /> {t("authKey.copiedCommand")}</> : t("authKey.copyCommand")}
            </button>
          </div>
          <p style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
            <Trans k="authKey.responseHint" slots={{ keyField: KEY_FIELD, authHeader: AUTH_HEADER }} />
          </p>
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
            <strong>{t("authKey.firstTimeTitle")}</strong>{" "}
            <Trans k="authKey.firstTimeDesc" slots={{ configPath: CONFIG_PATH_DISPLAY, apiKeysField: "apiKeys", cmd: RESTART_CMD }} />
          </p>
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden="true">🔒</span> {t("authKey.securityNote")}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>{t("authKey.cancel")}</button>
          <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
            {t("authKey.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
