import { useEffect, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import EditProviderModal, { type EditableProvider } from "../components/EditProviderModal";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower, IconChevron, IconEdit } from "../icons";
import { useT, type TFn } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import { formatRelativeTime } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";
import KeyPoolPanel from "../components/KeyPoolPanel";
import AuthMatrixPanel from "../components/AuthMatrixPanel";
import TestModelBadge from "../components/TestModelBadge";
import KeyTestResultDialog, {
  type ChatTestResult,
  type QuotaProbeResult,
} from "../components/KeyTestResultDialog";
import { hasFreshMatrixCache } from "../components/AuthMatrixPanel";
import { providerIconSrc } from "../provider-icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, {
    adapter: string;
    baseUrl: string;
    label?: string;
    hasApiKey?: boolean;
    hasHeaders?: boolean;
    defaultModel?: string;
    testModel?: string;
    models?: string[];
    authMode?: string;
    disabled?: boolean;
    liveModels?: boolean;
    /** Advertise the hosted web_search tool for this provider's models. Default OFF. */
    supportsSearchTool?: boolean;
    /** The context window advertised for this provider's models (provider-wide). */
    contextWindow?: number;
    /** Auth header strategy locked by the auth matrix, null = auto-detect. */
    modelListAuth?: string | null;
    /** Header VALUES are fetched on demand from /api/providers/headers — they are
     *  secrets, so they never ride in this config payload. */
    headers?: Record<string, string>;
  }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean; autoSwitch?: boolean }
interface KeyScheduleEvent { ts: number; fromId: string; toId: string; reason: string; fromFiveHourEst?: number; toFiveHourEst?: number; fiveHourResetAt?: number }
interface KeyScheduleState { enabled: boolean; threshold: number; activeId: string | null; nextUpId: string | null; events: KeyScheduleEvent[] }

/** "14:02 · (02) 5h 用量 88% → 切换至 (01)" — one scheduler rotation, pool ids as (NN) chips. */
function schedEventText(ev: KeyScheduleEvent, pool: ApiKeyEntry[], t: TFn): string {
  const chip = (id: string) => {
    const idx = pool.findIndex(k => k.id === id);
    return idx >= 0 ? `(${String(idx + 1).padStart(2, "0")})` : "(?)";
  };
  const time = new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const pct = ev.fromFiveHourEst !== undefined ? String(Math.round(ev.fromFiveHourEst * 100)) : "?";
  return t("prov.schedEvent", { time, from: chip(ev.fromId), to: chip(ev.toId), pct });
}

// Friendly labels for the OAuth providers the proxy supports.
const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

/** Skeleton row used while /api/providers/keys is still in flight. One per
 *  expected key — wide enough to read like a real row so the card doesn't
 *  visibly pop in once the data arrives. */
function AccountRowSkeleton({ tone = "dim" }: { tone?: "dim" | "muted" }) {
  return (
    <div className="prov-account-row prov-account-skeleton" style={{ cursor: "default" }}>
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      <span className="prov-account-skeleton-bar" aria-hidden="true" />
    </div>
  );
}

/** Per-provider visual identity: a left-border accent + a faint tinted
 *  background, picked by adapter so each card is recognisable at a glance
 *  even before the user reads the URL/adapter chip. Colors lean into the
 *  existing palette (warm/cool/violet/green) without colliding with the
 *  default blue used for the default-provider badge. */
function providerAccent(adapter: string | undefined): { border: string; tint: string } {
  const a = (adapter ?? "").toLowerCase();
  if (a.startsWith("anthropic")) return { border: "#e09a5f", tint: "rgba(224,154,95,0.06)" };
  if (a === "openai-chat") return { border: "#5fb1e3", tint: "rgba(95,177,227,0.06)" };
  if (a === "openai-responses") return { border: "#a285f5", tint: "rgba(162,133,245,0.06)" };
  if (a.startsWith("google")) return { border: "#5fc18a", tint: "rgba(95,193,138,0.06)" };
  if (a.startsWith("xai")) return { border: "#c98ad6", tint: "rgba(201,138,214,0.06)" };
  if (a === "kimi") return { border: "#d6c25f", tint: "rgba(214,194,95,0.06)" };
  if (a === "kiro") return { border: "#e35f7f", tint: "rgba(227,95,127,0.06)" };
  if (a === "cursor") return { border: "#7fc9c8", tint: "rgba(127,201,200,0.06)" };
  if (a === "chatgpt" || a === "openai-responses-forward") return { border: "#7a7a7a", tint: "rgba(122,122,122,0.05)" };
  return { border: "var(--blue)", tint: "rgba(88,166,255,0.05)" };
}

/** Tiny top-corner mark keyed off `authMode` so the three keyless/oauth/passthrough
 *  groups are distinguishable even before the badge row reads out. */
function authModeMark(authMode: string | undefined): string | null {
  switch (authMode) {
    case "oauth": return "oauth";
    case "forward": return "passthrough";
    case undefined:
    case "":
      return null;
    default:
      return null;
  }
}


// Browser-local (localStorage) storage for the 测试模型 dropdown selection. This is
// deliberately NOT part of the provider config: it is a per-machine UI preference that
// only decides which model the next 测试 / 拉取模型 call uses.
const testModelStorageKey = (name: string) => `ocx.testModel.${name}`;

function readTestModelLocal(name: string): string | null {
  try { return localStorage.getItem(testModelStorageKey(name)); } catch { return null; }
}

function writeTestModelLocal(name: string, value: string): void {
  try {
    if (value) localStorage.setItem(testModelStorageKey(name), value);
    else localStorage.removeItem(testModelStorageKey(name));
  } catch { /* private mode / quota — keep the in-memory value only */ }
}

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
  // Quota-scheduler snapshots per provider (threshold, next-up candidate, rotation events).
  const [keySchedules, setKeySchedules] = useState<Record<string, KeyScheduleState | null>>({});
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  // True while a PATCH /api/providers/key-schedule is in flight for the named
  // provider, so the threshold slider can show a disabled state and ignore rapid
  // repeat drags (debounced naturally by the request latency itself).
  const [savingThreshold, setSavingThreshold] = useState<string | null>(null);
  // Per-provider pending threshold (draft state for the Save/Cancel buttons).
  // A `null` entry means "no draft"; otherwise the value is the user's pending integer
  // percentage. Persisted value is fetched from /api/providers/key-schedule on mount.
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<string, number | null>>({});
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
  const [authMatrixOpen, setAuthMatrixOpen] = useState<string | null>(null);
  const [providerModelError, setProviderModelError] = useState<Record<string, string | undefined>>({});
  // Per-provider "test model" chosen in the 测试模型 dropdown. Purely local to the
  // browser (localStorage) and never synced back to provider.testModel /
  // provider.defaultModel: it only steers the NEXT 测试 / 拉取 call. Initial value
  // comes from provider.defaultModel, which stays the single source of truth.
  const [testModelLocal, setTestModelLocal] = useState<Record<string, string>>({});
  // Result of the real chat test (POST /api/providers/keys/chat-test), keyed by
  // provider then key id. Kept separate from `keyTests` (余量探测) so the dialog
  // can show both panes.
  const [keyChatTests, setKeyChatTests] = useState<Record<string, Record<string, ChatTestResult>>>({});
  // Which (provider, keyId) has the result dialog open, plus which pane to focus.
  const [testDialog, setTestDialog] = useState<{ provider: string; keyId: string; keyLabel: string; tab: "quota" | "chat" } | null>(null);

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
      // Scheduler state rides the same refresh cycle; null when the provider is not
      // quota-capable or the endpoint errors (UI hides all scheduler chrome then).
      const sched = await fetch(`${apiBase}/api/providers/key-schedule?name=${encodeURIComponent(name)}`).then(r => r.ok ? r.json() : null).catch(() => null) as KeyScheduleState | null;
      return [name, { keys: data?.keys ?? [], sched: sched && typeof sched.threshold === "number" ? sched : null }] as const;
    }));
    setKeyPools(Object.fromEntries(entries.map(([n, e]) => [n, e.keys])));
    setKeySchedules(Object.fromEntries(entries.map(([n, e]) => [n, e.sched])));
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

  /** Toggle whether a pool entry takes part in automatic key switching (user intent). */
  const toggleAutoSwitch = async (provider: string, entry: ApiKeyEntry, enabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers/keys/auto-switch`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, id: entry.id, enabled }),
    });
    if (res.ok) {
      notify(t(enabled ? "prov.keyAutoSwitchEnabled" : "prov.keyAutoSwitchDisabled", { key: entry.label ?? entry.masked }), true);
      fetchKeyPools(Object.keys(keyPools));
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.keyAutoSwitchFail"), false);
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
      const detail = (body as { detail?: string }).detail;
      setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: body.ok === true ? "ok" : body.ok === false ? "fail" : "unknown", ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}), ...(detail ? { error: detail } : {}) } } }));
    } catch (err) {
      setKeyTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "fail", error: String(err) } } }));
    }
  };

  // Real chat test: sends a minimal completion through the matrix-selected
  // (adapter, auth) using the dropdown's model, and returns the model's reply plus
  // token usage. This is the only button that proves "the key can actually talk".
  const chatTestOne = async (provider: string, id: string) => {
    const model = testModelLocal[provider] ?? "";
    setKeyChatTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "loading" } } }));
    try {
      const res = await fetch(`${apiBase}/api/providers/keys/chat-test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, id, ...(model ? { model } : {}) }),
      });
      const body = await res.json() as {
        ok?: boolean; status?: number | string; latencyMs?: number;
        reply?: string; usage?: ChatTestResult["usage"]; error?: string;
      };
      const result: ChatTestResult = body.ok === true
        ? {
            status: "ok",
            ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}),
            ...(body.reply ? { reply: body.reply } : {}),
            ...(body.usage ? { usage: body.usage } : {}),
            ...(model ? { model } : {}),
          }
        : {
            status: "fail",
            ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}),
            error: body.error ?? (typeof body.status === "number" ? `HTTP ${body.status}` : String(body.status ?? "unknown error")),
            ...(model ? { model } : {}),
          };
      setKeyChatTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: result } }));
    } catch (err) {
      setKeyChatTests(prev => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [id]: { status: "fail", error: String(err) } } }));
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

  // Seed the 测试模型 dropdown from localStorage, falling back to provider.defaultModel.
  // Runs whenever the set of providers changes so a newly added provider appears with
  // the right default without clobbering a user's existing picks.
  const providerNamesKey = config ? Object.keys(config.providers).join("\u0000") : "";
  useEffect(() => {
    if (!config) return;
    setTestModelLocal(prev => {
      const next = { ...prev };
      for (const [name, prov] of Object.entries(config.providers)) {
        if (next[name] !== undefined) continue;
        next[name] = readTestModelLocal(name) ?? prov.defaultModel ?? "";
      }
      return next;
    });
  }, [providerNamesKey]);

  const setTestModelLocalValue = (name: string, value: string) => {
    setTestModelLocal(prev => ({ ...prev, [name]: value }));
    writeTestModelLocal(name, value);
  };

  // Auto-expand a provider's auth matrix when a fresh (< 5min) probe is cached, so a
  // page reload does not hide results the user just generated. Only applied once per
  // provider, and never collapses a panel the user opened manually.
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!config) return;
    for (const name of Object.keys(config.providers)) {
      if (autoExpandedRef.current.has(name)) continue;
      autoExpandedRef.current.add(name);
      if (hasFreshMatrixCache(name)) {
        setAuthMatrixOpen(prev => prev ?? name);
        break;
      }
    }
  }, [providerNamesKey]);

  // Local threshold patch: PATCH /api/providers/key-schedule?name=<p>
  // Persists provider.keySchedule.threshold (and optionally enabled) without forcing
  // a full provider-config re-upload. On success, the server returns the updated
  // getKeyScheduleState, which we merge into local state so the slider reflects the new
  // threshold immediately.
  const patchKeySchedule = async (providerName: string, body: { threshold?: number; enabled?: boolean }) => {
    setSavingThreshold(providerName);
    try {
      const url = apiBase + '/api/providers/key-schedule?name=' + encodeURIComponent(providerName);
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notify(t(body.enabled !== undefined ? 'prov.autoSwitchSaveFail' : 'prov.thresholdSaveFail', { error: data.error ?? 'HTTP ' + res.status }), false);
        return null;
      }
      const updated = await res.json();
      setKeySchedules(prev => ({ ...prev, [providerName]: updated }));
      // Pick the success notification by what was actually patched. Toggle and threshold
      // share the endpoint, but they have different UX intents (binary flip vs numeric set)
      // so the toast text should match.
      if (body.enabled !== undefined) {
        notify(t('prov.autoSwitchSaved', { state: body.enabled ? t('prov.autoSwitchOn') : t('prov.autoSwitchOff') }), true);
      } else {
        notify(t('prov.thresholdSaved', { pct: String(Math.round(((body.threshold ?? updated.threshold) || 0) * 100)) }), true);
      }
      return updated;
    } catch (err) {
      notify(t(body.enabled !== undefined ? 'prov.autoSwitchSaveFail' : 'prov.thresholdSaveFail', { error: err instanceof Error ? err.message : String(err) }), false);
      return null;
    } finally {
      setSavingThreshold((cur) => (cur === providerName ? null : cur));
    }
  };

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

  // ----- Edit provider (adapter / baseUrl / defaultModel / liveModels / headers) -----
  // Edit opens a focused modal; API keys and OAuth accounts stay on their own flows.
  const [editTarget, setEditTarget] = useState<EditableProvider | null>(null);
  const openEditModal = async (name: string) => {
    const prov = config?.providers?.[name];
    if (!prov) return;
    // Header values are secrets and are not part of the config payload — fetch
    // them for this provider only, so the modal can prefill the edit form.
    let headerValues: Record<string, string> = {};
    let headersLoaded = false;
    try {
      const res = await fetch(`${apiBase}/api/providers/headers?name=${encodeURIComponent(name)}`);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        headerValues = body.headers ?? {};
        headersLoaded = true;
      }
    } catch {
      // Leave headers empty; the modal still edits the other fields, and saving
      // without touching headers leaves the stored values untouched.
    }
    setEditTarget({
      name,
      adapter: prov.adapter ?? "",
      baseUrl: prov.baseUrl ?? "",
      defaultModel: prov.defaultModel ?? "",
      liveModels: prov.liveModels !== false,
      supportsSearchTool: prov.supportsSearchTool === true,
      contextWindow: prov.contextWindow,
      headers: headerValues,
      headersLoaded,
      models: prov.models ?? [],
      label: prov.label ?? "",
    });
  };
  const closeEditModal = () => setEditTarget(null);
  const saveEditProvider = async (patch: {
    label?: string;
    renameTo?: string;
    adapter?: string;
    baseUrl?: string;
    defaultModel?: string;
    liveModels?: boolean;
    supportsSearchTool?: boolean;
    contextWindow?: number;
    headers?: Record<string, string>;
  }) => {
    if (!editTarget) return;
    // Split the patch: provider edits go inside `provider`, renameTo is its own field
    // (the backend uses it to move the map key before persisting edits).
    const { renameTo, ...providerEdits } = patch;
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(editTarget.name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerEdits, ...(renameTo ? { renameTo } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      // Throw so the modal can show it inline instead of auto-closing.
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const savedAs: string = typeof body.name === "string" ? body.name : editTarget.name;
    notify(t("prov.editSaved", { name: savedAs }), true);
    // If a rename happened, drop the old editTarget and let fetchConfig() re-populate.
    setEditTarget(null);
    fetchConfig();
    fetchOauth();
    fetchProviderQuotas(true);
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
            const keySched = keySchedules[name] ?? null;
            // Distinguish three states per axis so the card can render a skeleton
            // instead of a blank hole during the first paint:
            //   undefined → not loaded yet (skeleton)
            //   []         → loaded, empty (explicit empty hint + add button)
            //   [...]      → loaded, has rows
            // The previous boolean (`showAccounts`) was hiding the entire list while
            // data was in flight, which read as "waiting for the page to settle".
            const oauthLoaded = accountSet !== undefined;
            const keyPoolLoaded = keyPools[name] !== undefined;
            const showAccounts =
              (isKeyAuth && prov.hasApiKey) ? keyPoolLoaded
              : prov.authMode === "oauth" ? oauthLoaded
              : prov.authMode === "forward" ? false
              : false;
            const accountsOpen = openAccounts[name] !== false;
            const dropdownCount = accountSet?.accounts.length ?? keyPool.length;
            const accent = providerAccent(prov.adapter);
            let baseHost = "";
            try { baseHost = new URL(prov.baseUrl).host; } catch { baseHost = ""; }
            return (
              <div
                key={name}
                className={`card prov-card${isDisabled ? " prov-card-disabled" : ""}`}
                style={{
                  borderLeft: `6px solid ${accent.border}`,
                  backgroundImage: `linear-gradient(${accent.tint}, transparent 220px)`,
                  borderTop: "1px solid var(--border)",
                  borderRight: "1px solid var(--border)",
                  borderBottom: "1px solid var(--border)",
                  marginTop: 8,
                  overflow: "hidden",
                }}
              >
                <div className="prov-card-main">
                  {authModeMark(prov.authMode) ? (
                    <span
                      className={`prov-authmode-mark prov-authmode-${prov.authMode}`}
                      data-authmode={prov.authMode}
                      aria-label={`auth mode ${prov.authMode}`}
                      title={prov.authMode === "oauth" ? "OAuth 登录" : "Pass-through 直通"}
                    >
                      <span aria-hidden="true">{prov.authMode === "oauth" ? "\u{1F511}" : "\u21AA\uFE0F"}</span>
                    </span>
                  ) : null}
                  <div className="prov-card-info">
                    {icon && <span className="provider-icon"><img src={icon} alt="" aria-hidden="true" /></span>}
                    <div className="prov-card-copy">
                      <div className="prov-title">
                        <span style={{ fontWeight: 600 }}>{name}</span>
                        {prov.label ? (
                          <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>
                            ({prov.label})
                          </span>
                        ) : null}
                        <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>
                          ({baseHost})
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openEditModal(name)}
                          title={t("prov.editButton")}
                          aria-label={t("prov.editButton")}
                          data-testid={`provider-edit-${name}`}
                          style={{ marginLeft: 6, padding: "2px 6px" }}
                        >
                          <IconEdit width={12} height={12} />
                        </button>
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
                    {isKeyAuth && addingKeyFor !== name ? (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => { setAddingKeyFor(name); setNewKeyValue(""); }}
                        title={t("prov.keyAddTitle")}
                      >
                        <IconPlus style={{ width: 12, height: 12 }} />{t("prov.keyAdd")}
                      </button>
                    ) : null}
                    {isKeyAuth && addingKeyFor === name ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setAddingKeyFor(null); setNewKeyValue(""); }}
                      >
                        {t("common.cancel")}
                      </button>
                    ) : null}
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
                                      {accountsOpen !== false && isKeyAuth ? (() => {
                      const provConf = config.providers[name];
                      const provModels: string[] = Array.isArray(provConf?.models) ? provConf.models : [];
                      return (
                        <div className="prov-test-model" style={{
                          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                          padding: "6px 8px", borderTop: "1px solid var(--border-soft)",
                          borderBottom: "1px solid var(--border-soft)",
                          background: "var(--raised)",
                        }}>
                          <label className="muted" style={{ fontSize: 11 }}>{t("prov.testModel")}</label>
                          <TestModelBadge adapter={prov.adapter} modelListAuth={prov.modelListAuth} />
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
                          <select
                            className="input-sm"
                            value={testModelLocal[name] ?? ""}
                            onChange={e => setTestModelLocalValue(name, e.target.value)}
                            aria-label={t("prov.testModel")}
                            title={t("prov.testModelHint")}
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
                            onClick={() => setAuthMatrixOpen(authMatrixOpen === name ? null : name)}
                            style={{ fontSize: 11, marginLeft: "auto" }}
                            aria-label={`Show auth matrix for ${name}`}
                          >
                            {authMatrixOpen === name ? "收起认证矩阵" : "认证矩阵"}
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
                    {(() => {
                      const isAuthOpen = authMatrixOpen === name;
                      if (!isAuthOpen) return null;
                      return (
                        <div style={{ padding: "0 8px 8px 8px", borderTop: "1px solid var(--border-soft)", borderBottom: isAuthOpen ? "1px solid var(--border-soft)" : "none", background: "var(--raised)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, marginTop: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                              拉模型认证矩阵
                            </span>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setAuthMatrixOpen(null)}
                              style={{ fontSize: 10, padding: "2px 8px", marginLeft: "auto" }}
                              aria-label={`Collapse auth matrix for ${name}`}
                            >
                              收起
                            </button>
                          </div>
                          <AuthMatrixPanel
                            apiBase={apiBase}
                            providerName={name}
                            onStrategyChanged={fetchConfig}
                          />
                        </div>
                      );
                    })()}
                    {accountsOpen !== false && (
                      <div className="prov-accounts-list">
                        {/* Skeleton state: emit a couple of placeholder rows while the
                            keys/accounts request is in flight, so the card doesn't appear
                            to "appear" after a beat. Replaced in place once data arrives. */}
                        {isKeyAuth && prov.hasApiKey && !keyPoolLoaded ? (
                          <>
                            <AccountRowSkeleton />
                            <AccountRowSkeleton />
                          </>
                        ) : null}
                        {!isKeyAuth && prov.authMode === "oauth" && !oauthLoaded ? (
                          <>
                            <AccountRowSkeleton tone="muted" />
                            <AccountRowSkeleton tone="muted" />
                          </>
                        ) : null}
                        {isKeyAuth ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                            <button
                              className={`prov-accounts-toggle${accountsOpen ? " open" : ""}`}
                              onClick={() => setOpenAccounts(prev => ({ ...prev, [name]: !accountsOpen }))}
                              aria-expanded={accountsOpen}
                              aria-label={t("prov.accountsAria", { name })}
                            >
                              {t("prov.accounts", { n: String(dropdownCount) })}
                              <span className="chev"><IconChevron /></span>
                            </button>
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
                        ) : null}
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
                          const keyLabel = entry.label ?? entry.masked;
                          const chatResult = keyChatTests[name]?.[entry.id];
                          return (
                            <KeyPoolPanel
                              key={entry.id}
                              quota={quotaProp}
                              index={idx}
                              active={entry.active}
                              nextUp={keySched?.nextUpId === entry.id}
                              autoSwitch={entry.autoSwitch !== false}
                              onToggleAutoSwitch={enabled => { void toggleAutoSwitch(name, entry, enabled); }}
                              onSwitch={entry.active ? undefined : onSwitch}
                              onRemove={onRemove}
                              {...(revealedKeys[name]?.[entry.id] !== undefined ? { revealedKey: revealedKeys[name]![entry.id]! } : {})}
                              onReveal={() => revealOne(name, entry.id)}
                              onHide={() => hideOne(name, entry.id)}
                              onQuotaProbe={() => {
                                setTestDialog({ provider: name, keyId: entry.id, keyLabel, tab: "quota" });
                                testOne(name, entry.id);
                              }}
                              onChatTest={() => {
                                setTestDialog({ provider: name, keyId: entry.id, keyLabel, tab: "chat" });
                                chatTestOne(name, entry.id);
                              }}
                              {...(keyTests[name]?.[entry.id] ? { testStatus: keyTests[name]![entry.id]!.status, ...(keyTests[name]![entry.id]!.latencyMs !== undefined ? { testLatencyMs: keyTests[name]![entry.id]!.latencyMs } : {}), ...(keyTests[name]![entry.id]!.error ? { testError: keyTests[name]![entry.id]!.error } : {}) } : {})}
                              {...(chatResult ? { chatStatus: chatResult.status } : {})}
                              t={t}
                            />
                          );
                        })}
                        {isKeyAuth && keyPool.length > 1 && keySched ? (() => {
                          // Read per-provider draft state from the top-level Map. The pendingPct
                          // local is intentionally not a hook (the IIFE runs inside JSX so a hook here
                          // would trigger React error #310). Drafts live on the top-level Map and
                          // we just project this provider's slice onto local variables.
                          const currentThreshold = keySched?.threshold ?? 0.85;
                          const persistedPct = Math.round(currentThreshold * 100);
                          const pendingPct = thresholdDrafts[name] ?? null;
                          const draftPct = pendingPct ?? persistedPct;
                          const dirty = pendingPct !== null && pendingPct !== persistedPct;
                          const saveDraft = async () => {
                            if (pendingPct === null) return;
                            await patchKeySchedule(name, { threshold: pendingPct / 100 });
                            setThresholdDrafts(prev => ({ ...prev, [name]: null }));
                          };
                          const cancelDraft = () => setThresholdDrafts(prev => ({ ...prev, [name]: null }));
                          // Auto-rotation toggle: binary, immediate save (no draft state).
                          // Optimistic — flip the local view BEFORE the server confirms so the
                          // user sees instant feedback; the patchKeySchedule response merges
                          // authoritative server state back into keySchedules.
                          const schedulerOn = keySched?.enabled ?? false;
                          const toggleAutoSwitch = async () => {
                            const next = !schedulerOn;
                            setKeySchedules(prev => {
                              const cur = prev[name];
                              if (!cur) return prev;
                              return { ...prev, [name]: { ...cur, enabled: next } };
                            });
                            const updated = await patchKeySchedule(name, { enabled: next });
                            // patchKeySchedule returns null on failure (it already notified the
                            // error); roll back the optimistic flip so the UI doesn't lie.
                            if (!updated) {
                              setKeySchedules(prev => {
                                const cur = prev[name];
                                if (!cur) return prev;
                                return { ...prev, [name]: { ...cur, enabled: !next } };
                              });
                            }
                          };
                          return (
                            <div
                              className="prov-account-row prov-sched-threshold"
                              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, padding: "4px 8px" }}
                            >
                              <button
                                type="button"
                                onClick={toggleAutoSwitch}
                                className={`btn btn-sm ${schedulerOn ? "btn-primary" : "btn-ghost"}`}
                                aria-label={schedulerOn ? t("prov.autoSwitchOnAria", { name }) : t("prov.autoSwitchOffAria", { name })}
                                aria-pressed={schedulerOn}
                                title={schedulerOn ? t("prov.autoSwitchOnTitle") : t("prov.autoSwitchOffTitle")}
                                data-testid={`sched-toggle-${name}`}
                                style={{ minWidth: 56, flexShrink: 0, fontWeight: 600 }}
                              >
                                {schedulerOn ? t("prov.autoSwitchOn") : t("prov.autoSwitchOff")}
                              </button>
                              <label
                                htmlFor={`sched-threshold-${name}`}
                                className="muted"
                                style={{ minWidth: 180, cursor: schedulerOn ? "pointer" : "not-allowed", opacity: schedulerOn ? 1 : 0.55 }}
                              >
                                {t("prov.thresholdLabel")}
                              </label>
                              <input
                                type="range"
                                min={50}
                                max={99}
                                step={1}
                                value={draftPct}
                                id={`sched-threshold-${name}`}
                                aria-label={t("prov.thresholdAria", { name })}
                                title={t("prov.thresholdTitle")}
                                style={{ flex: 1, minWidth: 0, cursor: schedulerOn ? "pointer" : "not-allowed", opacity: schedulerOn ? 1 : 0.45 }}
                                onChange={e => setThresholdDrafts(prev => ({ ...prev, [name]: Number(e.target.value) }))}
                                disabled={!schedulerOn || savingThreshold === name}
                                data-testid={`sched-threshold-${name}`}
                              />
                              <span
                                aria-live="polite"
                                style={{ minWidth: 56, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, flexShrink: 0, opacity: schedulerOn ? 1 : 0.55 }}
                              >
                                {draftPct}%
                                {dirty ? <span style={{ color: "var(--amber)", marginLeft: 4 }}>*</span> : null}
                              </span>
                              {/* Save/Cancel reserve a fixed-width slot so the slider width never
                                  changes when the buttons appear or disappear. Without this
                                  the flex layout re-flows the slider and the drag handle jumps
                                  under the cursor, making the value readout flicker. */}
                              <span
                                style={{
                                  display: "inline-flex",
                                  gap: 4,
                                  flexShrink: 0,
                                  minWidth: 132,
                                  justifyContent: "flex-end",
                                  visibility: dirty && schedulerOn ? "visible" : "hidden",
                                }}
                              >
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={cancelDraft}
                                  disabled={!schedulerOn || savingThreshold === name}
                                  data-testid={`sched-threshold-cancel-${name}`}
                                  title={t("prov.thresholdCancelTitle")}
                                >
                                  {t("prov.thresholdCancel")}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  onClick={saveDraft}
                                  disabled={!schedulerOn || savingThreshold === name}
                                  data-testid={`sched-threshold-save-${name}`}
                                  title={t("prov.thresholdSaveTitle")}
                                >
                                  {savingThreshold === name ? t("prov.thresholdSaving") : t("prov.thresholdSave")}
                                </button>
                              </span>
                            </div>
                          );
                        })() : null}
                        {keySched && keySched.events.length > 0 ? (
                          <div className="prov-account-row prov-sched-events" style={{ display: "block", fontSize: 11, cursor: "default" }}>
                            <span className="muted">{schedEventText(keySched.events[keySched.events.length - 1]!, keyPool, t)}</span>
                            {keySched.events.length > 1 ? (
                              <details style={{ marginTop: 4 }}>
                                <summary className="muted" style={{ cursor: "pointer" }}>
                                  {t("prov.schedEventsMore", { n: String(keySched.events.length - 1) })}
                                </summary>
                                <div style={{ marginTop: 4 }}>
                                  {[...keySched.events].reverse().slice(1).map((ev, i) => (
                                    <div key={i} className="muted">{schedEventText(ev, keyPool, t)}</div>
                                  ))}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
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
      <EditProviderModal
        open={editTarget !== null}
        provider={editTarget}
        apiBase={apiBase}
        existingProviderNames={config ? Object.keys(config.providers) : []}
        forwardProviderAvailable={config
          ? Object.values(config.providers).some((p) => p.authMode === "forward" && !p.disabled)
          : undefined}
        onClose={closeEditModal}
        onSave={saveEditProvider}
      />
      {testDialog ? (() => {
        const prov = config.providers[testDialog.provider];
        const authLabel = prov?.modelListAuth ?? "auto";
        const quota = keyTests[testDialog.provider]?.[testDialog.keyId] ?? null;
        const chat = keyChatTests[testDialog.provider]?.[testDialog.keyId] ?? null;
        // Chat-test runtime model: the dropdown pick when set, otherwise the provider default.
        const runtimeChat: ChatTestResult | null = chat
          ? { ...chat, model: chat.model ?? (testModelLocal[testDialog.provider] || prov?.defaultModel || undefined) }
          : null;
        const runtimeQuota: QuotaProbeResult | null = quota
          ? { ...quota, status: quota.status === "loading" ? "loading" : quota.status }
          : null;
        return (
          <KeyTestResultDialog
            open
            onClose={() => setTestDialog(null)}
            initialTab={testDialog.tab}
            keyLabel={testDialog.keyLabel}
            adapter={prov?.adapter ?? "?"}
            strategy={authLabel}
            quota={runtimeQuota}
            chat={runtimeChat}
            tQuota={t("prov.resultDialogQuota")}
            tChat={t("prov.resultDialogChat")}
            tClose={t("common.close")}
          />
        );
      })() : null}
    </>
  );
}
