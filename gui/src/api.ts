const TOKEN_KEY = "opencodex-api-token";

let installed = false;
let promptInFlight: Promise<string | null> | null = null;
let registeredPrompt: ((error?: string) => Promise<string | null>) | null = null;

/** Register a custom prompt handler (e.g. a React modal). Falls back to window.prompt if unset. */
export function registerApiKeyPrompt(fn: (error?: string) => Promise<string | null>): void {
  registeredPrompt = fn;
}

function apiPath(input: RequestInfo | URL): string | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, window.location.href).pathname;
  } catch {
    return null;
  }
}

function needsApiAuth(input: RequestInfo | URL): boolean {
  const path = apiPath(input);
  return !!path && (path.startsWith("/api/") || path.startsWith("/v1/"));
}

function readToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY)?.trim();
    return token || null;
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* session storage may be disabled */ }
}

function clearToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* session storage may be disabled */ }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-OpenCodex-API-Key", token);
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

async function promptForToken(): Promise<string | null> {
  if (promptInFlight) return promptInFlight;
  promptInFlight = Promise.resolve()
    .then(async () => (registeredPrompt ? registeredPrompt() : window.prompt("OpenCodex API token")?.trim() || null))
    .finally(() => { promptInFlight = null; });
  return promptInFlight;
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!needsApiAuth(input)) return originalFetch(input, init);

    const token = readToken();
    const [firstInput, firstInit] = token ? withToken(input, init, token) : [input, init];
    const response = await originalFetch(firstInput, firstInit);
    if (response.status !== 401) return response;

    if (token) clearToken();
    const nextToken = await promptForToken();
    if (!nextToken) return response;

    storeToken(nextToken);
    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearToken();
    return retry;
  };
}
// Phase 5 launcher-mode settings. Narrow DTO so we never accidentally
// surface api keys / headers / cookies through the dashboard.
export type OpenCodexPreset = "launcher" | "proxy-only" | "full-pass-through" | null;

export interface OpenCodexConfigPayload {
  enableCodexLauncherMode: boolean;
  syncRoutedModels: boolean;
  syncNativeOpenaiModels: boolean;
  preset: OpenCodexPreset;
}

export interface OpenCodexConfigUpdate {
  enableCodexLauncherMode?: boolean;
  syncRoutedModels?: boolean;
  syncNativeOpenaiModels?: boolean;
  preset?: OpenCodexPreset;
}

const API_BASE_FOR_CONFIG =
  (typeof window !== "undefined" ? (window as unknown as { __OCX_API_BASE__?: string }).__OCX_API_BASE__ : "")
  || ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "")
  || "";

function configUrl(path: string): string {
  const base = API_BASE_FOR_CONFIG.replace(/\/$/, "");
  return `${base}/api/opencodex/config${path}`;
}

export async function fetchOpenCodexConfig(): Promise<OpenCodexConfigPayload> {
  const res = await fetch(configUrl(""), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`fetchOpenCodexConfig failed: HTTP ${res.status}`);
  return (await res.json()) as OpenCodexConfigPayload;
}

export type RestartStatus = "restarting" | "healthy" | "failed";

export interface RestartResult {
  status: RestartStatus;
  elapsedMs: number;
  error?: string;
}

/**
 * Initiate proxy restart and wait for /healthz to come back up.
 *
 * POST /api/proxy/restart fires-and-forgets a detached spawn of `ocx restart`.
 * The current proxy stops momentarily, so this client must poll /healthz with
 * exponential backoff to know when the new instance has bound the same port.
 *
 * Returns: { status: "healthy" } once /healthz returns 2xx, or
 *          { status: "failed", error } on POST failure or timeout.
 */
export async function restartProxy(opts: {
  initialDelayMs?: number;
  timeoutMs?: number;
} = {}): Promise<RestartResult> {
  const initialDelayMs = opts.initialDelayMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  // Step 1: fire the restart POST. This either succeeds (proxy scheduled to die)
  // or fails outright (in which case the existing proxy is still alive).
  let postRes: Response;
  try {
    postRes = await fetch("/api/proxy/restart", { method: "POST" });
  } catch (e) {
    return { status: "failed", elapsedMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => "");
    return { status: "failed", elapsedMs: Date.now() - start, error: `POST HTTP ${postRes.status} ${text}` };
  }
  // Step 2: poll /healthz with exponential backoff. The proxy is most likely down
  // for a few seconds, so we start at 200ms and cap at 2s, with a 30s overall timeout.
  let delay = initialDelayMs;
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2000);
    try {
      const healthRes = await fetch("/healthz", { cache: "no-store" });
      if (healthRes.ok) {
        return { status: "healthy", elapsedMs: Date.now() - start };
      }
    } catch {
      // Connection refused etc. — proxy is still down, keep polling.
    }
  }
  return { status: "failed", elapsedMs: Date.now() - start, error: `proxy did not come back within ${timeoutMs}ms` };
}

export async function saveOpenCodexConfig(update: OpenCodexConfigUpdate): Promise<OpenCodexConfigPayload> {
  const res = await fetch(configUrl(""), {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`saveOpenCodexConfig failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as OpenCodexConfigPayload;
}
