import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
/**
 * RAM budget for the replay cache.
 *
 * The disk snapshot was capped by SIZE, but the in-memory copy was capped by COUNT
 * (1000 entries) with no byte limit at all — and each entry holds the turn's items,
 * base64 `input_image` payloads included. A screenshot-heavy Codex thread therefore
 * grew the process without bound: on an 8 GB host the proxy reached 4.94 GB RSS /
 * 10.11 GB commit after 31 h and Bun died with SIGILL (2026-11-12).
 *
 * So the RAM copy gets the same treatment as the file: a byte budget, oldest-first
 * eviction. Evicting the oldest turns only breaks `previous_response_id` chains that
 * are already older than the TTL, so live conversations keep working.
 *
 * Override with OPENCODEX_RESPONSE_STATE_MAX_BYTES (smaller boxes want less).
 */
const DEFAULT_STATE_MAX_BYTES = 256 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  conversationId?: string;
  cursorCheckpointUsable?: boolean;
  /** Approximate RAM footprint of `items` (see approxBytes). */
  bytes?: number;
}

const states = new Map<string, StoredResponseState>();
let totalBytes = 0;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

/** RAM budget in bytes, from the environment or the default. */
export function responseStateMaxBytes(): number {
  const raw = process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_STATE_MAX_BYTES;
}

/**
 * Cheap size estimate for an arbitrary JSON-ish value.
 *
 * Deliberately NOT JSON.stringify: this runs on every stored response, and the
 * payloads are megabytes of base64. Strings dominate (UTF-16 in V8), so length*2
 * is the right approximation; containers add a small constant per element.
 */
function approxBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  const kind = typeof value;
  if (kind === "string") return (value as string).length * 2 + 8;
  if (kind === "number" || kind === "boolean" || kind === "bigint") return 8;
  if (kind === "function" || kind === "symbol") return 16;
  if (Array.isArray(value)) {
    let total = 16;
    for (const item of value) total += approxBytes(item);
    return total;
  }
  if (kind === "object") {
    let total = 32;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length * 2 + approxBytes(item);
    }
    return total;
  }
  return 8;
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      const bytes = typeof rec.bytes === "number" ? rec.bytes : approxBytes(rec.items);
      states.set(id, { ...rec, bytes });
      totalBytes += bytes;
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      const size = JSON.stringify(entry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(entry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path NOW: tests (and anything else) may swap OPENCODEX_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled — OPENCODEX_HOME may have moved since.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) {
      totalBytes -= state.bytes ?? 0;
      states.delete(id);
    }
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    totalBytes -= states.get(oldest)?.bytes ?? 0;
    states.delete(oldest);
  }
  evictToBudget();
}

/**
 * Keep the RAM copy under its byte budget, oldest first.
 *
 * The oldest turns go first on purpose: a live conversation chains through the
 * RECENT ids, while the stale ones are the ones a resumed-after-an-hour thread
 * would lose anyway (they are already past the TTL).
 */
function evictToBudget(): void {
  const budget = responseStateMaxBytes();
  while (totalBytes > budget && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    totalBytes -= states.get(oldest)?.bytes ?? 0;
    states.delete(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  return {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  if (!responseId) return undefined;
  ensureLoaded();
  pruneResponses();
  return states.get(responseId)?.conversationId;
}

export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown },
  conversationId?: string,
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  const items = [...inputItems(request.input), ...response.output];
  const bytes = approxBytes(items);
  const previous = states.get(response.id);
  if (previous) totalBytes -= previous.bytes ?? 0;
  states.set(response.id, {
    createdAt: now(),
    items,
    bytes,
    // Always preserve the Cursor conversation id so the next tool-result turn can continue the SAME
    // Cursor conversation (multi-turn continuation). Separately track whether Cursor's own
    // checkpoint/cache is safe to reuse: a turn that ended with a pending client tool call produced an
    // incomplete agent turn on the Cursor side (we suspended without a real mcpResult), so its
    // checkpoint must not be reused — but the conversation id string itself is still valid.
    ...(conversationId ? { conversationId } : {}),
    cursorCheckpointUsable: !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    }),
  });
  totalBytes += bytes;
  pruneResponses();
  schedulePersist();
}

/** Memory-only reset (simulates a process restart: the snapshot file survives). */
export function clearResponseStateMemoryForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  states.clear();
  totalBytes = 0;
  loaded = false;
}

/** RAM/entry counters for the memory diagnostics endpoint. */
export function responseStateStats(): {
  entries: number;
  bytes: number;
  maxBytes: number;
} {
  return {
    entries: states.size,
    bytes: totalBytes,
    maxBytes: responseStateMaxBytes(),
  };
}

/**
 * Drop the oldest replay-state entries until the cache is under `targetBytes`.
 * Used by the memory guard when the process RSS crosses its ceiling: the replay
 * cache is the only unbounded structure we own, and losing old turns costs a
 * re-sent delta at worst.
 */
export function trimResponseStates(targetBytes: number): number {
  let dropped = 0;
  while (totalBytes > targetBytes && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    totalBytes -= states.get(oldest)?.bytes ?? 0;
    states.delete(oldest);
    dropped++;
  }
  return dropped;
}

export function clearResponseStateForTests(): void {
  clearResponseStateMemoryForTests();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
}
