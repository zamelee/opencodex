/**
 * Single-instance Playwright runtime for minimax.chat quota probing.
 *
 * minimax.chat exposes quota data only inside its SPA (no public REST API),
 * so we headless-load it via Playwright and read the DOM. To keep per-fetch
 * cost down (the first launch is ~700ms; subsequent reloads are ~440ms),
 * we lazily open one Chromium process and reuse its default context.
 *
 * Lifecycle:
 *   - getRuntime() opens the browser on first call
 *   - closeRuntime() should be called from ocx shutdown (see cli/index.ts syncCleanup)
 *   - The runtime is intentionally opt-in (minimax.chat reverse proxies only).
 *     Other providers use their native REST quota endpoints and never touch this.
 */
import { existsSync } from "node:fs";

type ChromiumLauncher = typeof import("playwright").chromium;

interface RuntimeState {
  chromium: ChromiumLauncher | null;
  browser: import("playwright").Browser | null;
  ctx: import("playwright").BrowserContext | null;
  launching: Promise<void> | null;
}

const state: RuntimeState = {
  chromium: null,
  browser: null,
  ctx: null,
  launching: null,
};

function resolveChromePath(): string | undefined {
  // Prefer Playwright's bundled Chromium if the user has run `npx playwright install`.
  const msPlaywrightRoot = `${process.env["LOCALAPPDATA"] ?? ""}/ms-playwright`;
  if (msPlaywrightRoot) {
    const candidates = [
      `${msPlaywrightRoot}/chromium-1228/chrome-win/chrome.exe`,
      `${msPlaywrightRoot}/chromium-1223/chrome-win/chrome.exe`,
      `${msPlaywrightRoot}/chromium-1155/chrome-win/chrome.exe`,
      `${msPlaywrightRoot}/chromium_headless_shell-1228/chrome-win/headless_shell.exe`,
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  // Fall back to the user's system Chrome (works without `playwright install`).
  const sysChrome = [
    `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  for (const c of sysChrome) if (existsSync(c)) return c;
  return undefined;
}

async function loadChromium(): Promise<ChromiumLauncher> {
  if (state.chromium) return state.chromium;
  // Dynamic require so non-minimax providers never pay the module-load cost.
  const mod = await import("playwright" as string).catch(() => null);
  if (!mod) throw new Error("playwright module not available; install with `npm i -D playwright` then `npx playwright install chromium`");
  state.chromium = (mod as { chromium: ChromiumLauncher }).chromium;
  return state.chromium;
}

async function openBrowser(): Promise<void> {
  const chromium = await loadChromium();
  const executablePath = resolveChromePath();
  state.browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  state.ctx = await state.browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "opencodex-quota-probe/0.1 (headless)",
  });
}

/**
 * Returns a shared browser context. Lazily opens on first call.
 * If playwright is not installed, throws.
 */
export async function getMinimaxRuntime(): Promise<import("playwright").BrowserContext> {
  if (state.ctx) return state.ctx;
  if (!state.launching) {
    state.launching = openBrowser().finally(() => { state.launching = null; });
  }
  await state.launching;
  if (!state.ctx) throw new Error("minimax runtime: failed to open browser context");
  return state.ctx;
}

/**
 * Cleanly shut down the runtime. Safe to call multiple times. Called from
 * ocx shutdown (cli/index.ts syncCleanup) so we don't leak Chromium processes.
 */
export async function closeMinimaxRuntime(): Promise<void> {
  try { await state.ctx?.close(); } catch { /* best-effort */ }
  try { await state.browser?.close(); } catch { /* best-effort */ }
  state.ctx = null;
  state.browser = null;
}

/**
 * Detect "playwright not installed" cleanly. Probe is cheap: only does the require().
 */
export async function isMinimaxRuntimeAvailable(): Promise<boolean> {
  try {
    await loadChromium();
    return true;
  } catch {
    return false;
  }
}
