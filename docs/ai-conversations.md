# AI Conversations Archive

Per-project record of significant AI conversations that influenced opencodex
design decisions or bug investigations. Schema loosely follows AGENTS.md §0c.1
(`<project>/docs/ai-conversations.md` per-project).

---

## 2026-08-30 — Anthropic SDK + OpenAI SDK architecture decision + tool_use EOF drain bug

**Project**: opencodex (Bun + TypeScript LLM protocol proxy)
**Platform**: github.com/copilot (claude-haiku-4.5; better answers expected from Sonnet/Opus)
**URL**: https://github.com/copilot/c/8effa1cb-b1c4-40cf-ab3c-253c131f45b9
**Topic**: Three-protocol interconversion library candidates + production bug investigation
**LastUpdated**: 2026-08-30

### Turn 1 (original, by user before this session)

Q (zh): Lightweight AI API proxy (Bun + TS, ~10k LoC, zamelee/opencodex). Three wire protocols:
OpenAI Responses API (Codex client), Anthropic Messages (minimax.chat reverse proxy),
OpenAI Chat Completions. Hard constraints: production-grade, lightweight, Apache2.0/MIT/BSD,
TypeScript-first. Recommend up to 3 candidates with GitHub URL / latest release / recent commit /
protocol coverage / known issues / license.

A (Copilot, claude-haiku-4.5):

1. **LiteLLM** (`BerriAI/litellm`, MIT, v1.45.0+, weekly releases). Coverage: ALL 3 protocols.
   Pros: most comprehensive, production-used by Mint/Linear, handles exact streaming blocks
   we mentioned. Cons: heavy, primarily Python, TypeScript wrapper is thin.

2. **Anthropic SDK JS** (`anthropic-anthropics/anthropic-sdk-js`, Apache 2.0). Coverage:
   Anthropic Messages + OpenAI Chat Completions; ⚠️ OpenAI Responses API indirect.
   Pros: pure TS, lightweight, embedding-friendly, excellent streaming primitives.
   Cons: Responses API needs custom mapping layer (~30-40% custom work).

3. **OpenAI Node SDK** (`openai/openai-node`, Apache 2.0). Coverage: OpenAI Chat Completions
   + Responses API; ⚠️ Anthropic needs manual conversion. Pros: official, Responses first-class.
   Cons: ~50-60% custom work for Anthropic.

**Recommendation**: Start with Anthropic SDK + OpenAI SDK side-by-side + ~200 LoC Router.
Reach for LiteLLM only if adapter exceeds 500 LoC or hits streaming state machine edge cases.

**Outcome**: User chose path #2 (Anthropic SDK + OpenAI SDK + ~200 LoC Router). Built opencodex.
Got stuck on two production bugs. Re-opened the conversation.

---

### Turn 2 (this session — MCP-injected via chrome-devtools-mcp `fill_safe`)

**Inject path**: `mcp__chrome-devtools__fill_safe` (react-controlled-vendor trigger) + Enter.
Earlier attempts with plain `fill` set `.value` but React's controlled-component state
stayed out of sync, so Enter saw an empty React state and silently dropped the message.
`fill_safe` switches to CDP `Input.insertText` which fires a real `input` event with
`inputType=insertText`, triggering React 18's onChange handler.

Q (zh, ~1700 chars): Two production bugs in zamelee/opencodex. Need concrete owner/repo +
file path + function name + line number. Don't hallucinate — say "out of training data"
if uncertain.

**(1) empty call_id collision 400**: Codex Responses API emits function_call /
function_call_output with empty call_id, opencodex forwards empty string to Anthropic
tool_use.id, multiple empty ids collide upstream → minimax.chat returns HTTP 400
"Provider error 400: invalid params, duplicate tool_call id:  (2013)". Our fix:
parser-level `ensureToolCallId(raw, peerId?)` generating `toolu_orphan_<uuid12>` +
per-request `pendingEmptyCallId` slot so call + output share ID. 3 unit tests + e2e
fixture on minimax.chat both pass (HTTP 200).

**(2) Anthropic streaming chunk boundary**: mock uses Bun.serve + ReadableStream +
setInterval(25ms) emitting 6 SSE events: message_start → content_block_start →
content_block_delta → content_block_stop → message_delta → message_stop.
curl direct against mock: 6 events arrive. opencodex to Codex client: only 4 events,
message_delta + message_stop never arrive, connection hangs. We already found and
fixed a double-decode bug in anthropic.ts parseStream (value was being decoder.decode'd
twice), but the last 2 events are still missing. Suspected: anthropic-messages.ts
internal Request("http://localhost/v1/responses") bridge, or setInterval + controller.close
race in Bun runtime.

Plus 4 reference projects we wanted: LiteLLM internals (priority), anthropic-sdk-js,
openai-node, others (Portkey / Cloudflare AI Gateway / Bifrost / sst/opencode).

A (Copilot, claude-haiku-4.5, after ~3 min of "查代码"):

Copilot acknowledged it hit training-data cutoff on anthropic-sdk-js and openai-node
(repos "not in my searchable index"). Pivoted to LiteLLM as "the most comprehensive
production reference you have."

**LiteLLM citations** (claimed):

| File | Function | Lines |
|---|---|---|
| `litellm/llms/anthropic/experimental_pass_through/responses_adapters/streaming_iterator.py` | `_process_event()` | 191-286 |
| `litellm/llms/anthropic/experimental_pass_through/adapters/streaming_iterator.py` | `__next__()` state machine | 646-728 (template at 706-714) |
| `litellm/llms/anthropic/experimental_pass_through/messages/streaming_iterator.py` | `_decoded_sse_data_line`, `parse_anthropic_error_event` | 77-157 |
| `litellm/llms/bedrock/chat/invoke_handler.py` | `check_empty_tool_call_args()` | 289 |

Copilot's conclusions:
- LiteLLM has production implementation but **doesn't defend against empty tool_call_id**
  (because they mostly run Chat Completions, where OpenAI side manages ID).
- For SSE bug: the critical invariant is `content_block_stop → message_delta → message_stop`.
  Our double-decode fix wasn't enough — we also need **EOF drain logic** that flushes a
  held message_delta AFTER content_block_stop is queued, plus a final message_stop
  append if upstream didn't emit one.
- LiteLLM fix template (their line 706-714): `try ... except StopAsyncIteration: pass`
  + drain queue + final raise StopAsyncIteration.

---

### Verification of Copilot's citations (post-hoc)

I fetched each file from GitHub raw and grep'd for the cited patterns:

| File | Cited function/lines | Actual location |
|---|---|---|
| `responses_adapters/streaming_iterator.py:191-286` `_process_event()` | L191-286 | **L84** — function body around L84-130 (hundreds of lines off) |
| `adapters/streaming_iterator.py:646-728` `__next__()` | L646-728 | **L228** — `__next__` method at L228; L696 has the `message_stop` append ✓ |
| `messages/streaming_iterator.py:77-157` `_decoded_sse_data_line` | L77-157 | **L73** (close) — function at L73-107 |
| `bedrock/chat/invoke_handler.py:289` `check_empty_tool_call_args()` | L289 | **L336** (47 lines off) |

**Verdict** — per AGENTS.md §0e.1 "主向导幻觉" warning confirmed:
- ✅ All 4 file paths exist in LiteLLM
- ✅ All function names exist
- ❌ All 4 line ranges are off (delta 4-47 lines)
- ✅ The state machine / EOF drain pattern description is correct in spirit
- ⚠️ Code templates from Copilot are direction-correct but not byte-accurate; need
  verification against actual LiteLLM source before vendor-importing

This is why AGENTS.md §0e.1 says "强制进入下一步直查" — Copilot / ChatGPT / Gemini can
hallucinate line numbers convincingly even when file paths and function names are correct.

---

### Our implementation (based on verified LiteLLM source)

After reading the actual LiteLLM `adapters/streaming_iterator.py:706-720` EOF drain pattern,
implemented in `src/adapters/anthropic.ts`:

1. **Reset `tailEventType` after each event in EOF drain** (`tailEventType = ""`)
   — fixes the latent bug where one event's header leaked to the next.
2. **Hold `message_delta` chunk** in a separate slot until `content_block_stop` is queued
   — preserves the Anthropic SSE ordering invariant
   `content_block_stop → message_delta → message_stop` even when upstream delivers these
   in reverse due to Bun close race.
3. **Same dispatch logic in drain as main loop** — message_delta case updates
   `pendingUsage`, message_stop emits `done`, content_block_stop flushes held delta.
4. **Defensive fallback** — if upstream never emits message_stop (close race),
   `ensureMessageStop()` appends a terminal `done` so downstream never hangs.

**Verified end-to-end** against `mock-anthropic/echo` + Bun.serve + ReadableStream:
6 events arrive in correct order, proxy forwards all 6 chunks to /v1/responses client.

---

### Out of scope (separate issue, tracked separately)

**`/v1/messages` bridge** still hangs for streaming. This is `src/server/anthropic-messages.ts`'s
response→anthropic SSE bridge (Patch 3b). The user's actual production path is
`/v1/responses` + `minimax.chat`, which works. `/v1/messages` is the edge path used by
Claude Code / claude-cli, which the user does not currently depend on.

Recommended: log this as a known-issues.md item, fix in a separate PR if/when needed.

---

### Resulting commits

- `88c63d0f` `fix(parser): generate non-empty ids for empty call_id` (pushed earlier this session)
- `d5cc91fc` `fix(anthropic-streaming): EOF drain in correct SSE order + tailEventType reset`

Both on `origin/main`.

---

### Markdown drafts sent to Copilot

Long version (3547 chars, 67 newlines): `tmp/_t6_copilot_followup.md`
Short version (1698 chars, 24 newlines): `tmp/_t6_copilot_short.md`

Both retained for future reference / re-sending in different context.
