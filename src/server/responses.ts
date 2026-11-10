import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../bridge";
import {
  getConfigPath,
  resolveEnvValue,
} from "../config";
import { parseRequest } from "../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../responses/compaction";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseConversationId, rememberResponseState } from "../responses/state";
import { routeModel } from "../router";
import { isInjectionDebugEnabled } from "../lib/debug-settings";
import { modelInList, namespacedToolName } from "../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import {
  getOAuthCredentialProjectId,
  getValidAccessToken,
  UnsupportedOAuthProviderError,
} from "../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch } from "../web-search";
import { describeImagesInPlace, planVisionSidecar, stripImagesInPlace } from "../vision";
import { createAdapterEventQueue } from "../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../codex/routing";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { isUsageDebugEnabled } from "../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "./request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "./adapter-resolve";
import { hasKeyPoolFailover, rotateKeyOn429, rotateKeyOnQuota } from "../providers/key-failover";
import { isQuotaExhausted, resolveQuotaRetryPolicy, sleepWithAbort } from "../providers/quota-retry";
import { resolveImageDownsampleEnabled } from "../providers/image-downsample";
import { resolveGateLimit } from "../providers/gate-limit";
import type { WsData } from "./ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "./lifecycle";
import { redactSecretString } from "../lib/redact";
import { isContentPolicyRejection } from "../lib/errors";
import { summarizeRequestBody } from "../lib/token-composition";
import {
  COMPACTION_BUDGET_FACTOR,
  effectiveUpstreamPromptLimit,
  enforceUpstreamPromptBudget,
  learnedUpstreamPromptLimit,
  noteUpstreamPromptLimit,
  saveLearnedLimits,
  parseUpstreamPromptGate,
  parseUpstreamRejection,
} from "../lib/upstream-prompt-budget";
import {
  gateCircuitState,
  gateCircuitVerdictFor,
  noteGateRejection,
  noteGateSuccess,
  saveGateCircuit,
} from "../lib/upstream-gate-circuit";
import {
  noteUpstreamTokenScale,
  saveLearnedScales,
  upstreamTokenScaleFactor,
} from "../lib/upstream-token-scale";
import {
  catalogModelSupportsServiceTier,
  captureUpstreamErrorFromText,
  inspectResponseLogJson,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  type RequestLogContext,
} from "./request-log";
import { summarizeUpstreamErrorBody } from "../lib/upstream-error-body";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "./relay";

export function buildToolBridgeMaps(parsed: OcxParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
    if (t.freeform) freeformToolNames.add(t.name);
    if (t.toolSearch) toolSearchToolNames.add(t.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

/** Verbatim upstream Proactive text (codex-rs core/src/context/multi_agent_mode_instructions.rs). */
const PROACTIVE_MULTI_AGENT_MODE_TEXT = [
  "Proactive multi-agent delegation is active.",
  "Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
  "Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently.",
  "Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself.",
  "This mode remains active until a later multi-agent mode developer message changes it.",
].join(" ");

/**
 * True when this turn runs the v1 collab surface, judged from the request's own tool list
 * (codex registers exactly one surface per thread, core/src/tools/spec_plan.rs): v1 ships
 * spawn_agent inside a namespace plus v1-only names (send_input/close_agent); v2 ships a
 * flat spawn_agent. A flat spawn_agent vetoes so an ambiguous mix never counts as v1.
 */
export function isV1CollabSurface(parsed: OcxParsedRequest): boolean {
  return collabSurface(parsed) === "v1";
}

/**
 * Which multi-agent collab surface this turn carries, judged from the request's own
 * tool list. Real wire shapes (codex-rs spec_plan.rs add_collaboration_tools):
 *  - v1: tools under the "multi_agent_v1" namespace, always accompanied by v1-only
 *    names (send_input / resume_agent / close_agent).
 *  - v2 on namespace_tools providers (e.g. the ChatGPT backend): tools under the
 *    "collaboration" namespace (config.multi_agent_v2.tool_namespace — user-settable,
 *    so the name is not hardcoded here), with v2-only companions (send_message /
 *    followup_task / interrupt_agent / list_agents).
 *  - v2 without namespace support: a flat spawn_agent.
 * Companion tools are the primary discriminator; a companionless namespaced spawn
 * falls back to "v1" (legacy behavior) and a companionless flat spawn to "v2".
 * Contradictory markers count as neither — never inject on unclear ground.
 */
export function collabSurface(parsed: OcxParsedRequest): "v1" | "v2" | null {
  let namespacedSpawn = false;
  let flatSpawn = false;
  let v1Only = false;
  let v2Only = false;
  for (const t of parsed.context.tools ?? []) {
    if (t.name === "spawn_agent") {
      if (t.namespace) namespacedSpawn = true;
      else flatSpawn = true;
    } else if (t.name === "send_input" || t.name === "resume_agent" || t.name === "close_agent") {
      v1Only = true;
    } else if (t.name === "send_message" || t.name === "followup_task" || t.name === "interrupt_agent" || t.name === "list_agents") {
      v2Only = true;
    }
  }
  if (!namespacedSpawn && !flatSpawn) return null; // no spawn_agent -> no collab surface
  if (namespacedSpawn && flatSpawn) return null;   // contradictory spawn shapes
  if (v1Only && v2Only) return null;               // contradictory companions
  if (v1Only) return "v1";
  if (v2Only) return "v2";
  return namespacedSpawn ? "v1" : "v2"; // companionless fallbacks (legacy defaults)
}

/**
 * Multi-agent guidance for this turn, or null when nothing applies.
 *
 * V1 surface: codex-rs only emits its Proactive delegation developer message on the
 * v2 surface, so when a v1-surface turn arrives at the synthetic top tier (codex
 * converts ultra -> max on the wire, so max arrival means the user picked the top
 * rung) the proxy supplies the same one-liner, wrapped in codex's own
 * <multi_agent_mode> tags. That is ALL v1 gets — no model designation, no roster
 * (kept lean by request, devlog 260710): ultra-tier injection is sufficient there.
 *
 * V2 surface (flat spawn_agent — sol/terra under the default mode, EVERY model when
 * `ocx v2 mode v2` forces the pins): codex-rs already emits its own Proactive text
 * there, so the proxy never duplicates it — it adds only model-designation guidance,
 * and only when it has something to designate: an injectionModel and/or a
 * subagentModels roster entry that resolves in the injected catalog. v2 rejects
 * model/effort overrides on a full-history fork (multi_agents_v2/spawn.rs
 * reject_full_fork_spawn_overrides), so the prompt mandates fork_turns "none" or a
 * partial fork plus a self-contained task message.
 * The published spawn_agent schema HIDES model/reasoning_effort by
 * default (hide_spawn_agent_metadata=true upstream — and it must STAY hidden: the
 * ChatGPT backend treats collaboration.spawn_agent as a reserved function and
 * rejects any request whose declared schema deviates, "Invalid Value: 'tools'").
 * That is prompt-workable: SpawnAgentArgs always parses model/reasoning_effort
 * regardless of the flag (spawn.rs), so the prompt tells the model to pass the
 * arguments even though the schema does not list them.
 *
 * The v2 body is budgeted to <= 700 chars (V2_GUIDANCE_CHAR_BUDGET): rules first,
 * then the preferred model, then the compact roster of configured `subagentModels`
 * with the effort ladder each advertises in the injected catalog (the list codex-rs
 * validates spawn efforts against). A user-configured `injectionPrompt` replaces the
 * v2 body with {{model}}/{{effort}}/{{roster}} placeholder substitution (own length,
 * user-owned); firing gates are unchanged.
 */
export async function multiAgentGuidanceText(parsed: OcxParsedRequest, injectionModel?: string, injectionEffort?: string, subagentModels?: string[], injectionPrompt?: string): Promise<string | null> {
  const surface = collabSurface(parsed);
  if (surface === null) return null;

  if (surface === "v2") {
    // codex-rs supplies the Proactive text on v2; the proxy only adds model-designation
    // guidance, and only when there is something concrete to designate: a configured
    // injectionModel and/or a roster entry that resolves in the injected catalog.
    const roster = await subagentRosterText(subagentModels);
    if (!injectionModel && roster === "") return null;
    if (injectionPrompt) {
      return `<multi_agent_mode>${applyInjectionPlaceholders(injectionPrompt, injectionModel, injectionEffort, roster)}</multi_agent_mode>`;
    }
    let text = "spawn_agent also accepts hidden \"model\" and \"reasoning_effort\" string arguments "
      + "(not in the schema, but parsed and applied) — never claim sub-agent models cannot be selected. "
      + "When setting either, set fork_turns to \"none\" (or e.g. \"3\"; full-history forks reject overrides) "
      + "and make the message self-contained.";
    if (injectionModel) {
      text += ` Preferred sub-agent: model "${injectionModel}"`
        + (injectionEffort ? `, reasoning_effort "${injectionEffort}"` : "")
        + " — use it unless the user names another.";
    }
    text += roster;
    if (text.length > V2_GUIDANCE_CHAR_BUDGET) {
      // Roster is the only unbounded part — drop it before breaking the budget.
      text = text.slice(0, text.length - roster.length);
    }
    return `<multi_agent_mode>${text}</multi_agent_mode>`;
  }

  const effort = parsed.options.reasoning;
  // v1 keeps only the upstream-parity behavior: Proactive text at the top tier
  // (ultra arrives as max on the wire). No designation/roster payload here.
  if (effort !== "max" && effort !== "ultra") return null;
  return `<multi_agent_mode>${PROACTIVE_MULTI_AGENT_MODE_TEXT}</multi_agent_mode>`;
}

/** Hard budget for the built-in v2 guidance body (user request: keep injection lean). */
export const V2_GUIDANCE_CHAR_BUDGET = 700;

/** {{model}}/{{effort}}/{{roster}} substitution for the user-configured injectionPrompt. */
function applyInjectionPlaceholders(prompt: string, model?: string, effort?: string, roster?: string): string {
  return prompt
    .replaceAll("{{model}}", model ?? "")
    .replaceAll("{{effort}}", effort ?? "")
    .replaceAll("{{roster}}", roster ?? "");
}

/**
 * Compact one-line roster of configured sub-agent models, or "" when no configured
 * model resolves to a catalog entry. Efforts come from the injected catalog
 * (catalogModelEfforts) so only rungs codex-rs will actually accept are advertised.
 */
async function subagentRosterText(subagentModels?: string[]): Promise<string> {
  const featured = (subagentModels ?? []).filter(id => typeof id === "string" && id.trim().length > 0);
  if (featured.length === 0) return "";
  const { catalogModelEfforts } = await import("../codex/catalog");
  const efforts = catalogModelEfforts(featured);
  const resolved = featured.filter(id => efforts.has(id));
  if (resolved.length === 0) return "";
  const ladders = new Set(resolved.map(id => efforts.get(id)!.join("/")));
  if (ladders.size === 1) {
    // Shared ladder (the common case: the injected catalog advertises one rung set)
    // -> state it once instead of per model, keeping the roster inside the budget.
    const ids = resolved.map(id => `"${id}"`).join(", ");
    return ` Available models (reasoning_effort ${[...ladders][0]}): ${ids}.`;
  }
  const entries = resolved.map(id => `"${id}" (${efforts.get(id)!.join("/")})`);
  return ` Available models (valid reasoning_effort): ${entries.join(", ")}.`;
}

/**
 * Append a developer message to BOTH request shapes: parsed.context.messages feeds the
 * routed adapters, while the ChatGPT passthrough serializes _rawBody verbatim (same
 * dual-write contract as the mock-max clamp in handleResponses).
 */
export function injectDeveloperMessage(parsed: OcxParsedRequest, text: string): void {
  parsed.context.messages.push({ role: "developer", content: text, timestamp: Date.now() });
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  if (raw && Array.isArray(raw.input)) {
    const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text }] };
    // compaction_trigger must remain the final input item (codex-rs + ChatGPT backend both
    // validate this). Insert the developer message BEFORE the trigger when present.
    const last = raw.input[raw.input.length - 1];
    if (last && typeof last === "object" && (last as { type?: string }).type === "compaction_trigger") {
      raw.input.splice(raw.input.length - 1, 0, devItem);
    } else {
      raw.input.push(devItem);
    }
  }
}

/**
 * True when an encrypted_content payload plausibly came from the ChatGPT backend
 * (opaque base64-ish blob). codex-rs's `InterAgentCommunication::new_encrypted` performs
 * NO local crypto — it just parks plaintext in the encrypted slot and relies on the
 * backend to swap in real ciphertext. Under a routed (ocx-served) parent the backend
 * never sees the parent turn, so the slot still holds plaintext when a native child
 * replays it — and the backend then fails the turn with "Encrypted function output
 * content could not be decrypted or decoded" (observed 260709 as 502 retry loops).
 */
function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}

/**
 * Backend-minted ciphertext runs are Fernet tokens (base64url, version byte 0x80 ->
 * literal "gAAAA" prefix). Used to carve embedded blobs out of MIXED slots: plugin
 * hooks (e.g. codexclaw's leaf guard) prepend plaintext preambles to spawn messages
 * whose task body is already backend-encrypted, producing a slot that is neither
 * decryptable (backend) nor readable (model) as a whole.
 */
const FERNET_TOKEN_RUN = /gAAAA[A-Za-z0-9_-]{60,}={0,2}/g;

/**
 * Split a non-ciphertext encrypted slot into ordered parts: prose becomes input_text,
 * embedded Fernet blobs stay encrypted_content so the backend can still decrypt the
 * real task body. A slot with no embedded blob degrades to a single input_text part.
 */
function encryptedSlotParts(payload: string): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = [];
  let last = 0;
  for (const match of payload.matchAll(FERNET_TOKEN_RUN)) {
    const index = match.index ?? 0;
    const before = payload.slice(last, index);
    if (before.trim().length > 0) parts.push({ type: "input_text", text: before });
    parts.push({ type: "encrypted_content", encrypted_content: match[0] });
    last = index + match[0].length;
  }
  const rest = payload.slice(last);
  if (rest.trim().length > 0) parts.push({ type: "input_text", text: rest });
  return parts.length > 0 ? parts : [{ type: "input_text", text: payload }];
}

function hasEncryptedContentPart(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => (
    part && typeof part === "object"
    && (part as { type?: unknown }).type === "encrypted_content"
  ));
}

/**
 * Rewrite non-ciphertext `{type:"encrypted_content"}` parts into `{type:"input_text"}`
 * throughout a request's input items (message content and function_call_output content
 * arrays share the part shape, codex-rs protocol/models.rs). An `agent_message` whose
 * payload becomes entirely plaintext is normalized to a user message so routed parsers
 * that do not understand the internal item type still deliver the spawn task.
 * Genuine backend blobs are left byte-identical so replay/cache semantics survive, and
 * MIXED slots (plaintext preamble + embedded Fernet task body) are split so the backend
 * decrypts the blob while the prose passes as text. Returns the number of parts rewritten.
 */
export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  const visit = (node: unknown): number => {
    const before = rewritten;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const child = node[i] as unknown;
        if (
          child && typeof child === "object"
          && (child as { type?: unknown }).type === "encrypted_content"
          && typeof (child as { encrypted_content?: unknown }).encrypted_content === "string"
        ) {
          const payload = (child as { encrypted_content: string }).encrypted_content;
          if (!looksLikeBackendCiphertext(payload)) {
            const parts = encryptedSlotParts(payload);
            node.splice(i, 1, ...parts);
            i += parts.length - 1;
            rewritten += 1;
            continue;
          }
        }
        const childRewrites = visit(child);
        if (
          childRewrites > 0
          && child && typeof child === "object"
          && (child as { type?: unknown }).type === "agent_message"
          && !hasEncryptedContentPart((child as { content?: unknown }).content)
        ) {
          const message = child as { type: string; role?: string; author?: unknown; recipient?: unknown };
          message.type = "message";
          message.role = "user";
          delete message.author;
          delete message.recipient;
        }
      }
      return rewritten - before;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) visit(value);
    }
    return rewritten - before;
  };
  visit(input);
  return rewritten;
}

export function sidecarOutcomeRecorder(config: OcxConfig, authCtx: CodexAuthContext): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome)
    : undefined;
}

/** Account id to attribute log labels / upstream outcomes to (pool + rotation-injected main). */
export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

export function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): ((status: ResponsesTerminalStatus) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return status => recordCodexUpstreamOutcome(config, authCtx.accountId, status === "completed" ? 200 : 502);
}

/**
 * Map a request-body read failure to an honest error response. `readJsonRequestBody` can fail three
 * ways and they must not all collapse into "Invalid JSON body": an unsupported content-encoding
 * (415), a body that inflates past the decompression cap (413 — the image-heavy case Codex hits when
 * zstd-compressed screenshot history exceeds the limit), or a genuine JSON syntax error (400). The
 * real decode error was previously swallowed, so log it before returning the generic 400.
 */
/**
 * The upstream's real prompt window for this route.
 *
 * The upstream's real ceiling is what it told us in a previous "prompt is too long: N > M
 * maximum" error. Until we have seen one, we fall back to what the provider declares.
 */
function upstreamPromptLimitFor(route: {
  provider: OcxProviderConfig;
  providerName: string;
  modelId: string;
}, config: Pick<OcxConfig, "modelGateLimits">): number | undefined {
  // The operator's manual gate wins over everything we know: it is a CURRENT decision, while
  // the learned number is a historical observation. "upstream" means no local gate at all -
  // the request goes out as it is and the upstream's own refusal is the truth.
  const manual = resolveGateLimit(config, route.providerName, route.modelId);
  if (manual.mode === "upstream") return undefined;
  if (manual.mode === "manual" && manual.limit !== undefined) return manual.limit;
  const learned = learnedUpstreamPromptLimit(route.providerName, route.modelId);
  // The LEARNED limit is the upstream's real ceiling; the declared one is what we tell the
  // client on purpose (usually conservative, to make the client's brake fire earlier). Using the
  // declared value for OUR brake would make us drop images long before the upstream would
  // reject anything, so the learned value wins when we have it.
  if (learned !== undefined) return learned;
  const declared = route.provider.contextWindow
    ?? route.provider.modelContextWindows?.[route.modelId];
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : undefined;
}

/** The completion budget the upstream reserves on the wire body (`max_tokens`). */
function readMaxTokens(body: unknown): number {
  try {
    const parsed = (typeof body === "string" ? JSON.parse(body) : body) as { max_tokens?: unknown };
    return typeof parsed?.max_tokens === "number" && parsed.max_tokens > 0
      ? parsed.max_tokens
      : 0;
  } catch {
    return 0;
  }
}

export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (err instanceof UnsupportedContentEncodingError) {
    return formatErrorResponse(415, "invalid_request_error", err.message);
  }
  if (err instanceof DecompressedBodyTooLargeError) {
    return formatErrorResponse(413, "invalid_request_error", err.message);
  }
  console.warn(`[${label}] request body decode/parse failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
}

export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: {
    forceEmptyResponseId?: boolean;
    abortSignal?: AbortSignal;
    authContext?: CodexAuthContext;
    selectedForwardHeaders?: Headers;
    recordTerminalOutcomes?: boolean;
    setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus) => void) | undefined) => void;
    onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
    onNativePassthroughCancel?: () => void;
  } = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses");
  }
  const originalBody = body;
  body = expandPreviousResponseInput(body);
  const previousResponseInputExpanded = body !== originalBody;

  // Spawn-message compatibility (both directions): agent_message task payloads ride in
  // encrypted_content slots as plaintext. Rewrite them to input_text on the RAW body BEFORE
  // parsing so every consumer sees the payload: parseRequest (routed/translated providers read
  // the parsed messages) and the native passthrough (_rawBody is this same object, serialized
  // verbatim). Genuine backend ciphertext is left byte-identical (looksLikeBackendCiphertext).
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  let parsed;
  try {
    parsed = parseRequest(body);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._cursorConversationId = previousResponseConversationId(parsed.previousResponseId);
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  let route: ReturnType<typeof routeModel>;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  let routeModelError: Error | null = null;

  // Location E: if a previous request's stream died without firing its onDone callback,
  // a stale `pendingKeyChange` may still be hanging on the provider config. Force-commit
  // it now so the dispatch below uses a fresh, consistent apiKey.
  try {
    const { commitPendingKeyChange } = await import("../providers/key-scheduler");
    const committed = commitPendingKeyChange(config, route.providerName);
    if (committed) {
      try {
        route = routeModel(config, parsed.modelId);
      } catch (err) {
        routeModelError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (routeModelError) {
      return formatErrorResponse(404, "invalid_request_error", routeModelError.message);
    }
  } catch {
    /* commit failures are already logged inside commitPendingKeyChange; never break dispatch */
  }
  void routeModelError;

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace
  // (e.g. "opencode-go/deepseek-v4-pro" → "deepseek-v4-pro"). Adapters read parsed.modelId,
  // and the passthrough adapter serializes _rawBody, so rewrite both.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;

  // Quota-aware proactive key scheduling ("A+B": 5h-threshold gate + expiry-urgency ranking).
  // Rotates the active pool key BEFORE dispatch when its estimated 5h utilization crosses
  // the configured threshold; non-quota providers and probe failures degrade silently to
  // the reactive 429 path (src/providers/key-scheduler.ts). Also records one billable
  // dispatch for the local estimate between probes. Best-effort — never breaks a request.
  try {
    const { maybeRotateForQuota, recordRoutedCall } = await import("../providers/key-scheduler");
    // maybeRotateForQuota now stages the rotation as `provider.pendingKeyChange` instead
    // of mutating `apiKey` directly, so the in-flight dispatch on this route keeps
    // using the old key. commitPendingKeyChange runs when the dispatch stream closes
    // (or, if the stream dies without it, at the start of the next request). This is
    // the path that fixes CodexPlusPlus 502s on 5h-threshold rotations: before, this
    // code re-routed the whole RouteResult, which under load could swap providers mid-
    // stream and trigger an upstream_stall_timeout abort.
    await maybeRotateForQuota(config, route.providerName);
    const dispatchedPoolKey = route.provider.apiKeyPool?.find(entry => entry.key === route.provider.apiKey);
    if (dispatchedPoolKey) recordRoutedCall(route.providerName, dispatchedPoolKey.id);
  } catch {
    // scheduling must never break the request path
  }

  // Multi-agent guidance shim: codex-rs emits its Proactive delegation developer
  // message only on the v2 surface. The proxy fills both gaps: the Proactive text
  // for v1 collab surfaces at the top tier, and the sub-agent model designation on
  // BOTH surfaces when an injectionModel is configured (v2 additionally gets the
  // fork_turns override rules). The surface is judged from the request's own tool list.
  // Runs BEFORE the mock-max clamp below so the synthetic top tier (ultra arrives
  // as max on the codex wire) is still visible. Both request shapes are rewritten.
  {
    const guidance = await multiAgentGuidanceText(parsed, config.injectionModel, config.injectionEffort, config.subagentModels, config.injectionPrompt);
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) console.log(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, ${guidance.length} chars)`);
    } else if (isInjectionDebugEnabled() && collabSurface(parsed) !== null) {
      console.log(`[opencodex] ${route.modelId}: collab surface=${collabSurface(parsed)}, guidance silent (effort=${parsed.options.reasoning ?? "unset"}, injectionModel=${config.injectionModel ?? "unset"})`);
    }
  }

  // Hard effort caps (effortCap / subagentEffortCap): enforcement companion to the advisory
  // injection above — spawn-arg prompting cannot stop codex-rs from inheriting the parent's
  // ultra-tier default on bare spawns (see src/server/effort-policy.ts). Runs BEFORE the
  // mock-max clamp so a capped effort is what nativeness clamping then validates; rewrites
  // both request shapes (same dual-write contract as the clamp below).
  // GATE: v2 feature only (effortCapAppliesTo) — v2-surface main turns plus header-marked
  // child turns admitted regardless of tool surface (depth-limited leaves carry no collab
  // tools while shallower children do, so tool sniffing alone would cap siblings
  // inconsistently); multiAgentMode "v1" disables caps entirely; compaction turns bypass
  // caps so routed compaction matches native /v1/responses/compact (which never enters
  // handleResponses).
  {
    const { applyEffortCap, effortCapAppliesTo, supportedLadderFor } = await import("./effort-policy");
    const surface = collabSurface(parsed);
    if (effortCapAppliesTo(surface, req.headers, config, parsed._compactionRequest === true)) {
      const capped = applyEffortCap(parsed, req.headers, config, supportedLadderFor(route));
      if (capped) {
        logCtx.requestedEffort = `${capped.from}->${capped.to}`;
        if (isInjectionDebugEnabled()) {
          console.log(`[opencodex] ${route.modelId}: effort cap applied (${capped.from} -> ${capped.to}, ${capped.subagent ? "sub-agent" : "main"} turn)`);
        }
      }
    } else if (isInjectionDebugEnabled() && (config.effortCap || config.subagentEffortCap)) {
      console.log(`[opencodex] ${route.modelId}: effort cap skipped (surface=${surface ?? "none"}, v2 feature only)`);
    }
  }

  // Mock-max clamp: native models whose real ladder stops below max (gpt-5.5/5.4/…)
  // receive `max` when the user picks Ultra (codex converts ultra->max client-side).
  // Clamp to the model's highest real effort BEFORE any adapter — the ChatGPT
  // passthrough serializes _rawBody verbatim, so both shapes must be rewritten.
  // GUARD: judge nativeness by the ORIGINALLY REQUESTED id (logCtx.requestedModel),
  // never by route.modelId — routing strips the "<provider>/" namespace, so a routed
  // model (anthropic/claude-opus-4-6, real max) would masquerade as an off-snapshot
  // bare native and get wrongly clamped. Routed efforts belong to their adapters.
  {
    const requestedModelId = logCtx.requestedModel ?? route.modelId;
    const { nativeEffortClamp } = await import("../codex/catalog");
    const clamped = requestedModelId.includes("/")
      ? null
      : nativeEffortClamp(route.modelId, parsed.options.reasoning);
    if (clamped) {
      parsed.options.reasoning = clamped;
      const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
      if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = clamped;
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? "max"}->${clamped}`;
    }
  }
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );

  let authCtx: CodexAuthContext;
  let selectedForwardHeaders: Headers;
  // Headers used to call the ChatGPT *forward* backend for the sidecars (vision describe, web
  // search). They are NOT the routed provider's headers: a key-auth provider must never receive
  // the caller's ChatGPT credential, so `selectedForwardHeaders` stays empty for key routes while
  // the sidecars still get the credential they need.
  let sidecarForwardHeaders: Headers;
  // Only resolve a Codex OAuth context when the routed provider actually uses Codex account
  // forwarding. key-auth providers (custom API keys, local mocks) must skip the pool
  // resolution entirely; otherwise we 401 on unrelated Codex pool-account state.
  const providerUsesCodexAuth = route.provider.authMode === "forward" || route.provider.authMode === "oauth";
  if (providerUsesCodexAuth) {
    try {
      authCtx = options.authContext ?? await resolveCodexAuthContext(req.headers, config);
      selectedForwardHeaders = options.selectedForwardHeaders ?? headersForCodexAuthContext(req.headers, authCtx);
      sidecarForwardHeaders = selectedForwardHeaders;
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      }
      if (err instanceof CodexThreadAffinityExpiredError) {
        return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
      }
      if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog(route.providerName, err.accountId, config);
        console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      }
      throw err;
    }
  } else {
    // key-auth provider: skip the Codex pool entirely. Provide a sentinel main ctx and an
    // empty Headers so downstream consumers (which all sit behind providerUsesCodexAuth)
    // operate on well-typed non-undefined values.
    authCtx = options.authContext ?? ({ kind: "main", accountId: null } as CodexAuthContext);
    selectedForwardHeaders = options.selectedForwardHeaders ?? new Headers();
    // key-auth route: don't touch the Codex account pool (that 401s unrelated pool state), but
    // still forward the caller's ChatGPT credential to the sidecars — derived from the incoming
    // request only, never from the pool.
    sidecarForwardHeaders = options.selectedForwardHeaders ?? headersForCodexAuthContext(req.headers, authCtx);
  }

  if (providerUsesCodexAuth) {
    if (!isCodexAuthContextUsable(authCtx, config)) {
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    route.provider = applyCodexAuthContextToProvider(route.provider, authCtx);
    logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);
  } else {
    // key-auth provider: skip Codex account resolution; providerUsesCodexAuth guards every
    // downstream consumer. The sentinel authCtx above is never used by the adapter.
    logCtx.provider = route.providerName;
  }

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  if (route.provider.authMode === "oauth") {
    try {
      route.provider = { ...route.provider, apiKey: await getValidAccessToken(route.providerName) };
      // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
      // CCA envelope; the server injects only the bare token, so pull project from the credential.
      if (route.provider.googleMode === "cloud-code-assist" && !route.provider.project) {
        const projectId = getOAuthCredentialProjectId(route.providerName);
        if (projectId) route.provider = { ...route.provider, project: projectId };
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${err.message}. Remove or reconfigure provider '${route.providerName}' in ${getConfigPath()}.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Give it "eyes" —
  // describe each attached image with a gpt vision model via the ChatGPT passthrough and replace it
  // with text BEFORE the main call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, sidecarForwardHeaders, authCtx);
  const recordSidecarOutcome = sidecarOutcomeRecorder(config, authCtx);
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan.forwardProvider, sidecarForwardHeaders, visionPlan.settings, options.abortSignal, recordSidecarOutcome);
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  const routedCompaction = parsed._compactionRequest === true && !("passthrough" in adapter && adapter.passthrough);
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  if ("passthrough" in adapter && adapter.passthrough) {
    // Local continuation cache for the ChatGPT passthrough. Codex WS turns chain with
    // previous_response_id, ocx converts them to internal HTTP requests, and the ChatGPT Codex
    // REST backend rejects the parameter — the adapter strips it in forward mode, so the ONLY
    // way a chained turn keeps its earlier context is the local replay expansion. Record
    // completed passthrough responses (force bypasses Codex's blanket store:false) so the next
    // turn's expansion hits. Never record a body whose own previous_response_id failed to
    // expand: its input is a delta, and storing it would replay a truncated conversation.
    // Compaction turns are excluded: _rawBody still carries the full pre-compaction history and
    // recording it would let a later expansion rehydrate the chain Codex just replaced.
    const passthroughRecordEligible = parsed._compactionRequest !== true
      && (!parsed.previousResponseId || parsed._previousResponseInputExpanded === true);
    const rememberPassthroughResponse = passthroughRecordEligible
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) =>
        rememberResponseState(parsed._rawBody, response, undefined, { force: true })
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithResetRetry(
        () => fetchWithHeaderTimeout(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }, upstream.signal, connectMs),
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } catch (err) {
      upstream.abort();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) recordCodexUpstreamOutcome(config, authCtx.accountId, outcome);
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(config, authCtx, route.provider);
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      const weeklyRaw = upstreamResponse.headers.get("x-codex-secondary-used-percent");
      const fiveHourRaw = upstreamResponse.headers.get("x-codex-primary-used-percent");
      const monthlyRaw = upstreamResponse.headers.get("x-codex-tertiary-used-percent");
      const weeklyResetRaw = upstreamResponse.headers.get("x-codex-secondary-reset-at");
      const fiveHourResetRaw = upstreamResponse.headers.get("x-codex-primary-reset-at");
      const monthlyResetRaw = upstreamResponse.headers.get("x-codex-tertiary-reset-at");
      const retryAfterRaw = upstreamResponse.headers.get("retry-after");
      if (weeklyRaw || fiveHourRaw || monthlyRaw) {
        const { updateAccountQuota } = await import("../codex/auth-api");
        updateAccountQuota(
          authCtx.accountId,
          weeklyRaw,
          fiveHourRaw,
          weeklyResetRaw,
          fiveHourResetRaw,
          monthlyRaw,
          monthlyResetRaw,
        );
      }
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.(status => {
          terminalRecorder(status);
          options.onNativePassthroughTerminal?.(status);
        });
      } else {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
          retryAfter: retryAfterRaw,
          resetAt: [fiveHourResetRaw, weeklyResetRaw, monthlyResetRaw],
        });
      }
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    if (isEventStream && upstreamResponse.body) {
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus) => {
          terminalRecorder?.(status);
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => options.onNativePassthroughCancel?.(),
          rememberPassthroughResponse,
        );
      } else {
        consumeForResponseLogMetadata(inspectBody, logCtx, turnAc.signal, () => unregisterTurn(turnAc), rememberPassthroughResponse);
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // win32 must keep the pure native relay (Bun#32111 JS-sink segfault); elsewhere a JS pull
      // relay is established practice (relayWithAbort, relaySseWithHeartbeat) and lets a
      // mid-stream reset end with a clean response.failed terminal instead of a raw socket error.
      const clientBody = process.platform === "win32"
        ? nativeBody
        : relaySseWithFailedTail(nativeBody, upstream);
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      if (upstreamResponse.ok && rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    // Location D: commit pendingKeyChange once the dispatch stream closes (or aborts).
    // Captures `route.providerName` so the callback can call commitPendingKeyChange after
    // dynamic import to avoid pulling key-scheduler into the hot request path before it's
    // needed. Without this, the next request's stale pendingKeyChange would only flush at
    // routeModel entry (Location E), leaving this request's mid-stream cuts unprotected.
    const tracked = body
      ? trackStreamLifetime(body, turnAc, () => {
          import("../providers/key-scheduler")
            .then(({ commitPendingKeyChange }) => commitPendingKeyChange(config, route.providerName))
            .catch((err) => console.warn(
              `[opencodex] failed to commit pending key change for ${route.providerName}: ${err instanceof Error ? err.message : String(err)}`,
            ));
        })
      : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  if (adapter.runTurn) {
    const runTurnAbort = new AbortController();
    linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue();
    const runTurn = async (): Promise<void> => {
      try {
        await adapter.runTurn?.(
          parsed,
          { headers: selectedForwardHeaders, abortSignal: runTurnAbort.signal },
          queue.push,
        );
      } catch (err) {
        queue.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        queue.close();
      }
    };

    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    if (parsed.stream) {
      void runTurn();
      const sseStream = bridgeToResponsesSSE(
        queue.stream(), parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(routedCompaction ? { compaction: true } : {}),
          ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc);
      return new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }

    await runTurn();
    const events = await queue.collect();
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, sidecarForwardHeaders, route.provider, route.modelId, authCtx);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      forwardProvider: wsPlan.forwardProvider,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: sidecarForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      upstreamPromptLimit: upstreamPromptLimitFor(route, config),
      providerName: route.providerName,
      modelId: route.modelId,
      ...(resolveImageDownsampleEnabled(config, route.providerName, route.modelId)
        ? { imageDownsample: true }
        : {}),
      ...(config.imageDownsampleMaxEdge !== undefined
        ? { imageDownsampleMaxEdge: config.imageDownsampleMaxEdge }
        : {}),
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      recordSidecarOutcome,
      // The sidecar's routed-model call gets its own (shorter) header budget so a hung upstream
      // cannot hold the user's turn for the full global connect timeout.
      connectTimeoutMs: wsPlan.connectTimeoutMs,
      routedModelStallTimeoutMs: wsPlan.routedModelStallTimeoutMs,
      stallTimeoutSec: wsPlan.stallTimeoutSec,
      onRequestComposition: (summary) => {
        logCtx.promptComposition = summary;
      },
      on429: retryAfter => {
        const rotated = rotateKeyOn429(config, route.providerName, retryAfter, Date.now(), route.provider.apiKey);
        if (!rotated) return null;
        if (!rotated.apiKey) return null; // rotated without an apiKey cannot stage a commit
        // Rebuild the adapter from the ROTATED provider. `route.provider` is the router's
        // snapshot of the provider (routedProviderConfig returns a COPY) and still carries
        // the exhausted apiKey — building from it burns one more upstream request on a key
        // we already know is rate-limited, which is exactly the stall this path exists to
        // avoid. rotateKeyOn429 has already swapped + persisted the active key, so the
        // rotated config is the truth from here on.
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, rotated),
          config.cacheRetention,
        );
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    return wsResponse;
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;

  const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  // Measure the body the upstream is about to see. Codex counts the prompt in ITS tokenizer
  // and applies ITS auto-compact threshold; the upstream counts THIS body. When the two
  // disagree the client never trips its brake and the upstream 400s with "prompt is too
  // long" — so the gap must be observable per content class, not guessed at.
  logCtx.promptComposition = summarizeRequestBody(request.body);
  // The brake Codex does not have: enforce the UPSTREAM's own window on the wire body before
  // it goes out. The limit is the smallest of what the provider declares and what the upstream
  // has told us in a previous "prompt is too long" error. Degrading images here is strictly
  // better than letting the upstream kill the whole turn.
  const upstreamLimit = upstreamPromptLimitFor(route, config);
  if (upstreamLimit !== undefined) {
    // The upstream counts the completion against the same window, so reserve room for the
    // output; a compaction request gets its own stricter budget because it carries the whole
    // pre-compaction history.
    const outputReserve = readMaxTokens(request.body);
    const effectiveLimit = effectiveUpstreamPromptLimit(upstreamLimit, {
      compaction: routedCompaction,
      outputReserve,
    });
    const budget = await enforceUpstreamPromptBudget(request.body, effectiveLimit, {
      providerName: route.providerName,
      modelId: route.modelId,
      // The limit is the upstream's number, so the estimate is scaled into the upstream's
      // unit before the two are compared.
      estimateScale: upstreamTokenScaleFactor(route.providerName),
      ...(resolveImageDownsampleEnabled(config, route.providerName, route.modelId)
        ? { imageDownsample: true }
        : {}),
      ...(config.imageDownsampleMaxEdge !== undefined
        ? { downsampleMaxEdge: config.imageDownsampleMaxEdge }
        : {}),
    });
    if (budget.droppedImages > 0 || budget.imageDownsamples.length > 0) {
      request.body = budget.body as string;
      logCtx.promptComposition = summarizeRequestBody(request.body);
      console.warn(
        `[${route.providerName}] upstream prompt budget: dropped ${budget.droppedImages} image(s), `
        + `downscaled ${budget.imageDownsamples.length} image(s); `
        + `estimate ${budget.estimatedTokens} tokens vs limit ${effectiveLimit}`
        + ` (upstream window ${upstreamLimit}, output reserve ${outputReserve}`
        + `${routedCompaction ? `, compaction x${COMPACTION_BUDGET_FACTOR}` : ""})`,
      );
      // Per-image audit of the SHRINKS: what was resized, to what, and what it bought.
      // Downsampling changes what the model sees, so it has to be visible in the log.
      for (const down of budget.imageDownsamples) {
        console.warn(
          `[${route.providerName}] upstream prompt budget: downscaled image #${down.ordinal} `
          + `(${down.tier}, ${down.dimensionsBefore ?? "unknown size"} -> ${down.dimensionsAfter}, `
          + `${down.bytesBefore} -> ${down.bytesAfter} bytes, `
          + `~${down.estimatedTokensBefore} -> ~${down.estimatedTokensAfter} tokens) - ${down.reason}`,
        );
      }
      // Per-image audit: WHICH image went, why, and what we thought it cost. Without this
      // the brake is a black box - the operator sees "dropped 3 images" and cannot tell
      // whether the policy kept the one the user cared about.
      for (const drop of budget.imageDrops) {
        console.warn(
          `[${route.providerName}] upstream prompt budget: dropped image #${drop.ordinal} `
          + `(${drop.tier}, ${drop.dimensions ?? "unknown size"}, duplicate=${drop.duplicate}, `
          + `~${drop.estimatedTokens} tokens via ${drop.estimateMethod}/${drop.estimateConfidence}) - ${drop.reason}`,
        );
      }
    }
  }
  if (typeof request.usageLog?.inputTokens === "number") {
    logCtx.usageLogInputTokens = request.usageLog.inputTokens;
  }
  // The STOP (the brake above is the throttle; this is the brake pedal).
  //
  // Codex's answer to an over-long prompt is to COMPACT and retry. When the compacted history
  // is still over the upstream's ceiling, that loop never ends: request -> 400 -> compact ->
  // request -> 400 ... forever, burning upstream quota the whole way. The upstream's own
  // refusals are the evidence we act on - we do not predict an overflow ourselves (a
  // character estimate is wrong for CJK and JSON, and a wrong "no" kills a good turn).
  //
  // The error we return deliberately does NOT use Codex's `context_length_exceeded` code:
  // that code is the trigger for Codex's auto-compact, and re-triggering it would restart the
  // very loop we are breaking. This one ends the turn with an explanation instead.
  const requestEstimate = logCtx.promptComposition?.estimatedTokens ?? 0;
  const gateLimit = learnedUpstreamPromptLimit(route.providerName, route.modelId);
  const verdict = gateCircuitVerdictFor(
    route.providerName,
    route.modelId,
    requestEstimate,
  );
  if (verdict.refuse) {
    const circuit = gateCircuitState(route.providerName, route.modelId);
    const gateText = gateLimit !== undefined
      ? `上游闸门 ${gateLimit} tokens`
      : "上游未给出闸门数字";
      const message =
        `上游已连续 ${verdict.consecutive} 次拒绝同等大小的请求（${gateText}）。`
        + "为避免无限压缩循环，代理已停止转发该请求：请手动压缩对话或新建会话后重试。";
    console.warn(
      `[${route.providerName}] gate circuit armed after ${verdict.consecutive} comparable refusals; `
      + `refusing locally (estimate ${requestEstimate} vs baseline ${verdict.baselineTokens}, ${gateText})`,
    );
    return new Response(
      JSON.stringify({
        error: { message, type: "invalid_request_error", code: "upstream_context_gate_blocked" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = adapter.fetchResponse
      ? await adapter.fetchResponse(request, { abortSignal: upstream.signal, timeoutMs: connectMs })
      : await fetchWithResetRetry(
          () => fetchWithHeaderTimeout(request.url, {
            method: request.method, headers: request.headers, body: request.body,
          }, upstream.signal, connectMs),
          { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
        );
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the SAME
    // request once per remaining key. OAuth/forward providers and single-key pools return null
    // immediately, so this stays a no-op for them (src/providers/key-failover.ts).
    while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
      const rotated = rotateKeyOn429(config, route.providerName, upstreamResponse.headers.get("retry-after"), Date.now(), route.provider.apiKey);
      if (!rotated) break;
      // Release the failed response's socket before retrying; unread bodies otherwise linger
      // until runtime cleanup (one per rotated key under a rate-limit storm).
      try { void upstreamResponse.body?.cancel(); } catch { /* already consumed/closed */ }
      route.provider = rotated;
      const retryAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, rotated),
        config.cacheRetention,
      );
      const retryRequest = await retryAdapter.buildRequest(parsed, { headers: selectedForwardHeaders });
      // Same body shape as the first attempt; keep the measurement in step with the log.
      logCtx.promptComposition = summarizeRequestBody(retryRequest.body);
      try {
        upstreamResponse = retryAdapter.fetchResponse
          ? await retryAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs })
          : await fetchWithHeaderTimeout(retryRequest.url, {
              method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
            }, upstream.signal, connectMs);
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        const msg = err instanceof Error && err.name === "TimeoutError"
          ? `Provider connect timeout after ${connectMs}ms`
          : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
        return formatErrorResponse(502, "upstream_error", msg);
      }
    }
    // Quota-exhausted recovery ("剩余额度: ¥0.000000", HTTP 403).
    //
    // Two layers, cheapest first: switch to another key in the pool (each key
    // carries its own balance on these relays, so this recovers the turn in
    // about a second), and only when there is no other key, wait and retry.
    // The wait is bounded, and the refusal happens BEFORE the upstream runs the
    // model, so a retry is never billed twice.
    let capturedErrorText: string | null = null;
    const quotaPolicy = resolveQuotaRetryPolicy(route.provider);
    let quotaAttempts = 0;
    let quotaKeySwitches = 0;
    let quotaWaits = 0;
    // Only when the request is STILL failing: the 429 failover above may have
    // recovered it, and reading the body of a successful response would eat it.
    if (quotaPolicy.enabled && !upstreamResponse.ok) {
      while (quotaAttempts < quotaPolicy.maxAttempts) {
        const text: string = capturedErrorText ?? await upstreamResponse.text().catch(() => "");
        capturedErrorText = text;
        if (!isQuotaExhausted(upstreamResponse.status, text)) break;
        const rotated = hasKeyPoolFailover(route.provider)
          ? rotateKeyOnQuota(config, route.providerName, Date.now(), route.provider.apiKey)
          : null;
        if (rotated) {
          quotaKeySwitches += 1;
        } else {
          // No other key to try: wait for the balance to come back.
          quotaWaits += 1;
          const slept = await sleepWithAbort(quotaPolicy.intervalMs, upstream.signal);
          if (!slept) break; // the client left; stop holding the connection
        }
        quotaAttempts += 1;
        // The failed body was already READ (that is how we recognised the
        // exhausted balance), so there is nothing to cancel - and cancelling a
        // locked stream throws.
        if (rotated) route.provider = rotated;
        const retryAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
        const retryRequest = await retryAdapter.buildRequest(parsed, { headers: selectedForwardHeaders });
        logCtx.promptComposition = summarizeRequestBody(retryRequest.body);
        try {
          upstreamResponse = retryAdapter.fetchResponse
            ? await retryAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs })
            : await fetchWithHeaderTimeout(retryRequest.url, {
                method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
              }, upstream.signal, connectMs);
        } catch (err) {
          cleanupUpstreamAbort();
          upstream.abort();
          const msg = err instanceof Error && err.name === "TimeoutError"
            ? `Provider connect timeout after ${connectMs}ms`
            : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
          return formatErrorResponse(502, "upstream_error", msg);
        }
      }
      if (quotaAttempts > 0) {
        logCtx.quotaRetries = quotaAttempts;
        logCtx.quotaKeySwitches = quotaKeySwitches;
        logCtx.quotaWaits = quotaWaits;
        console.warn(
          `[${route.providerName}] upstream balance exhausted: retried ${quotaAttempts} time(s) `
          + `(key switches ${quotaKeySwitches}, waits ${quotaWaits} x ${quotaPolicy.intervalMs}ms)`,
        );
      }
    }
    if (!upstreamResponse.ok) {
      const errorText = capturedErrorText ?? await upstreamResponse.text().catch(() => "unknown error");
      cleanupUpstreamAbort();
      // Record WHAT the upstream said, not just its status code. A JSON error
      // envelope is parsed for its message; an HTML gateway page or a plain-text
      // reset notice is normalized to one readable line. Without this the log
      // shows a bare "502" with no reason and the raw HTML is echoed back to
      // Codex verbatim.
      logCtx.upstreamStatus = upstreamResponse.status;
      logCtx.upstreamContentType = upstreamResponse.headers.get("content-type") ?? undefined;
      captureUpstreamErrorFromText(logCtx, errorText);
      // Record the refusal itself. "The upstream refused us for being too long, but named no
      // ceiling" is a fact worth keeping: it is the difference between "we know the gate" and
      // "we know the request is over some gate we cannot name", and it is what the circuit
      // counts to break a compaction loop.
      const rejection = parseUpstreamRejection(errorText);
      if (rejection.rejected) {
        noteGateRejection(route.providerName, route.modelId, {
          ...(rejection.limit !== undefined ? { limit: rejection.limit } : {}),
          ...(rejection.observedInputTokens !== undefined
            ? { observedInputTokens: rejection.observedInputTokens }
            : {}),
          ...(rejection.rejectedWithoutLimit ? { withoutLimit: true } : {}),
          // OUR estimate of the request that was refused: the circuit compares later
          // requests against it, and only OUR units are comparable.
          estimatedTokens: requestEstimate,
          sample: redactSecretString(errorText.slice(0, 200)),
        });
        saveGateCircuit();
      }
      // Learn the upstream's real context window from its own error, so the NEXT request for
      // this provider can be protected before it goes out. Without this the proxy only learns
      // the ceiling by killing a turn.
      const learnedGate = parseUpstreamPromptGate(errorText);
      if (learnedGate) {
        noteUpstreamPromptLimit(route.providerName, learnedGate.limit, {
          modelId: route.modelId,
          ...(learnedGate.observedInputTokens !== undefined
            ? { observedInputTokens: learnedGate.observedInputTokens }
            : {}),
        });
        // Persist it: learning a ceiling costs an over-long turn, so losing it to a restart
        // would mean paying for it twice. The probe reads this back (that is the number the
        // upstream REALLY enforces, unlike any declaration).
        saveLearnedLimits();
      }
      // The refusal also names the SIZE the upstream was asked to handle. That is a free
      // calibration point: it says how many tokens the upstream counted for a body whose
      // size WE estimated, and the ratio between the two is what our brake needs to speak
      // the upstream's unit. Learning it here means the NEXT request for this provider is
      // braked at the upstream's ceiling instead of being sent into the same wall.
      const observedUpstreamTokens = learnedGate?.observedInputTokens ?? rejection.observedInputTokens;
      if (observedUpstreamTokens !== undefined && requestEstimate > 0) {
        // Record the gap on the request itself: the upstream's own count for the exact body
        // we sent, next to our estimate of it. This is what turns "the prompt was too long"
        // into a number an operator can act on.
        logCtx.upstreamTokenGap = {
          upstreamTokens: observedUpstreamTokens,
          estimatedTokens: requestEstimate,
          factor: observedUpstreamTokens / requestEstimate,
        };
      }
      const learnedScale = noteUpstreamTokenScale(
        route.providerName,
        observedUpstreamTokens,
        requestEstimate,
      );
      if (learnedScale) {
        saveLearnedScales();
        console.warn(
          `[${route.providerName}] learned token scale x${learnedScale.factor.toFixed(2)}: `
          + `upstream counted ${learnedScale.observedInputTokens} tokens for a body we estimated `
          + `at ${learnedScale.estimatedTokens}. The brake now compares in the upstream's unit.`,
        );
      }
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      //
      // A non-JSON body (nginx/ALB HTML page, plain-text reset notice) is
      // normalized to one readable line instead of being echoed verbatim: raw
      // HTML in a Codex error bubble is unreadable and can carry an internal
      // hostname. A JSON body keeps its own message, because that is the part
      // with the gate/limit/token detail the user actually needs.
      const upstreamMessage = parseUpstreamRejection(errorText).rejected
        ? errorText
        : summarizeUpstreamErrorBody(errorText, upstreamResponse.status, upstreamResponse.headers.get("content-type")).summary;
      // A content-policy refusal arrives as HTTP 500 from some upstreams, but it
      // is a verdict on the CONTENT, not a transient server fault. Reporting it
      // as 500 makes Codex retry the same turn five times and then blame "high
      // demand". Downgrade it to 400 so the turn fails once, with the reason
      // the upstream actually gave.
      const policyText = logCtx.upstreamError ?? upstreamMessage;
      if (upstreamResponse.status >= 500 && isContentPolicyRejection(policyText)) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `上游内容审核拒绝（content policy rejection），本轮请求内容被上游策略拦截，重试无效。原始信息: ${redactSecretString(String(policyText).slice(0, 300))}`,
        );
      }
      // The balance is still empty after our recovery attempts. Report it as
      // what it is -- an exhausted balance, not a broken key -- and keep the
      // status at 4xx so Codex treats it as fatal instead of retrying into
      // the same wall.
      if (isQuotaExhausted(upstreamResponse.status, errorText)) {
        const waited = quotaWaits > 0 ? `，等待 ${quotaWaits} 次 x ${quotaPolicy.intervalMs}ms` : "";
        return formatErrorResponse(
          403,
          "insufficient_quota",
          `上游额度不足（insufficient_quota）：已重试 ${quotaAttempts} 次（换 key ${quotaKeySwitches} 次${waited}），`
          + `余额仍未恢复。原始信息: ${redactSecretString(upstreamMessage.slice(0, 300))}`,
        );
      }
      return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${redactSecretString(upstreamMessage.slice(0, 500))}`);
    }
  }

  // The upstream took this one. It only clears the streak when the request that got
  // through was of a comparable size - a small success belongs to another conversation.
  noteGateSuccess(route.providerName, route.modelId, requestEstimate);

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(routedCompaction ? { compaction: true } : {}),
        // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
        // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
        // giant stale chain Codex just replaced.
        ...(routedCompaction ? {} : { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, parsed._cursorConversationId) }),
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse(upstreamResponse);
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) rememberResponseState(parsed._rawBody, json, parsed._cursorConversationId);
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Remote compaction v1 (`POST /v1/responses/compact`). Codex uses this whenever the provider
 * "is openai" and Feature::RemoteCompactionV2 is OFF (the default) — under Design B that is the
 * proxy. The response is a unary `{"output":[ResponseItem...]}` that codex installs as the
 * REPLACEMENT history (compact_remote.rs). Passthrough forwards to the real ChatGPT backend;
 * routed models run the same summarizer used for v2 and convert the summary to v1 history items.
 */
export async function handleResponsesCompact(req: Request, config: OcxConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses-compact");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Invalid compaction request body");
  }
  const raw = body as { model?: unknown; input?: unknown };
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "compaction request requires a model");
  }

  let route;
  try {
    route = routeModel(config, raw.model);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  if (route.provider.adapter === "openai-responses") {
    // Native ChatGPT/OpenAI model: forward the compact request verbatim to the real backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    const headers = new Headers({ "content-type": "application/json" });
    try {
      const authCtx = await resolveCodexAuthContext(req.headers, config);
      const selected = headersForCodexAuthContext(req.headers, authCtx);
      compactProvider = applyCodexAuthContextToProvider(route.provider, authCtx);
      for (const name of FORWARD_HEADERS) {
        const value = selected.get(name);
        if (value) headers.set(name, value);
      }
      const override = (compactProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
      if (override) {
        headers.set("authorization", `Bearer ${override.accessToken}`);
        headers.set("chatgpt-account-id", override.chatgptAccountId);
      }
    } catch {
      // Auth-context failures degrade to raw forwarded headers (pre-existing behavior) rather
      // than failing the compact turn outright — codex-rs treats compact errors as session-fatal.
      for (const name of FORWARD_HEADERS) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    const base = (compactProvider.baseUrl ?? "").replace(/\/$/, "");
    if (compactProvider.apiKey) headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    const upstream = await fetch(`${base}/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...raw, model: route.modelId }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting ocx1 envelope into plain v1 replacement-history items.
  const inputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  const internalBody = {
    ...raw,
    stream: false,
    input: [...inputItems, { type: "compaction_trigger" }],
  };
  const internalHeaders = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) internalHeaders.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify(internalBody),
  });
  const logCtx: RequestLogContext = { model: route.modelId, provider: route.providerName };
  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal });
  if (!response.ok) return response;
  let json: { output?: unknown[] };
  try {
    json = await response.json() as { output?: unknown[] };
  } catch {
    return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
  }
  const compactionItem = (json.output ?? []).find(
    (item): item is { type: string; encrypted_content?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
  );
  const summary = compactionItem?.encrypted_content
    ? decodeCompactionSummary(compactionItem.encrypted_content) ?? ""
    : "";
  const output = buildCompactV1Output(extractCompactUserMessages(inputItems), summary);
  return new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
}

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
}

/** Host-only label for retry logs — never leaks path/query/credentials. */
export function safeHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

export async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}
