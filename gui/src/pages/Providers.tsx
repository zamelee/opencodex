import { useEffect, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower, IconChevron } from "../icons";
import { useT } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import { formatRelativeTime } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";
import KeyPoolPanel from "../components/KeyPoolPanel";
import { providerIconSrc } from "../provider-icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, {
    adapter: string;
    baseUrl: string;
    hasApiKey?: boolean;
    hasHeaders?: boolean;
    defaultModel?: string;
    testModel?: string;
    models?: string[];
    authMode?: string;
    disabled?: boolean;
  }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }

// Friendly labels for the OAuth providers the proxy supports.
const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

export default function Providers({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<Array<{ id: string; adapter: string }>>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReport>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string } | null>(null);
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  const [keyPools, setKeyPools] = useState<Record<string, ApiKeyEntry[]>>({});
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState("");
  // Reveal state: { [provider]: { [keyId]: fullKey } }. Setting a key here replaces the masked
  // label in the row. Cleared on hide or when the pool reloads.
  const [revealedKeys, setRevealedKeys] = useState<Record<string, Record<string, string>>>({});
  // Show-all toggle per provider. When true, every key in the pool is auto-revealed (the
  // reveal state above is populated lazily as the user hovers a row, but the toggle also
  // forces an immediate reveal-all).
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  // Test status per (provider, keyId). `undefined` means idle; "loading" hides result text.
  const [keyTests, setKeyTests] = useState<Record<string, Record<string, { status: "loading" | "ok" | "fail" | "unknown"; latencyMs?: number; error?: string }>>>({});
  // Test-model picker state. Models and selection are read directly from `config.providers[name]`
  // (already in /api/config response) so we don't have to keep them in sync. We only need
  // transient loading + error state per provider for the 拉取模型 button.
  const [pullingModels, setPullingModels] = useState<Record<string, boolean>>({});
  const [providerModelError, setProviderModelError] = useState<Record<string, string | undefined>>({});

  const aliveRef = useRef(true);

  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  };

  // Load the list of OAuth-capable providers, then each one's login status.
  const fetchOauth = async () => {
    try {
      const data = await fetch(`${apiBase}/api/oauth/providers`).then(r => r.json()) as { providers?: Array<{ id: string; adapter: string }> };
      const provs = data.providers ?? [];
      setOauthProviders(provs);
      const entries = await Promise.all(provs.map(async p => {
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${p.id}`).then(r => r.json()).catch(() => ({ loggedIn: false }));
        return [p.id, s] as const;
      }));
      setOauthStatus(Object.fromEntries(entries));
    } catch { /* ignore */ }
  };

  const fetchProviderQuotas = async (refresh = false) => {
    try {
      const data = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`).then(r => r.json()) as { reports?: ProviderQuotaReport[] };
      setQuotaReports(Object.fromEntries((data.reports ?? []).map(report => [report.provider, report])));
    } catch {
      setQuotaReports({});
    }
  };

  // Multiauth: per-provider logged-in account lists for the card dropdowns (oauth cards only;
  // the Codex/ChatGPT passthrough pool has its own page).
  const fetchAccountSets = async (providers: string[]) => {
    const entries = await Promise.all(providers.map(async p => {
      const data = await fetch(`${apiBase}/api/oauth/accounts?provider=${p}`).then(r => r.json()).catch(() => null) as { activeAccountId?: string | null; accounts?: OAuthAccount[] } | null;
      return [p, { activeAccountId: data?.activeAccountId ?? null, accounts: data?.accounts ?? [] }] as const;
    }));
    setAccountSets(Object.fromEntries(entries));
  };

  const switchAccount = async (provider: string, account: OAuthAccount) => {
    if (account.active) return;
    const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, accountId: account.id }),
    });
    if (res.ok) {
      notify(t("prov.accountSwitched", { email: account.email ?? account.id }), true);
      fetchAccountSets(Object.keys(accountSets));
      fetchOauth();
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.accountSwitchFail"), false);
    }
  };

  // Multi-key pool (API-key twin of OAuth multiauth): list masked keys per key-auth provider.
  const fetchKeyPools = async (providers: string[]) => {
    const entries = await Promise.all(providers.map(async name => {
      const data = await fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(name)}`).then(r => r.json()).catch(() => null) as { keys?: ApiKeyEntry[] } | null;
      return [name, data?.keys ?? []] as const;
    }));
    setKeyPools(Object.fromEntries(entries));
  };

  const switchApiKey = async (provider: string, entry: ApiKeyEntry) => {
    if (entry.active) return;
    const res = await fetch(`${apiBase}/api/providers/keys/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, id: entry.id }),
    });
    if (res.ok) {
      notify(t("prov.keySwitched", { key: entry.label ?? entry.masked }), true);
      fetchKeyPools(Object.keys(keyPools));
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.keySwitchFail"), false);
    }
  };

  const removeApiKey = async (provider: string, entry: ApiKeyEntry) => {
    if (!window.confirm(t("prov.keyRemoveConfirm", { key: entry.label ?? entry.masked }))) return;
    const res = await fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(provider)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    if (res.ok) {
      notify(t("prov.keyRemoved", { key: entry.label ?? entry.masked }), true);
      fetchKeyPools(Object.keys(keyPools));
      fetchConfig();
      fetchProviderQuotas(true);
    }
  };

  const addApiKey = async (provider: string) => {
    const key = newKeyValue.trim();
    if (!key) return;
    const res = await fetch(`${apiBase}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, key }),
    });
    if (res.ok) {
      notify(t("prov.keyAdded", { name: provider }), true);
      setNewKeyValue("");
      setAddingKeyFor(null);
      fetchKeyPools(Object.keys(keyPools).includes(provider) ? Object.keys(keyPools) : [...Object.keys(keyPools), provider]);
      fetchConfig();
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.keyAddFail"), false);
    }
  };
  const revealOne = async (provider: string, id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/providers/keys/reveal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, id }),
      });
      if (!res.ok) { notify(t("prov.keyRevealFail"), false); return; }
      const body = await res.json() as { id: string; key: string };
      setRevealedKeys(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [body.id]: body.key } }));
    } catch {
      notify(t("prov.keyRevealFail"), false);
    }
  };
  const hideOne = (provider: string, id: string) => {
    setRevealedKeys(prev => {
      const next = { ...(prev[provider] ?? {}) };
      delete next[id];
      return { ...prev, [provider]: next };
    });
  };
  const toggleShowAll = async (provider: string, entries: ApiKeyEntry[]) => {
    const next = !showAll[provider];
    setShowAll(prev => ({ ...prev, [provider]: next }));
    if (next) {
      // Reveal every entry that's not already revealed.
      const toFetch = entries.filter(e => !revealedKeys[provider]?.[e.id]);
      const fetched = await Promise.all(toFetch.map(async e => {
        try {
          const res = await fetch(`${apiBase}/api/providers/keys/reveal`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: provider, id: e.id }),
          });
          if (!res.ok) return null;
          const body = await res.json() as { id: string; key: string };
          return [body.id, body.key] as const;
        } catch {
          return null;
        }
      }));
      const merged: Record<string, string> = { ...(revealedKeys[provider] ?? {}) };
      for (const pair of fetched) if (pair) merged[pair[0]] = pair[1];
      setRevealedKeys(prev => ({ ...prev, [provider]: merged }));
    } else {
      // Hide all = drop every revealed entry for this provider.
      setRevealedKeys(prev => ({ ...prev, [provider]: {} }));
    }
  };
  const testOne = async (provider: string, id: string) => {
    setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "loading" } } }));
    try {
      const res = await fetch(`${apiBase}/api/providers/keys/test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, id }),
      });
      const body = await res.json() as { ok: boolean | "unknown"; latencyMs?: number } | { error: string };
      if ("error" in body) {
        setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "fail", error: body.error } } }));
        return;
      }
      setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: body.ok === true ? "ok" : body.ok === false ? "fail" : "unknown", ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}) } } }));
    } catch (err) {
      setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "fail", error: String(err) } } }));
    }
  };

  // Pull the model list for a provider. Cache hits return immediately; refresh=true forces
  // a live fetch and persists the result to provider.models. After success we re-fetch the
  // full config so `provider.models` and any newly-saved `testModel` show up in the dropdown.
  const pullProviderModels = async (provider: string, refresh = false) => {
    setPullingModels(prev => ({ ...prev, [provider]: true }));
    setProviderModelError(prev => { const next = { ...prev }; delete next[provider]; return next; });
    try {
      const res = await fetch(`${apiBase}/api/providers/models`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, refresh }),
      });
      const body = await res.json() as { models?: string[]; source?: "cached" | "live"; error?: string };
      if (!res.ok || body.error || !body.models) {
        setProviderModelError(prev => ({ ...prev, [provider]: body.error || `HTTP ${res.status}` }));
        return;
      }
      // Refresh full config so the dropdown sees the freshly cached list.
      fetchConfig();
    } catch (err) {
      setProviderModelError(prev => ({ ...prev, [provider]: String(err) }));
    } finally {
      setPullingModels(prev => ({ ...prev, [provider]: false }));
    }
  };

  // Persist the user's selection of test model. Empty string = clear override (use defaultModel).
  const selectTestModel = async (provider: string, model: string) => {
    try {
      const res = await fetch(`${apiBase}/api/providers/test-model`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, model: model === "" ? null : model }),
      });
      const body = await res.json() as { testModel?: string | null; error?: string };
      if (!res.ok || body.error) {
        notify(body.error || `HTTP ${res.status}`, false);
        return;
      }
      // Refresh full config so the saved testModel shows up.
      fetchConfig();
    } catch (err) {
      notify(String(err), false);
    }
  };

  const removeAccount = async (provider: string, account: OAuthAccount) => {
    if (!window.confirm(t("prov.accountRemoveConfirm", { email: account.email ?? account.id }))) return;
    const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${provider}&id=${encodeURIComponent(account.id)}`, { method: "DELETE" });
    if (res.ok) {
      notify(t("prov.accountRemoved", { email: account.email ?? account.id }), true);
      fetchAccountSets(Object.keys(accountSets));
      fetchOauth();
      fetchProviderQuotas(true);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetchOauth();
    fetchProviderQuotas();
  }, [apiBase]);

  // Load account sets once config tells us which providers are oauth-backed.
  const oauthCardProviders = config ? Object.entries(config.providers).filter(([, p]) => p.authMode === "oauth").map(([n]) => n) : [];
  const oauthCardKey = oauthCardProviders.join(",");
  useEffect(() => {
    if (oauthCardProviders.length > 0) fetchAccountSets(oauthCardProviders);
  }, [apiBase, oauthCardKey]);

  // Load key pools for key-auth providers that already have a key configured.
  const keyCardProviders = config
    ? Object.entries(config.providers)
        .filter(([, p]) => p.hasApiKey && p.authMode !== "oauth" && p.authMode !== "forward")
        .map(([n]) => n)
    : [];
  const keyCardKey = keyCardProviders.join(",");
  useEffect(() => {
    if (keyCardProviders.length > 0) fetchKeyPools(keyCardProviders);
  }, [apiBase, keyCardKey]);

  const saveConfig = async () => {
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        notify(t("prov.saved"), true);
        setEditing(false);
        fetchConfig();
        fetchProviderQuotas(true);
      } else {
        notify(t("prov.saveFailed"), false);
      }
    } catch {
      notify(t("prov.invalidJson"), false);
    }
  };

  const loginOAuth = async (provider: string, addAccount = false) => {
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addAccount ? { provider, addAccount: true } : { provider }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      // The server opens the browser itself (popup-safe). Show the URL/device code as a fallback.
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions });
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      // Poll until the loopback callback (or device flow) completes.
      for (let i = 0; i < 150 && aliveRef.current; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s: (OAuthStatus & { accounts?: OAuthAccount[] }) | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        // For add-account flows the provider is already "logged in": wait for the account count to grow.
        // addAccount: wait for a new slot OR flow completion (same-account re-login won't grow count).
        const completed = addAccount
          ? ((s.accounts?.length ?? 0) > baselineCount || (s.done === true && !s.error))
          : s.loggedIn;
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          setLoginInfo(null);
          fetchConfig();
          fetchAccountSets(Object.keys(accountSets).includes(provider) ? Object.keys(accountSets) : [...Object.keys(accountSets), provider]);
          fetchProviderQuotas(true);
          break;
        }
        if (s.error) { setOauthStatus(prev => ({ ...prev, [provider]: s })); notify(t("prov.loginError", { provider: oauthLabel(provider), error: s.error }), false); break; }
      }
    } catch {
      notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  const logoutOAuth = async (provider: string) => {
    await fetch(`${apiBase}/api/oauth/logout?provider=${provider}`, { method: "POST" }).catch(() => {});
    setOauthStatus(prev => ({ ...prev, [provider]: { loggedIn: false } }));
    notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    fetchConfig();
    fetchProviderQuotas(true);
  };

  const removeProvider = async (name: string) => {
    if (!window.confirm(t("prov.removeConfirm", { name }))) return;
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) { notify(t("prov.removed", { name }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); }
    else notify(t("prov.removeFail", { name }), false);
  };
  const setDefaultProvider = async (name: string) => {
    if (!config || name === config.defaultProvider) return; // no-op
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setDefault: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) { notify(body.error || `HTTP ${res.status}`, false); return; }
      notify(t("prov.defaultChanged", { name }), true);
      // fetchConfig reloads the new defaultProvider; the disabled/remove buttons re-evaluate
      // isDefault on the next render so the previous default becomes editable.
      fetchConfig();
      fetchOauth();
      fetchProviderQuotas(true);
    } catch (err) {
      notify(String(err), false);
    }
  };

  const setProviderDisabled = async (name: string, disabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (res.ok) {
      notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
      fetchConfig();
      fetchOauth();
      fetchProviderQuotas(true);
      return;
    }
    const data = await res.json().catch(() => ({}));
    notify(data.error || (disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name })), false);
  };

  if (!config) return <div className="muted">{t("prov.loadingConfig")}</div>;

  // API-key providers shown alongside OAuth logins in the account panel.
  const keyProviders = Object.entries(config.providers)
    .filter(([name, prov]) => prov.hasApiKey && prov.authMode !== "oauth" && prov.authMode !== "forward" && !oauthProviders.some(p => p.id === name))
    .map(([name]) => name);

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={saveConfig}>{t("common.save")}</button>
              <button className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(JSON.stringify(config, null, 2)); }}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>{t("prov.editJson")}</button>
            </>
          )}
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>

      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}

      {/* OAuth Login — every OAuth-capable provider, with its live login status. */}
      <div className="panel panel-accent" style={{ marginBottom: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
          <span style={{ fontWeight: 600 }}>{t("prov.accountLogin")}</span>
        </div>
        <div className="oauth-grid">
          {oauthProviders.length === 0 && keyProviders.length === 0 && (
            <span className="muted" style={{ fontSize: 13, gridColumn: "1 / -1" }}>{t("prov.noOauth")}</span>
          )}
          {oauthProviders.map(p => {
            const st = oauthStatus[p.id] ?? { loggedIn: false };
            const isBusy = busy === p.id;
            const icon = providerIconSrc(p.id);
            return (
              <div key={p.id} className="oauth-row">
                <span className="oauth-name" title={oauthLabel(p.id)}>
                  <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                  <span className="oauth-name-text">{p.id}</span>
                </span>
                <span className="oauth-type muted" title={`Adapter: ${p.adapter}`}>{p.adapter}</span>
                <span className="oauth-status">
                  <span className={`dot ${st.loggedIn ? "dot-green" : "dot-muted"}`} />
                  {st.loggedIn ? (
                    <span className="oauth-email" style={{ color: "var(--green)" }}>{st.email ?? t("prov.loggedIn")}</span>
                  ) : (
                    <span className="oauth-email muted">{t("prov.notLoggedIn")}</span>
                  )}
                </span>
                <span className="oauth-actions">
                  {st.loggedIn ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(p.id)}>{t("prov.logout")}</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => loginOAuth(p.id)} disabled={isBusy}>
                      {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.login")}</>}
                    </button>
                  )}
                </span>
                {loginInfo?.provider === p.id && (loginInfo.url || loginInfo.instructions) && (
                  <span className="oauth-login-hint muted">
                    {loginInfo.url && <a href={loginInfo.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconExternal />{t("prov.didntOpen")}</a>}
                    {loginInfo.instructions && <span>{loginInfo.instructions}</span>}
                  </span>
                )}
              </div>
            );
          })}
          {keyProviders.map(name => {
            const icon = providerIconSrc(name);
            const keyProvider = config.providers[name];
            return (
              <div key={name} className="oauth-row">
                <span className="oauth-name" title={name}>
                  <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                  <span className="oauth-name-text">{name}</span>
                </span>
                {keyProvider?.adapter ? (
                  <span className="oauth-type muted" title={`Adapter: ${keyProvider.adapter}`}>{keyProvider.adapter}</span>
                ) : null}
                <span className="oauth-status">
                  <span className="dot dot-green" />
                  <span className="oauth-email muted">{t("prov.hasApiKey")}</span>
                </span>
                <span className="oauth-actions" aria-hidden="true" />
              </div>
            );
          })}
        </div>
      </div>

      {editing ? (
        <textarea
          className="input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ height: 400 }}
        />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            {t("prov.port")}: <code className="chip">{config.port}</code> · {t("prov.default")}:{" "}
          <select
            className="input-sm"
            value={config.defaultProvider ?? ""}
            onChange={e => setDefaultProvider(e.target.value)}
            aria-label={t("prov.default")}
            style={{ fontSize: 12, padding: "1px 8px" }}
            disabled={Object.keys(config.providers).length < 2}
            title={t("prov.defaultSwitchHint")}
          >
            {Object.keys(config.providers).map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          </div>
          {Object.entries(config.providers).map(([name, prov]) => {
            const isDefault = name === config.defaultProvider;
            const isDisabled = prov.disabled === true;
            const quota = quotaReports[name]?.quota ?? null;
            const icon = providerIconSrc(name);
            const accountSet = prov.authMode === "oauth" ? accountSets[name] : undefined;
            const isKeyAuth = prov.authMode !== "oauth" && prov.authMode !== "forward";
            const keyPool = isKeyAuth && prov.hasApiKey ? (keyPools[name] ?? []) : [];
            const showAccounts = (!!accountSet && accountSet.accounts.length > 0) || keyPool.length > 0;
            const accountsOpen = openAccounts[name] !== false;
            const dropdownCount = accountSet?.accounts.length ?? keyPool.length;
            return (
              <div key={name} className={`card prov-card${isDisabled ? " prov-card-disabled" : ""}`}>
                <div className="prov-card-main">
                  <div className="prov-card-info">
                    {icon && <span className="provider-icon"><img src={icon} alt="" aria-hidden="true" /></span>}
                    <div className="prov-card-copy">
                      <div className="prov-title">
                        <span style={{ fontWeight: 600 }}>{name}</span>
                        {isDefault && <span className="badge badge-primary">{t("prov.defaultBadge")}</span>}
                        {isDisabled ? <span className="badge badge-muted">{t("prov.disabledBadge")}</span> : <span className="badge badge-green">{t("prov.activeBadge")}</span>}
                        {prov.authMode === "oauth" && <span className="badge badge-accent">oauth</span>}
                        {prov.authMode === "forward" && <span className="badge badge-amber">passthrough</span>}
                      </div>
                      <div className="muted prov-meta" style={{ fontSize: 13 }}>
                        <code className="chip">{prov.adapter}</code>
                        <span>{prov.baseUrl}</span>
                        {prov.defaultModel && <span>{prov.defaultModel}</span>}
                        {prov.hasApiKey && <span>{t("prov.hasApiKey")}</span>}
                        {prov.hasHeaders && <span>{t("prov.hasHeaders")}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="provider-actions">
                    <button
                      className={`btn ${isDisabled ? "btn-primary" : "btn-ghost"} btn-sm`}
                      onClick={() => setProviderDisabled(name, !isDisabled)}
                      disabled={isDefault}
                      title={isDefault ? t("prov.defaultCannotDisable") : undefined}
                      aria-label={isDisabled ? t("prov.enableAria", { name }) : t("prov.disableAria", { name })}
                    >
                      {isDefault ? <IconLock /> : <IconPower />}
                      {isDisabled ? t("prov.enable") : t("prov.disable")}
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => removeProvider(name)}
                      disabled={isDefault}
                      title={isDefault ? t("prov.defaultCannotRemove") : undefined}
                      aria-label={t("sub.removeAria", { m: name })}
                    ><IconTrash />{t("common.remove")}</button>
                  </div>
                </div>
                {quota && <QuotaBars quota={quota} threshold={80} t={t} className="provider-quota" />}
                {quota && (
                  <div className="muted" style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 4 }}>
                    {quota.planLabel && <span><strong>{quota.planLabel}</strong></span>}
                    {quota.expiresAt !== undefined && (
                      <span>{t("prov.expiresIn", { n: String(Math.max(0, Math.ceil((quota.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))))})}</span>
                    )}
                    <span>· {formatRelativeTime(quota.updatedAt)}</span>
                  </div>
                )}
                {showAccounts && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <button
                        className={`prov-accounts-toggle${accountsOpen ? " open" : ""}`}
                        onClick={() => setOpenAccounts(prev => ({ ...prev, [name]: !accountsOpen }))}
                        aria-expanded={accountsOpen !== false}
                        aria-label={t("prov.accountsAria", { name })}
                      >
                        {t("prov.accounts", { n: String(dropdownCount) })}
                        <span className="chev"><IconChevron /></span>
                      </button>
                      {isKeyAuth ? (
                        addingKeyFor === name ? (
                          <button className="btn btn-ghost btn-sm" onClick={() => { setAddingKeyFor(null); setNewKeyValue(""); }}>
                            {t("common.cancel")}
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => { setAddingKeyFor(name); setNewKeyValue(""); }}
                            title={t("prov.keyAddTitle")}
                          >
                            <IconPlus style={{ width: 12, height: 12 }} />{t("prov.keyAdd")}
                          </button>
                        )
                      ) : null}
                      {isKeyAuth && keyPool.length > 1 ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => toggleShowAll(name, keyPool)}
                          title={showAll[name] ? t("prov.keyHideAllTitle") : t("prov.keyRevealAllTitle")}
                          aria-pressed={showAll[name] === true}
                        >
                          {showAll[name] ? t("prov.keyHideAll") : t("prov.keyRevealAll")}
                        </button>
                      ) : null}
                    </div>
                                        {accountsOpen !== false && isKeyAuth ? (() => {
                      const provConf = config.providers[name];
                      const provTestModel = provConf?.testModel;
                      const provModels: string[] = Array.isArray(provConf?.models) ? provConf.models : [];
                      return (
                        <div className="prov-test-model" style={{
                          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                          padding: "6px 8px", borderTop: "1px solid var(--border-soft)",
                          borderBottom: "1px solid var(--border-soft)",
                          background: "var(--raised)",
                        }}>
                          <label className="muted" style={{ fontSize: 11 }}>{t("prov.testModel")}</label>
                          <select
                            className="input-sm"
                            value={provTestModel ?? ""}
                            onChange={e => selectTestModel(name, e.target.value)}
                            aria-label={t("prov.testModel")}
                            style={{ flex: "1 1 160px", minWidth: 120 }}
                            disabled={!!pullingModels[name]}
                          >
                            <option value="">{t("prov.testModelDefault")}</option>
                            {provModels.map(m => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => pullProviderModels(name, false)}
                            disabled={!!pullingModels[name]}
                            aria-label={t("prov.pullModelsAria", { name })}
                            title={t("prov.pullModels")}
                            style={{ fontSize: 11 }}
                          >
                            {pullingModels[name] ? (
                              <><span className="spin" />{t("prov.pullModelsLoading")}</>
                            ) : (
                              t("prov.pullModels")
                            )}
                          </button>
                          {provModels.length > 0 ? (
                            <span className="muted" style={{ fontSize: 10.5 }}>
                              {t("prov.modelsJustPulled", { count: provModels.length })}
                            </span>
                          ) : null}
                          {providerModelError[name] ? (
                            <span className="muted" style={{ fontSize: 10.5, color: "var(--red)" }}>
                              {t("prov.pullModelsFail", { error: providerModelError[name] })}
                            </span>
                          ) : null}
                        </div>
                      );
                    })() : null}
                    {accountsOpen !== false && (
                      <div className="prov-accounts-list">
                        {(accountSet?.accounts ?? []).map(account => (
                          <button
                            key={account.id}
                            className={`prov-account-row${account.active ? " active" : ""}`}
                            onClick={() => switchAccount(name, account)}
                            title={account.active ? undefined : t("prov.accountSwitchTitle")}
                          >
                            <span className={`dot ${account.needsReauth ? "dot-amber" : account.active ? "dot-green" : "dot-muted"}`} />
                            <span className="prov-account-email">{account.email ?? t("prov.accountNoLabel", { id: account.id })}</span>
                            {account.needsReauth && <span className="badge badge-amber">{t("prov.accountReauth")}</span>}
                            {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                            <span
                              className="prov-account-remove"
                              role="button"
                              aria-label={t("prov.accountRemoveAria", { email: account.email ?? account.id })}
                              onClick={e => { e.stopPropagation(); removeAccount(name, account); }}
                            >
                              <IconTrash style={{ width: 13, height: 13 }} />
                            </span>
                          </button>
                        ))}
                        {keyPool.map((entry, idx) => {
                          const qk = (quota?.keys ?? []).find(q => q.id === entry.id);
                          const onSwitch = () => switchApiKey(name, entry);
                          const onRemove = (e: React.MouseEvent) => { e.stopPropagation(); removeApiKey(name, entry); };
                          // Synthesize a minimal KeyQuota when quota data is absent (probe failed, first poll
                          // pending, etc.). updatedAt=0 marks the row as 'no data yet'.
                          const quotaProp = qk
                            ? { ...qk, label: qk.label ?? entry.label }
                            : { id: entry.id, label: entry.label, masked: entry.masked, active: entry.active, updatedAt: 0 };
                          return (
                            <KeyPoolPanel
                              key={entry.id}
                              quota={quotaProp}
                              index={idx}
                              active={entry.active}
                              onSwitch={entry.active ? undefined : onSwitch}
                              onRemove={onRemove}
                              {...(revealedKeys[name]?.[entry.id] !== undefined ? { revealedKey: revealedKeys[name]![entry.id]! } : {})}
                              onReveal={() => revealOne(name, entry.id)}
                              onHide={() => hideOne(name, entry.id)}
                              onTest={() => testOne(name, entry.id)}
                              {...(keyTests[name]?.[entry.id] ? { testStatus: keyTests[name]![entry.id]!.status, ...(keyTests[name]![entry.id]!.latencyMs !== undefined ? { testLatencyMs: keyTests[name]![entry.id]!.latencyMs } : {}), ...(keyTests[name]![entry.id]!.error ? { testError: keyTests[name]![entry.id]!.error } : {}) } : {})}
                              t={t}
                            />
                          );
                        })}
                        {accountSet ? (
                          <button className="prov-account-row prov-account-add" onClick={() => loginOAuth(name, true)} disabled={busy === name}>
                            {busy === name ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconPlus style={{ width: 13, height: 13 }} />{t("prov.accountAdd")}</>}
                          </button>
                        ) : addingKeyFor === name ? (
                          <div className="prov-account-row prov-account-keyform">
                            <input
                              className="input input-sm mono"
                              type="password"
                              autoFocus
                              placeholder={t("prov.keyPlaceholder")}
                              value={newKeyValue}
                              onChange={e => setNewKeyValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") addApiKey(name);
                                if (e.key === "Escape") { setAddingKeyFor(null); setNewKeyValue(""); }
                              }}
                            />
                            <button className="btn btn-primary btn-sm" onClick={() => addApiKey(name)} disabled={!newKeyValue.trim()}>{t("common.save")}</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => { setAddingKeyFor(null); setNewKeyValue(""); }}>{t("common.cancel")}</button>
                          </div>
                        ) : (
                          <button className="prov-account-row prov-account-add" onClick={() => { setAddingKeyFor(name); setNewKeyValue(""); }}>
                            <IconPlus style={{ width: 13, height: 13 }} />{t("prov.keyAdd")}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          onClose={() => setAdding(false)}
          onAdded={(name) => { setAdding(false); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); }}
        />
      )}
    </>
  );
}
