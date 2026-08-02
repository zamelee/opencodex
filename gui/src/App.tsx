import { useEffect, useRef, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import Debug from "./pages/Debug";
import Usage from "./pages/Usage";
import CodexAuth from "./pages/CodexAuth";
import ApiKeyModal from "./components/ApiKeyModal";
import ApiKeys from "./pages/ApiKeys";
import Launcher from "./pages/Launcher";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconTerminal, IconActivity, IconKey, IconLock, IconGithub, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n";
import { Select } from "./ui";
import { installApiAuthFetch, registerApiKeyPrompt } from "./api";
installApiAuthFetch();
type Page = "dashboard" | "providers" | "models" | "subagents" | "logs" | "debug" | "usage" | "codex-auth" | "api" | "launcher";
type Theme = "light" | "dark" | "system";
const VALID_PAGES = new Set<Page>(["dashboard", "providers", "models", "subagents", "logs", "debug", "usage", "codex-auth", "api", "launcher"]);
function readPageFromHash(): Page {
  const raw = location.hash.replace(/^#\/?/, "");
  return VALID_PAGES.has(raw as Page) ? (raw as Page) : "dashboard";
}
const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";
const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "debug", tkey: "nav.debug", Icon: IconTerminal },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey },
  { id: "api", tkey: "nav.api", Icon: IconGlobe },
  // Phase-7 rename: visible name = launcher settings; "nav.settings" key namespace preserved intentionally.
  { id: "launcher", tkey: "nav.settings", Icon: IconMonitor },
];
const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;
const THEME_TKEY: Record<Theme, TKey> = { light: "theme.light", dark: "theme.dark", system: "theme.system" };
function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}
function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}
export default function App() {
  // --- API-key auth gate: lock the entire UI behind the proxy admission secret until a valid
  // key is verified. The wrapper (gui/src/api.ts) surfaces 401s into this modal; the gate below
  // keeps the sidebar/main page hidden so a non-authenticated visitor cannot read structure.
  const TOKEN_KEY = "opencodex-api-token";
  const [authUnlocked, setAuthUnlocked] = useState(false);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>(undefined);
  const authResolverRef = useRef<((k: string | null) => void) | null>(null);
  useEffect(() => {
    registerApiKeyPrompt((error) => new Promise<string | null>((resolve) => {
      authResolverRef.current = resolve;
      setAuthError(error);
      setAuthPromptOpen(true);
    }));
  }, []);
  // Probe a management endpoint WITHOUT sending any token to decide whether the proxy
  // requires auth. See submitApiKey below for the user-submitted-key flow.
  const submitApiKey = (key: string) => {
    fetch(`${API_BASE}/api/keys`, { headers: { "X-OpenCodex-API-Key": key } })
      .then((r) => {
        if (r.ok) {
          try { localStorage.setItem(TOKEN_KEY, key); } catch {}
          setAuthUnlocked(true);
          setAuthPromptOpen(false);
          setAuthError(undefined);
          authResolverRef.current?.(key);
          authResolverRef.current = null;
        } else if (r.status === 401) {
          setAuthError(t("authKey.errorRejected"));
          authResolverRef.current?.(null);
        } else {
          setAuthError(t("authKey.errorUnexpected").replace("{status}", String(r.status)));
          authResolverRef.current?.(null);
        }
      })
      .catch(() => {
        setAuthError(t("authKey.errorNetwork"));
        authResolverRef.current?.(null);
      });
  };
  const cancelApiKey = () => {
    setAuthPromptOpen(false);
    setAuthError(undefined);
    authResolverRef.current?.(null);
    authResolverRef.current = null;
  };
  const [page, setPageState] = useState<Page>(readPageFromHash);
  const setPage = (p: Page) => { location.hash = p; setPageState(p); };
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const { locale, setLocale } = useI18n();
  const t = useT();
  // Keep latest `t` in a ref so the probe effect (which depends on []) always reads the
  // current locale's translations even if a fetch resolves after the user switches language.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const onHash = () => setPageState(readPageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);
  useEffect(() => {
    let cancelled = false;
    const fetchRuntimeVersion = async () => {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        if (!res.ok) return;
        const version = readRuntimeVersion(await res.json());
        if (!cancelled && version) setRuntimeVersion(version);
      } catch {
        // Keep the build-time fallback when the proxy is unavailable.
      }
    };
    fetchRuntimeVersion();
    const interval = setInterval(fetchRuntimeVersion, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);


  useEffect(() => {
    let cancelled = false;

    // 1. Loopback short-circuit: page loaded via localhost / 127.0.0.1 / [::1] → skip
    //    the probe entirely. The server grants admission for any loopback source IP,
    //    so a modal here would be surprising and contradicts "no key needed on the
    //    proxy host itself".
    const hostIsLoopback = /^(localhost|127\.|::1|\[::1\])$/i.test(location.hostname);
    if (hostIsLoopback) { setAuthUnlocked(true); return; }

    // 1b. Non-loopback host: open the modal right away. If the proxy actually
    //     admits this caller (LAN-IP with same-machine loopback source IP), the
    //     probe below unlocks immediately and the user never sees the modal.
    //     If the proxy requires auth (LAN bind, no loopback bypass), the user
    //     sees an input field instead of staring at "this proxy requires API key"
    //     with nowhere to paste the key.
    setAuthPromptOpen(true);

    // 3. Network probe — runs after the loopback / stored-key shortcuts.
    const probe = () => fetch(`${API_BASE}/api/keys`)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setAuthUnlocked(true);
          setAuthPromptOpen(false);
          setAuthError(undefined);
        } else if (r.status === 401) {
          // Modal already open from the non-loopback short-circuit above.
          // Don't clobber any error message already set by submitApiKey
          // (e.g. authKey.errorRejected after a bad key submission).
        } else {
          setAuthError(tRef.current("authKey.errorUnexpected").replace("{status}", String(r.status)));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAuthError(tRef.current("authKey.errorNetwork"));
      });
    // 2. Reuse a key the user already validated in this tab. Without this, every
    //    page reload re-prompts even though the previous submission succeeded.
    const storedKey = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    if (storedKey) {
      fetch(`${API_BASE}/api/keys`, { headers: { "X-OpenCodex-API-Key": storedKey } })
        .then((r) => {
          if (cancelled) return;
          if (r.ok) setAuthUnlocked(true);
          else probe();
        })
        .catch(() => { if (!cancelled) probe(); });
    } else {
      probe();
    }
    return () => { cancelled = true; };
  }, []);
  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion = runtimeVersion ?? __APP_VERSION__;
  const [stopping, setStopping] = useState(false);
  const handleStop = async () => {
    if (!confirm(t("dash.stopConfirm"))) return;
    setStopping(true);
    try { await fetch(`${API_BASE}/api/stop`, { method: "POST" }); } catch { /* connection drops */ }
  };
  if (!authUnlocked) {
    return (
      <>
        <div className="empty" style={{ marginTop: "20vh", textAlign: "center", maxWidth: 420, margin: "20vh auto 0" }}>
          <div style={{ display: "flex", justifyContent: "center" }}><IconLock width={48} height={48} /></div>
          <div className="title" style={{ marginTop: 12 }}>{t("authKey.lockTitle")}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
            {t("authKey.lockDesc")}
          </div>
        </div>
        <ApiKeyModal open={authPromptOpen} error={authError} onSubmit={submitApiKey} onCancel={cancelApiKey} />
      </>
    );
  }
  return (
    <div className="app">
      <ApiKeyModal open={authPromptOpen} error={authError} onSubmit={submitApiKey} onCancel={cancelApiKey} />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" role="img" aria-label="opencodex logo" />
          <span className="name">opencodex</span>
          <span className="ver">v{displayedVersion}</span>
        </div>
        <nav>
          {NAV.map(({ id, tkey, Icon }) => (
            <button key={id} className={`nav-item${page === id ? " active" : ""}`} data-page={id} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {t(tkey)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="lang-toggle">
            <IconGlobe aria-hidden />
            <Select
              value={locale}
              options={LOCALES.map(l => ({ value: l.code, label: l.name }))}
              onChange={v => setLocale(v as Locale)}
              label={t("lang.label")}
              placement="right"
              style={{ flex: 1, minWidth: 0, width: "100%" }}
            />
          </div>
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`} title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
            <ThemeIcon /> <span className="mode">{t(THEME_TKEY[theme])}</span>
          </button>
          <button type="button" className="theme-toggle stop-toggle" onClick={handleStop} disabled={stopping}
            aria-label={t("dash.stop")} title={t("dash.stop")}>
            <IconPower /> <span className="mode">{stopping ? t("dash.stopping") : t("dash.stop")}</span>
          </button>
          <a className="sidebar-link" href="https://github.com/lidge-jun/opencodex" target="_blank" rel="noreferrer">
            <IconGithub /> {t("common.github")}
          </a>
        </div>
      </aside>
      <main className="main">
        <div className="main-inner">
          {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
          {page === "providers" && <Providers apiBase={API_BASE} />}
          {page === "models" && <Models apiBase={API_BASE} />}
          {page === "subagents" && <Subagents apiBase={API_BASE} />}
          {page === "logs" && <Logs apiBase={API_BASE} />}
          {page === "debug" && <Debug apiBase={API_BASE} />}
          {page === "usage" && <Usage apiBase={API_BASE} />}
          {page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}
          {page === "api" && <ApiKeys apiBase={API_BASE} />}
          {page === "launcher" && <Launcher />}
        </div>
      </main>
    </div>
  );
}
