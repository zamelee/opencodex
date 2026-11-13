import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { memoryProfile } from "../lib/memory-profile";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
/**
 * Single-entry ceiling.
 *
 * A turn that carries screenshots is big: base64 inflates a 3 MB PNG to ~4 MB of
 * ASCII, and a Codex turn can carry several. The replay budget is a HARD line --
 * including for the newest entry; "keep the newest one whatever it costs" is what
 * let the cache exceed its own budget before. So an oversized entry is not allowed
 * to buy its way past the total, and past this size it is also kept out of the disk
 * snapshot: one screenshot-heavy turn must not become the file.
 */
const MAX_SINGLE_RESPONSE_STATE_BYTES = 8 * 1024 * 1024;
/** How many evicted response ids we remember, so a later miss can be explained. */
const MAX_TOMBSTONES = 2_000;
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
interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  conversationId?: string;
  cursorCheckpointUsable?: boolean;
  /** Approximate RAM footprint of `items` (see approxBytes). */
  bytes?: number;
  /**
   * Session this turn belongs to. Sessions are inferred from the
   * previous_response_id chain: a turn that continues an existing chain inherits
   * its session. Eviction then removes whole sessions, so one conversation is never
   * cut in half by a byte budget.
   */
  sessionKey: string;
  /** Last time this entry (or its session) was touched. */
  lastAccessAt: number;
  /** Set when the entry is past MAX_SINGLE_RESPONSE_STATE_BYTES. */
  oversized?: boolean;
}

const states = new Map<string, StoredResponseState>();
/** sessionKey -> ids of that session. */
const sessions = new Map<string, Set<string>>();
/** sessionKey -> most recent access. Keeps session eviction O(sessions), not O(entries). */
const sessionLastAccess = new Map<string, number>();
/** Ids we evicted, with the time. Lets a later miss say "we dropped it" instead of "unknown id". */
const tombstones = new Map<string, number>();
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
  // Default scales with the machine: 2% of RAM, clamped to 32 MB - 256 MB.
  // See lib/memory-profile.ts for why a fixed ceiling was the wrong shape.
  return memoryProfile().replayBudgetBytes;
}

/**
 * Cheap size estimate for an arbitrary JSON-ish value.
 *
 * Deliberately NOT JSON.stringify: this runs on every stored response, and the
 * payloads are megabytes of base64. Strings dominate (UTF-16 in V8), so length*2
 * is the right approximation; containers add a small constant per element.
 *
 * The one thing that changed: strings are measured in UTF-8 BYTES, not UTF-16 code
 * units. Base64 is ASCII, so V8 keeps it in a one-byte representation -- counting
 * it as 2 bytes per char overstated every screenshot by exactly 2x, and the budget
 * it feeds was therefore half the budget it claimed to be.
 */
function approxBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  const kind = typeof value;
  if (kind === "string") return Buffer.byteLength(value as string, "utf8") + 8;
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
      total += Buffer.byteLength(key, "utf8") + approxBytes(item);
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
      const sessionKey = typeof rec.sessionKey === "string" ? rec.sessionKey : `legacy:${id}`;
      const lastAccessAt = typeof rec.lastAccessAt === "number" ? rec.lastAccessAt : rec.createdAt;
      states.set(id, { ...rec, bytes, sessionKey, lastAccessAt });
      const group = sessions.get(sessionKey);
      if (group) group.add(id);
      else sessions.set(sessionKey, new Set([id]));
      const known = sessionLastAccess.get(sessionKey) ?? 0;
      if (lastAccessAt > known) sessionLastAccess.set(sessionKey, lastAccessAt);
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
      if (entry[1].oversized) continue;
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
      removeEntry(id, state);
    }
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    const state = states.get(oldest);
    if (!state) break;
    totalBytes -= state.bytes ?? 0;
    removeEntry(oldest, state);
  }
  evictToBudget();
}

/**
 * Drop one entry and clean up every index that points at it.
 */
function removeEntry(id: string, state: StoredResponseState): void {
  states.delete(id);
  const group = sessions.get(state.sessionKey);
  if (group) {
    group.delete(id);
    if (group.size === 0) {
      sessions.delete(state.sessionKey);
      sessionLastAccess.delete(state.sessionKey);
    }
  }
}

/**
 * Remember that we dropped this id, so a later miss can say "the proxy evicted it"
 * rather than "never heard of it". Bounded: the oldest tombstones go first.
 */
function tombstone(id: string, at = now()): void {
  tombstones.set(id, at);
  while (tombstones.size > MAX_TOMBSTONES) {
    const oldest = tombstones.keys().next().value;
    if (!oldest) break;
    tombstones.delete(oldest);
  }
}

/**
 * The session to evict next: the one whose most recent member was touched longest
 * ago. A session is a chain of previous_response_id turns, so evicting it as a
 * unit keeps a conversation whole (or drops it entirely) instead of leaving a
 * half-chain that the client cannot use.
 */
function oldestSessionKey(): string | undefined {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, last] of sessionLastAccess) {
    if (last < oldestAt) {
      oldestAt = last;
      oldestKey = key;
    }
  }
  return oldestKey;
}

/**
 * Keep the RAM copy under its byte budget.
 *
 * Sessions go first, coldest first: a live conversation chains through the RECENT
 * ids, while the stale ones are the ones a resumed-after-an-hour thread would lose
 * anyway (they are already past the TTL).
 *
 * NOTE there is no "keep the newest one" escape hatch any more. The old code kept
 * at least one entry alive whatever its size, so a single huge turn could push the
 * cache past its own budget; the budget has to mean what it says. When even the
 * newest entry does not fit, it is dropped too and recorded as a tombstone, so the
 * next turn that chains to it gets a diagnosable miss instead of a silently
 * truncated history.
 */
function evictToBudget(): void {
  const budget = responseStateMaxBytes();
  let guard = 0;
  while (totalBytes > budget && states.size > 0 && guard++ < 10_000) {
    const key = oldestSessionKey();
    if (key === undefined) break;
    const group = sessions.get(key);
    if (!group || group.size === 0) {
      sessions.delete(key);
      continue;
    }
    // Evict the session's turns oldest first.
    const ids = [...group].sort((a, b) => {
      const sa = states.get(a)?.createdAt ?? 0;
      const sb = states.get(b)?.createdAt ?? 0;
      return sa - sb;
    });
    for (const id of ids) {
      const state = states.get(id);
      if (!state) continue;
      totalBytes -= state.bytes ?? 0;
      removeEntry(id, state);
      tombstone(id);
    }
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
  // Touch the chain: an actively used session is the last one we want to evict.
  previous.lastAccessAt = now();
  sessionLastAccess.set(previous.sessionKey, previous.lastAccessAt);
  return {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
}

/**
 * What we know about a previous_response_id the client sent us.
 *
 * `found: false` does NOT mean the turn is lost: the upstream (ChatGPT) keeps its
 * own response store and may resolve the id on its own. It means the LOCAL replay
 * cache cannot expand it. `evictedByUs` separates "we dropped it under the memory
 * budget" from "we never had it" -- the first is a local resource decision we can
 * explain, the second usually means the upstream has to handle the chain.
 */
export function replayStateLookup(previousResponseId: string | undefined): {
  found: boolean;
  evictedByUs: boolean;
} {
  if (!previousResponseId) return { found: false, evictedByUs: false };
  ensureLoaded();
  pruneResponses();
  if (states.has(previousResponseId)) return { found: true, evictedByUs: false };
  return { found: false, evictedByUs: tombstones.has(previousResponseId) };
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
  const budget = responseStateMaxBytes();
  if (bytes > budget) {
    // A single turn larger than the whole budget cannot be stored without breaking
    // the budget, and "the newest entry is exempt" is exactly the hole that let
    // the cache grow past its limit before. Refuse it and leave a tombstone so the
    // next chained turn gets a diagnosable miss instead of a silent truncation.
    tombstone(response.id);
    console.warn(
      `[opencodex] replay state for ${response.id} is ${bytes} bytes, larger than the `
      + `whole budget (${budget}); not stored (chain for this turn will be expanded by the upstream)`,
    );
    return;
  }
  // The chain this turn continues. Sessions are inferred from previous_response_id:
  // a turn that continues an existing chain inherits its session, so eviction can
  // drop whole conversations instead of slicing them.
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  const inherited = previousId ? states.get(previousId)?.sessionKey : undefined;
  const sessionKey = inherited ?? `s:${response.id}`;
  const oversized = bytes > MAX_SINGLE_RESPONSE_STATE_BYTES;
  if (oversized) {
    console.warn(
      `[opencodex] replay state for ${response.id} is ${bytes} bytes, past the single-entry `
      + `limit (${MAX_SINGLE_RESPONSE_STATE_BYTES}); kept in RAM but not written to the disk snapshot`,
    );
  }
  const previous = states.get(response.id);
  if (previous) {
    totalBytes -= previous.bytes ?? 0;
    removeEntry(response.id, previous);
  }
  states.set(response.id, {
    createdAt: now(),
    items,
    bytes,
    sessionKey,
    lastAccessAt: now(),
    ...(oversized ? { oversized } : {}),
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
  const group = sessions.get(sessionKey);
  if (group) group.add(response.id);
  else sessions.set(sessionKey, new Set([response.id]));
  sessionLastAccess.set(sessionKey, now());
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
  sessions.clear();
  sessionLastAccess.clear();
  tombstones.clear();
  totalBytes = 0;
  loaded = false;
}

/** RAM/entry counters for the memory diagnostics endpoint. */
export function responseStateStats(): {
  entries: number;
  bytes: number;
  maxBytes: number;
  sessions: number;
  evicted: number;
} {
  return {
    entries: states.size,
    bytes: totalBytes,
    maxBytes: responseStateMaxBytes(),
    sessions: sessions.size,
    evicted: tombstones.size,
  };
}

/**
 * Drop the oldest replay-state entries until the cache is under `targetBytes`.
 * Used by the memory guard when the process RSS crosses its ceiling: the replay
 * cache is the only unbounded structure we own, and losing old turns costs a
 * re-sent delta at worst.
 *
 * Sessions go as a unit here too: dropping half a chain leaves the client with a
 * previous_response_id it cannot use, which is worse than dropping the whole
 * conversation.
 */
export function trimResponseStates(targetBytes: number): number {
  let dropped = 0;
  let guard = 0;
  while (totalBytes > targetBytes && states.size > 0 && guard++ < 10_000) {
    const key = oldestSessionKey();
    if (key === undefined) break;
    const group = sessions.get(key);
    if (!group || group.size === 0) {
      sessions.delete(key);
      continue;
    }
    for (const id of group) {
      const state = states.get(id);
      if (!state) continue;
      totalBytes -= state.bytes ?? 0;
      removeEntry(id, state);
      tombstone(id);
      dropped++;
    }
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
