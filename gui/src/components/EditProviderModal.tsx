import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { IconX, IconAlert } from "../icons";

export interface EditableProvider {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  liveModels?: boolean;
  headers?: Record<string, string>;
  label?: string;
  models?: string[];
}

interface EditProviderModalProps {
  open: boolean;
  provider: EditableProvider | null;
  apiBase: string;
  existingProviderNames?: string[];
  onSave: (patch: { label?: string; renameTo?: string; adapter?: string; baseUrl?: string; defaultModel?: string; liveModels?: boolean; headers?: Record<string, string> }) => Promise<void> | void;
  onClose: () => void;
}

// Adapter choices sourced from src/providers/registry.ts. The dropdown covers all known
// adapters; users with a non-standard one pick "Other..." and type it.
const ADAPTER_CHOICES: Array<{ value: string; label: string }> = [
  { value: "anthropic", label: "anthropic (Anthropic Messages)" },
  { value: "azure-openai", label: "azure-openai (Azure OpenAI)" },
  { value: "cursor", label: "cursor (Cursor bridge)" },
  { value: "google", label: "google (Google Vertex / Gemini)" },
  { value: "kiro", label: "kiro (Kiro / AWS CodeWhisperer)" },
  { value: "openai-chat", label: "openai-chat (OpenAI Chat Completions)" },
  { value: "openai-responses", label: "openai-responses (OpenAI Responses)" },
  { value: "__other__", label: "Other..." },
];

const SENTINEL_OTHER = "__other__";

export default function EditProviderModal({ open, provider, apiBase, existingProviderNames, onSave, onClose }: EditProviderModalProps) {
  const t = useT();
  // Form draft state. Initialized from `provider` whenever it changes.
  const [adapter, setAdapter] = useState("");
  const [adapterIsCustom, setAdapterIsCustom] = useState(false);
  const [label, setLabel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [pullingModels, setPullingModels] = useState(false);
  const [modelIsCustom, setModelIsCustom] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [confirmingRename, setConfirmingRename] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [liveModels, setLiveModels] = useState(true);
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mouseDownOnOverlay = useRef(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset draft when provider changes (or modal opens).
  useEffect(() => {
    if (!open || !provider) return;
    setLabel(provider.label || "");
    const initialAdapter = provider.adapter || "";
    setAdapter(initialAdapter);
    setAdapterIsCustom(!ADAPTER_CHOICES.some((a) => a.value === initialAdapter && a.value !== SENTINEL_OTHER));
    setBaseUrl(provider.baseUrl || "");
    setDefaultModel(provider.defaultModel || "");
    setLiveModels(provider.liveModels !== false); // default true
    const h = provider.headers || {};
    setHeaders(Object.entries(h).map(([key, value]) => ({ key, value })));
    setShowHeaders(Object.keys(h).length > 0);
    setAvailableModels(provider.models ?? []);
    setRenameTo(provider.name);
    setConfirmingRename(false);
    setError(undefined);
    // Focus first input on open.
    const id = window.setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open, provider]);

  // Escape closes (without saving).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !provider) return null;

  const updateHeader = (idx: number, field: "key" | "value", next: string) => {
    setHeaders((cur) => cur.map((h, i) => (i === idx ? { ...h, [field]: next } : h)));
  };
  const addHeader = () => setHeaders((cur) => [...cur, { key: "", value: "" }]);
  const removeHeader = (idx: number) => setHeaders((cur) => cur.filter((_, i) => i !== idx));

  const pullModels = async () => {
    setPullingModels(true);
    setError(undefined);
    try {
      const res = await fetch(`${apiBase}/api/providers/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider.name, refresh: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      const models = Array.isArray(body.models) ? body.models : [];
      setAvailableModels(models);
      if (!defaultModel && models.length > 0) setDefaultModel(models[0]);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setPullingModels(false);
    }
  };

  const submit = async () => {
    setError(undefined);
    const trimmedAdapter = adapter.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedLabel = label.trim();
    if (!trimmedAdapter) { setError(t("prov.editAdapterRequired")); return; }
    if (!trimmedBaseUrl) { setError(t("prov.editBaseUrlRequired")); return; }
    // Build headers object, skipping rows where key is empty (treated as deletion).
    const headersObj: Record<string, string> = {};
    for (const h of headers) {
      const k = h.key.trim();
      if (!k) continue;
      headersObj[k] = h.value;
    }
    const trimmedDefaultModel = defaultModel.trim();
    setSaving(true);
    try {
      const trimmedRename = renameTo.trim();
    const wantsRename = trimmedRename !== "" && trimmedRename !== provider.name;
    if (wantsRename) {
      if (existingProviderNames && existingProviderNames.includes(trimmedRename)) {
        setError(t("prov.editRenameTaken", { name: trimmedRename }));
        setSaving(false);
        return;
      }
      if (!confirmingRename) {
        setConfirmingRename(true);
        setError(t("prov.editRenameConfirm", { from: provider.name, to: trimmedRename }));
        setSaving(false);
        return;
      }
    }
    await onSave({
      label: trimmedLabel || undefined,
      renameTo: wantsRename ? trimmedRename : undefined,
      adapter: trimmedAdapter,
      baseUrl: trimmedBaseUrl,
      defaultModel: trimmedDefaultModel || undefined,
      liveModels,
      headers: headersObj,
    });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("prov.editTitle", { name: provider.name })}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
        mouseDownOnOverlay.current = false;
      }}
    >
      <div
        className="card"
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "88vh",
          overflow: "auto",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onMouseDown={() => { mouseDownOnOverlay.current = false; }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("prov.editTitle", { name: provider.name })}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <IconX width={14} height={14} />
          </button>
        </div>

        <div className="muted" style={{ fontSize: 12 }}>
          {t("prov.editSubtitle")}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="edit-label" style={{ fontSize: 12, fontWeight: 500 }}>
            {t("prov.editLabelLabel")}
          </label>
          <input
            id="edit-label"
            ref={firstFieldRef}
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("prov.editLabelPlaceholder", { name: provider.name })}
            spellCheck={false}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="edit-rename" style={{ fontSize: 12, fontWeight: 500 }}>
            {t("prov.editInternalNameLabel")}
          </label>
          <input
            id="edit-rename"
            className="input"
            value={renameTo}
            onChange={(e) => { setRenameTo(e.target.value); setConfirmingRename(false); }}
            placeholder={provider.name}
            spellCheck={false}
            style={{ fontFamily: "var(--mono)", fontSize: 13 }}
            data-testid="edit-internal-name"
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {t("prov.editInternalNameHint")}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="edit-adapter" style={{ fontSize: 12, fontWeight: 500 }}>
            {t("prov.editAdapterLabel")}
          </label>
          <select
            id="edit-adapter"
            className="input"
            value={adapterIsCustom ? SENTINEL_OTHER : adapter}
            onChange={(e) => {
              const v = e.target.value;
              if (v === SENTINEL_OTHER) { setAdapterIsCustom(true); }
              else { setAdapterIsCustom(false); setAdapter(v); }
            }}
            style={{ fontFamily: "var(--mono)", fontSize: 13 }}
          >
            {ADAPTER_CHOICES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
          {adapterIsCustom ? (
            <input
              className="input"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              placeholder="custom-adapter-name"
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 12, marginTop: 4 }}
              data-testid="edit-adapter-custom"
            />
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="edit-baseurl" style={{ fontSize: 12, fontWeight: 500 }}>
            {t("prov.editBaseUrlLabel")}
          </label>
          <input
            id="edit-baseurl"
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            style={{ fontFamily: "var(--mono)", fontSize: 13 }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="edit-defaultmodel" style={{ fontSize: 12, fontWeight: 500 }}>
            {t("prov.editDefaultModelLabel")}
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <select
              id="edit-defaultmodel"
              className="input"
              value={modelIsCustom ? "__custom__" : defaultModel}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") { setModelIsCustom(true); }
                else { setModelIsCustom(false); setDefaultModel(v); }
              }}
              style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 13 }}
            >
              <option value="">— {t("prov.editDefaultModelNone")} —</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="__custom__">{t("prov.editDefaultModelCustom")}</option>
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={pullModels}
              disabled={pullingModels}
              title={t("prov.editPullModelsTitle")}
              data-testid="edit-pull-models"
            >
              {pullingModels ? t("prov.editPulling") : t("prov.editPull")}
            </button>
          </div>
          {modelIsCustom ? (
            <input
              className="input"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder="model-id-here"
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 12 }}
              data-testid="edit-defaultmodel-custom"
            />
          ) : null}
          {availableModels.length === 0 ? (
            <span className="muted" style={{ fontSize: 11 }}>
              {t("prov.editNoModelsHint")}
            </span>
          ) : null}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={liveModels}
            onChange={(e) => setLiveModels(e.target.checked)}
            data-testid="edit-live-models"
          />
          <span>{t("prov.editLiveModelsLabel")}</span>
        </label>

        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowHeaders((s) => !s)}
            aria-expanded={showHeaders}
          >
            {showHeaders ? t("prov.editHeadersHide") : t("prov.editHeadersShow")}
            {headers.length > 0 ? " (" + headers.length + ")" : ""}
          </button>
          {showHeaders ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {headers.map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="input"
                    value={h.key}
                    placeholder={t("prov.editHeaderKeyPlaceholder")}
                    onChange={(e) => updateHeader(i, "key", e.target.value)}
                    spellCheck={false}
                    style={{ flex: "0 0 40%", fontFamily: "var(--mono)", fontSize: 12 }}
                  />
                  <input
                    className="input"
                    value={h.value}
                    placeholder={t("prov.editHeaderValuePlaceholder")}
                    onChange={(e) => updateHeader(i, "value", e.target.value)}
                    spellCheck={false}
                    style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeHeader(i)}
                    aria-label={t("prov.editHeaderRemoveAria", { idx: i + 1 })}
                    title={t("common.remove")}
                  >
                    <IconX width={12} height={12} />
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addHeader}>
                {t("prov.editHeaderAdd")}
              </button>
            </div>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              color: "var(--danger)", fontSize: 12,
              padding: "6px 10px", border: "1px solid var(--danger)",
              borderRadius: 4, background: "rgba(220,38,38,0.08)",
            }}
          >
            <IconAlert width={14} height={14} /> <span>{error}</span>
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={saving}
            data-testid="edit-save"
          >
            {saving ? t("prov.editSaving") : t("prov.editSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
