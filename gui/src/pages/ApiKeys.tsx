import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconX, IconCheck, IconEye, IconEyeOff, IconCopy } from "../icons";
import { useI18n, LOCALES } from "../i18n";
import { copyToClipboard } from "../clipboard";

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

// One row's reveal state: full key + a 30s auto-collapse timer handle. Cleared when
// the timer fires, the user toggles it back off, the key is deleted, or the page unmounts.
interface RevealEntry { key: string; timer: number; }
const REVEAL_TTL_MS = 30_000;
const COPY_FEEDBACK_MS = 1500;

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // id -> {key, timer}. timer is the auto-collapse setTimeout handle; cleared on
  // toggle off, delete, or unmount. Source of truth: server's POST /api/keys/reveal.
  const [revealed, setRevealed] = useState<Record<string, RevealEntry>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  // Tracks which row is currently waiting on a reveal response, so the row's
  // reveal/copy buttons can disable and we don't fire the request twice.
  const [revealInFlight, setRevealInFlight] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys ?? []);
        setEndpoint(data.endpoint ?? "");
      }
    } catch { /* proxy down */ }
  }, [apiBase]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);
  // Clear all reveal timers on unmount so they don't fire after the page is gone.
  useEffect(() => () => {
    setRevealed(prev => {
      Object.values(prev).forEach(r => window.clearTimeout(r.timer));
      return {};
    });
  }, []);

  const responseEndpoint = endpoint || "http://127.0.0.1:10100/v1/responses";

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName || "default" }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewKey(data.key);
        setNewName("");
        fetchKeys();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    // Drop the deleted id's reveal entry + timer so it can't fire after deletion.
    setRevealed(prev => {
      if (!prev[id]) return prev;
      window.clearTimeout(prev[id].timer);
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
    setConfirmDelete(null);
    fetchKeys();
  };

  const copyKey = async () => {
    if (!newKey) return;
    const ok = await copyToClipboard(newKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setRevealError(t("apiKeys.copyError"));
    }
  };

  // Ask the server for the full key value. The auth-gate fetch wrapper handles 401
  // by popping the modal; here we surface only non-auth failures (e.g. 404 stale id).
  const fetchFullKey = async (id: string): Promise<string | null> => {
    if (revealInFlight) return null;
    setRevealInFlight(id);
    try {
      const res = await fetch(`${apiBase}/api/keys/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setRevealError(t("apiKeys.revealError"));
        return null;
      }
      const data = await res.json();
      setRevealError(null);
      return (data.key as string) ?? null;
    } catch {
      setRevealError(t("apiKeys.revealError"));
      return null;
    } finally {
      setRevealInFlight(prev => prev === id ? null : prev);
    }
  };

  // Schedule a 30s auto-collapse. Returns the timer handle so callers can stash it
  // in revealed[id].timer; the collapse itself removes the entry from state.
  const scheduleRevealCollapse = (id: string): number => {
    return window.setTimeout(() => {
      setRevealed(prev => {
        if (!prev[id]) return prev;
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
    }, REVEAL_TTL_MS);
  };

  const revealKey = async (id: string) => {
    const key = await fetchFullKey(id);
    if (!key) return;
    const timer = scheduleRevealCollapse(id);
    setRevealed(prev => ({ ...prev, [id]: { key, timer } }));
  };

  const hideKey = (id: string) => {
    setRevealed(prev => {
      if (!prev[id]) return prev;
      window.clearTimeout(prev[id].timer);
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  };

  const toggleReveal = (id: string) => {
    if (revealed[id]) hideKey(id);
    else revealKey(id);
  };

  const copyExistingKey = async (id: string) => {
    let key = revealed[id]?.key;
    if (!key) {
      const fetched = await fetchFullKey(id);
      if (!fetched) return;
      key = fetched;
      const timer = scheduleRevealCollapse(id);
      setRevealed(prev => ({ ...prev, [id]: { key, timer } }));
    }
    const ok = await copyToClipboard(key);
    if (ok) {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(prev => prev === id ? null : prev), COPY_FEEDBACK_MS);
    } else {
      setRevealError(t("apiKeys.copyError"));
    }
  };

  // Subtitle carries two inline <code> chips; split the localized string on both tokens.
  const subtitleParts = t("api.subtitle").split(/\{authHeader\}|\{altHeader\}/);

  return (
    <section className="api-page">
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <p className="page-sub">
        {subtitleParts[0]}
        <code>Authorization: Bearer ocx_...</code>
        {subtitleParts[1]}
        <code>x-opencodex-api-key</code>
        {subtitleParts[2]}
      </p>

      <div className="panel api-panel">
        <h3 className="panel-title">{t("api.endpoint")}</h3>
        <code className="api-code api-code-inline">{responseEndpoint}</code>
        <p className="muted small">{t("api.endpointNote")}</p>
      </div>

      {newKey && (
        <div className="panel api-panel panel-accent" style={{ marginTop: "1rem" }}>
          <h3 className="panel-title">{t("api.newKeyTitle")}</h3>
          <p className="muted small">{t("api.newKeyNote")}</p>
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button className="btn btn-sm btn-ghost" onClick={copyKey}>
              {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
            </button>
          </div>
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setNewKey(null)}>
            {t("api.dismiss")}
          </button>
        </div>
      )}

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.generateTitle")}</h3>
        <div className="api-form-row">
          <input
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="input"
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.activeKeys", { count: keys.length })}</h3>
        {revealError && (
          <div className="notice notice-err" style={{ marginBottom: 8, fontSize: 12 }}>
            {revealError}
          </div>
        )}
        {keys.length === 0 ? (
          <p className="muted">{t("api.noKeys")}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>{t("api.colName")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <code className="api-code-inline" style={{
                          flex: 1,
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          maxWidth: revealed[k.id] ? 360 : 180,
                          wordBreak: "break-all",
                        }}>
                          {revealed[k.id] ? revealed[k.id].key : k.prefix}
                        </code>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => toggleReveal(k.id)}
                          aria-label={revealed[k.id] ? t("apiKeys.hide") : t("apiKeys.reveal")}
                          title={revealed[k.id] ? t("apiKeys.hide") : t("apiKeys.reveal")}
                          disabled={revealInFlight === k.id}
                        >
                          {revealed[k.id] ? <IconEyeOff width={14} /> : <IconEye width={14} />}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => copyExistingKey(k.id)}
                          aria-label={t("apiKeys.copy")}
                          title={t("apiKeys.copy")}
                          disabled={revealInFlight === k.id}
                        >
                          {copiedId === k.id ? <IconCheck width={14} /> : <IconCopy width={14} />}
                        </button>
                      </div>
                    </td>
                    <td>{new Date(k.createdAt).toLocaleDateString(localeTag)}</td>
                    <td>
                      {confirmDelete === k.id ? (
                        <span className="api-actions">
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(k.id)}>{t("api.confirm")}</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</button>
                        </span>
                      ) : (
                        <button className="btn btn-sm btn-ghost" aria-label={t("api.deleteAria")} onClick={() => setConfirmDelete(k.id)}><IconX /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageTitle")}</h3>
        <pre className="api-code">{`curl ${responseEndpoint} \\
  -H "Authorization: Bearer ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello, world!"
  }'`}</pre>
      </div>
    </section>
  );
}
