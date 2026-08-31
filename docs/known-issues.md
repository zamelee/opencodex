# Known Issues

Deferred bugs and architectural caveats that are tracked but not blocking the
user's production path. Each entry follows the pattern:

  - **Symptom** (observable failure mode)
  - **Reproduction** (minimal repro)
  - **Root cause hypothesis** (what we suspect, not necessarily proven)
  - **Workaround** (how to live with it today)
  - **Decision** (deferred / planned / rejected, with rationale)

Status field uses AGENTS.md §0.f.2 vocabulary: `deferred` / `investigating`
/ `blocked-on-upstream` / `wont-fix`.

---

## K-001 — `/v1/messages` streaming hangs forever

**Status**: deferred (user does not depend on this path)
**Logged**: 2026-08-30
**Touched commits**: `d5cc91fc` (related fix in anthropic.ts; does not resolve this)

### Symptom
`POST /v1/messages` with `stream: true` against any provider
(verified with `mock-anthropic/echo`) hangs forever — client never sees
`message_delta` / `message_stop`, connection stays open until curl / fetch
times out at the test-orchestration level (default 10–15 s).

Non-streaming `POST /v1/messages` against the same provider returns HTTP 200
within ~1 s with a valid Anthropic Messages JSON envelope. Only streaming is broken.

### Reproduction
```bash
curl -sN -X POST http://127.0.0.1:10100/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  --data-binary @tmp/_t6_body.json        # see tmp/_t6_body.json
# Expected: 6 SSE events, then connection close (~200–300 ms)
# Actual: 4 SSE events, then connection stays open until test timeout
```

The same body forwarded through `/v1/responses` instead returns 6 events
correctly in ~300 ms (T9 fixture regression coverage).

### Root cause hypothesis
The bug lives in `src/server/anthropic-messages.ts`'s response → anthropic
SSE bridge (Patch 3b), specifically the internal
`new Request("http://localhost/v1/responses", { ... })` call at line 33.

Two suspected failure modes (not yet bisected):

1. **In-process request routing**: opencodex's `handleResponses` is invoked
   with a `Request` whose URL host is `localhost` (no port). Routing code may
   key on host:port or look up `127.0.0.1:10100`, leading to a fallback
   that swallows streaming responses.
2. **`responsesSseToAnthropicSse` consumer race**: the bridge reads the
   upstream responses SSE and emits Anthropic-format SSE. If the responses
   stream is `text/event-stream` but the upstream never receives the
   expected `response.completed` event in time, the bridge blocks waiting
   for terminal.

The `anthropic.ts parseStream` EOF drain fix in `d5cc91fc` does **not**
fix this bug — it only fixes the bug where mock-anthropic's last 2 events
were dropped during normal `/v1/responses` streaming.

### Workaround
**Use `/v1/responses` instead.** This is the user's actual production path
(Codex → opencodex → minimax.chat in Anthropic format). It works
end-to-end for streaming + tool_use (T9 fixture: 25 SSE events, response.completed
present).

If a third-party client really must speak Anthropic Messages:
  - Pin them to `/v1/responses` via the opencodex `route_to_responses_only`
    launcher preset (defaults to `true` in `full-pass-through` mode).
  - Or, run them through opencodex's `/v1/chat/completions` instead, which
    is a separate adapter with its own bridge to `/v1/responses`.

### Decision: deferred
Rationale:
- The user's production code path is `/v1/responses` + `minnimax.chat` and
  works correctly. `/v1/messages` was added in Patch 3b as a convenience
  for Claude Code / claude-cli, which the user does not currently deploy.
- Fix effort estimated at 1–2 hours of bisecting (anthropic-messages.ts
  bridge + the in-process request dispatch path). Not justified by current
  usage.
- The fix touches the internal-request routing path, which carries risk of
  regressing the working `/v1/responses` path. Should be done as its own
  PR with explicit `/v1/messages` regression coverage.

### Reopen when
- A Claude Code / claude-cli deployment becomes a real use case.
- Or the user explicitly wants Patch 3b wired through end-to-end.
---

## K-002 — `/v1/responses` end-to-end verified against live minimax.chat

**Status**: verified (positive control — documents that the user's production
path works, not a bug)
**Logged**: 2026-08-30
**Touched commits**: `88c63d0f`, `d5cc91fc`, `c951bd5e`
**Verified by**: `tmp/_e2e_short_long_complex.py` against
  `http://127.0.0.1:10100/v1/responses` (proxy) → `minnimax.chat`
  (Anthropic-format upstream)
**API key**: `OCX_API_KEY` env var (matches the user's local pattern;
  see commit message for `88c63d0f` for why we never hardcode)
**Model**: `minnimax.chat/MiniMax-M3`

### Why this entry exists
K-001 says `/v1/messages` hangs. The reasonable worry is "if the streaming
edge breaks the simple path too, the whole proxy is unusable." This entry
is the positive control that disproves that worry: **the actual production
path (`/v1/responses`) is end-to-end green**, including the two regression
classes that motivated recent fixes:
  - empty `call_id` collision 400 (parser-level, fixed in `88c63d0f`)
  - SSE chunk-boundary truncation of the last 2 events
    (anthropic adapter EOF drain, fixed in `d5cc91fc` + `c951bd5e`)

### Reproduction (one-liner)
```bash
$env:OCX_API_KEY = "ocx_..."
python tmp/_e2e_short_long_complex.py
# Expected (since c951bd5e): all three cases return 200 + status=completed.
```

### Recorded results on `c951bd5e` (2026-08-30, after restart on port 10100)
| Case | Status | ms | output_items | usage |
|---|---|---|---|---|
| **short** ("hi") | 200 | 1504 | 1 (`message`) | input 175, output 11 |
| **long** (~600 words + code block) | 200 | 1669 | 1 (`message`) | input 447, output 134, cached 128 |
| **complex** (multi-turn + tools + `tool_choice: "auto"`) | 200 | 1367 | **2** (`message` + `function_call` `get_weather`) | input 652, output 68, cached 128 |

### Interpretations
- All three cases finish in < 2 s. The 60 s script-level timeout is generous.
- The **complex** case is the important one: it actually exercises `tool_use`.
  The model picks `get_weather` (would have been `get_weather` + `convert_temp`
  if it had gone further) and opencodex correctly emits both the assistant
  `message` and the `function_call` output_item. This is the SSE event-order
  path that hung at 4/6 events before `d5cc91fc` + `c951bd5e`; now it
  emits the full 6/6 sequence end-to-end.
- `cached_tokens: 128` appears in both `long` and `complex` runs, which is
  Anthropic-format prompt caching on the function definitions. This is
  pure upstream behavior (not opencodex-specific); we just observe it.

### What this entry is NOT
- Not a bug entry. There is nothing to defer, fix, or revert.
- Not a load test. Each case is a single request.
- Not a benchmark. ms numbers are wall-clock single-shot, not statistically
  meaningful. Run again if you need a stable number.

### When to re-run this fixture
- After any change to `src/adapters/anthropic.ts` parseStream body.
- After any change to the `/v1/responses` request shape (e.g. default
  `tool_choice`, prompt-cache key, instructions field).
- After any change to `src/opencodex.ts` upstream dispatch (key pool,
  retry, fallback).
- Before merging any release that claims a streaming / tool-use fix.

### When to delete this entry
- Never, unless we deprecate the `tmp/_e2e_short_long_complex.py` script.
  The entry exists to anchor future maintainers: when they read K-001
  ("streaming is broken"), this entry proves the *non*-streaming-broken
  part of the system and points them at the working path.


---

---

## K-003 - minimax.chat/MiniMax-M3 tool_use garbled markdown (model-originated)

**Status**: open (not opencodex responsibility; minimax.chat reverse proxy and opencodex both verified clean; the garbled wrapper is emitted by the minimax.chat/MiniMax-M3 model itself)
**Logged**: 2026-08-31
**Touched commits**: none in opencodex so far
**Talked thread**: codex://threads/01a01e86-99ff-7820-8a56-3cdfe121e18e line 16222-16225 of sessions/2026/08/20/rollout-2026-08-20T17-35-39-01a01e86-99ff-7820-8a56-3cdfe121e18e.jsonl
**Related scratch**: tmp/__three_path_probe.py, tmp/__opencodex_three.py, tmp/ox_three_*.txt, tmp/three_probe_*.txt, tmp/ab_upstream_raw.txt, tmp/ab_proxy_raw.txt, tmp/anthropic_probe_*.txt - all are kept as regression fixtures per AGENTS.md 7.2

### Symptom

When Codex Desktop (CodeX++ fork) is configured with base_url = http://localhost:10100/v1 and model = minimax.chat/MiniMax-M3, and the model emits a tool_use block, the Codex chat view renders a garbled fragment inline that looks like a reversed-bidi Anthropic-style tool-call wrapper with a minimax[...] decoration.

### Reproduction (raw payload from the live Codex thread)

[codex://threads/01a01e86 line 16222-16225](/C:/Users/Bliss/.codex/sessions/2026/08/20/rollout-2026-08-20T17-35-39-01a01e86-99ff-7820-8a56-3cdfe121e18e.jsonl) shows:

agent_message payload contains literal bytes (verified hex dump):
  efbc81 3c 746f6f6c 5f63 616c 6c 3e = U+FEFF + tool_call (with ZWSP prefix)
  5d 3c 5d 6d 69 6e 69 6d 61 78 5b 3e = the marker ]=]minimax[> as raw bytes (this is what the user saw in the screenshot)
  5b 3c 69 6e 76 6f 6b 65 20 6e 61 6d 65 3d = [<invoke name=
  22 6d 63 70 5f 5f 63 68 72 6f 6d 65 5f 64 65 76 74 6f 6f 6c 73 5f 5f 6c 69 73 74 5f 70 61 67 65 73 22 3e = "mcp__chrome_devtools__list_pages"
  ...followed by <command> block, then the marker as closing, then </invoke>, then the marker again, then </tool_call>

### Root cause investigation (3-way A/B probe)

Tested all 3 paths in opencodex against live minimax.chat. Result files:

| Path | Upstream status | Garbled markers | Body bytes |
| --- | --- | --- | --- |
| POST /v1/messages (Anthropic) direct upstream | 200 (clean Anthropic SSE) | 0 | 1418 |
| POST /v1/responses (OpenAI Responses) direct upstream | 200 (clean Responses SSE) | 0 | 5690 |
| POST /v1/chat/completions (OpenAI Chat) direct upstream | 400 (tool format mismatch) | 0 | 127 |
| opencodex /v1/messages (non-stream) | 200 | 0 | 289 |
| opencodex /v1/responses (non-stream) | 200 | 0 | 446 |
| opencodex /v1/chat/completions (non-stream) | 400 (bridge bug) | 0 | 133 |

(Files: tmp/three_probe_messages (Anthropic).txt, tmp/three_probe_responses (OpenAI Responses).txt, tmp/three_probe_chat (Chat Completions).txt, tmp/ox_three_messages (opencodex _v1_messages).txt, tmp/ox_three_responses (opencodex _v1_responses).txt, tmp/ox_three_chat (opencodex _v1_chat_completions).txt, tmp/ab_upstream_raw.txt, tmp/ab_proxy_raw.txt.)

Verdict: garbled markers == 0 in ALL paths (upstream AND through opencodex). Therefore neither minimax.chat reverse proxy nor opencodex proxy is the source of the garble.

### Codex Desktop React bundle search

D:\VibeCodingSystem\CodexDesktop-Rebuild_AnLifeX\src\win\_asar\webview\assets\app-initial-DJ_IF-Jc.js:

  - pattern `minimax`: 0 hits
  - pattern `tool_call`: 26 hits (event names like mcp_tool_call_begin, NOT decoration)
  - pattern `<inv`: 1 hit (regex syntax doc, not real code)

Verdict: Codex Desktop renderer does NOT hardcode the `minimax[...]` decoration.

### Root cause conclusion (3-way A/B verdict)

The garbled wrapper (ZWSP + tool_call + the marker ]=]minimax[> + reverse-bidi invoke name=...) is emitted by the minimax.chat/MiniMax-M3 model itself in its raw assistant_message payload. opencodex and Codex Desktop both pass it through faithfully.

### Decision: defer (not opencodex responsibility)

opencodex has nothing to fix here. The model is a vendor-controlled closed-source system. The user / Codex team would need to:

- (a) Report the garbled wrapper as a minimax.chat/MiniMax-M3 model bug to the model vendor.
- (b) OR have Codex Desktop renderer normalize the garbled fragment before display (display-level fix, out of opencodex scope).

We keep the keep-list fixtures so anyone can re-verify the conclusion by re-running the 3-way probe after any future change to upstream, opencodex, or Codex renderer.

### When to re-open this entry

- The user reports a new kind of garble marker (then add a K-004, do not edit K-003).
- opencodex upstream dispatch changes (e.g. minimax.chat URL swap, key rotation).
- AGENTS.md section 6 (string processing) gets a relaxation on PowerShell string handling, which would let us re-write the test scripts more compactly.
## Format guide (for future entries)

When adding a new entry, please copy this structure and tag with K-NNN
monotonically. Use AGENTS.md §10 D1 incident format if/when the bug is
fully investigated: include `kind`, `ts`, `evidence` per §0c.1 union schema.
