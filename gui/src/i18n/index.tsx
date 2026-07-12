// Lightweight, zero-dependency i18n for the dashboard (en / de / ko / zh-CN).
// en.ts is the source of truth; de/ko/zh are compile-checked against its keys.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { en, type TKey } from "./en";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";

export type Locale = "en" | "de" | "ko" | "zh";
export type { TKey };

const DICTS: Record<Locale, Record<TKey, string>> = { en, de, ko, zh };

// Display order + native names (own script — never flags, per i18n best practice) + <html lang>.
export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
  { code: "de", name: "Deutsch", htmlLang: "de" },
  { code: "ko", name: "한국어", htmlLang: "ko" },
  { code: "zh", name: "中文", htmlLang: "zh-CN" },
];

const LANG_KEY = "ocx-lang";

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "de" || stored === "ko" || stored === "zh") return stored;
  } catch { /* ignore */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) return "zh";
  return "en";
}

type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

interface Ctx { locale: Locale; setLocale: (l: Locale) => void; t: TFn }
const I18nContext = createContext<Ctx | null>(null);

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  let out = s;
  for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectInitial);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem(LANG_KEY, locale); } catch { /* ignore */ }
  }, [locale]);

  // Fallback chain: current locale → English → raw key.
  const t: TFn = (key, vars) => interpolate(DICTS[locale][key] ?? en[key] ?? key, vars);

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}

export function useT(): TFn { return useI18n().t; }

// Render a translation containing one or more named {slot} placeholders as inline
// <code className="chip"> tokens. Other {vars} are interpolated first, then the
// remaining {slot} markers are replaced with chip elements. If neither cmd nor
// slots is provided, the translated string is rendered as plain text.
export function Trans({ k, cmd, slots, vars }: { k: TKey; cmd?: string; slots?: Record<string, string>; vars?: Vars }) {
  const { t } = useI18n();
  const merged = cmd ? { ...(slots ?? {}), cmd } : slots;
  const text = t(k, vars);
  if (!merged) return <>{text}</>;
  const names = Object.keys(merged);
  if (names.length === 0) return <>{text}</>;
  const esc = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, String.fromCharCode(92,36) + "&");
  const pattern = new RegExp(String.fromCharCode(92,123) + "(" + names.map(esc).join("|") + ")" + String.fromCharCode(92,125), "g");
  const parts = text.split(pattern);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { if (parts[i]) out.push(parts[i]); }
    else { out.push(<code key={"chip-" + i} className="chip">{merged[parts[i]]}</code>); }
  }
  return <>{out}</>;
}
