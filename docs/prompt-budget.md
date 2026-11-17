# Prompt budget: why a turn dies with "prompt is too long", and the knobs that stop it

## The failure this documents

2026-11-06, thread `01a18ae2-...`, upstream `m.aiio.chat` (a new-api aggregator in front of
MiniMax-M3.1-Flash-Preview):

```
Provider error 400: {"error":{"type":"prompt_too_long","message":
  "{\"code\":11115,\"msg\":\"prompt is too long: 2225110 tokens > 1048576 maximum\", ...}"}}
```

Codex believed the same prompt was ~350k tokens, so its auto-compact brake never fired and the
turn simply died.

## Why the two sides disagree

| | how it counts | result |
|---|---|---|
| Codex (`codex-rs`) | its own tokenizer; `reasoning.encrypted_content` -> `len*3/4-650`, everything else -> serialized bytes / 4 | images count as ~**0** tokens |
| upstream | its own tokenizer on the body **we** put on the wire | a native image block is billed as **vision** (`w*h/750`), the same base64 inside a **text** block is billed as **text** (~1.4 chars/token) |

Measured on that upstream (2026-11-07):

- native image block, 1024x1024 noise PNG (39,520 base64 chars) -> `input_tokens = 1,459`
- the same base64 as plain text -> `input_tokens = 15,119`
- the failing turn's own wire body (321,815 text chars + 6 screenshots as native image blocks) -> `input_tokens = 226,877` (that one passed)
- the failing number reconciles only if those 2,723,764 base64 chars were billed as **text**: `321,815/1.42 + 2,723,764/1.36 ~= 2,225,110`

Our estimator is calibrated against the upstream's own number: the same body estimates at
226,349 (**-0.233%**).

## The knobs

| knob | where | default | effect |
|---|---|---|---|
| `providers.<name>.supportsSearchTool` | provider config / Providers page -> *Enable hosted web search* | **off** | when off, Codex does not attach `web_search` to this provider's requests, so the turn does not go through the web-search sidecar (one extra model call) and the search results are not appended back into the conversation |
| `providers.<name>.contextWindow` | provider config | model metadata | the window Codex believes; declare it **below** the upstream's real ceiling so the client compacts before the upstream would reject a request |
| learned upstream ceiling | learned at runtime from the upstream's `prompt is too long: N > M maximum` | - | the proxy's own brake uses this number (the real ceiling), not the conservative declared one |
| image degradation | automatic | - | when the outgoing body is over the upstream's budget, unusable images are dropped first, then images are given up **by value** (duplicates first, then early history, biggest first; the current turn's images survive longest) |
| image downsampling | `imageDownsample` / `providerImageDownsample` / `modelImageDownsample` | **off** | when the brake fires and downsampling is enabled, oversized images are genuinely **resized** (sharp) instead of dropped - the model still sees the picture, just a smaller one |

## Side effects to know about

1. **Turning `supportsSearchTool` off removes web search for that provider's models.** It is the
   default from 2.7.21 on. To keep the old behaviour for one provider, add this to the provider
   config:
   ```json
   "providers": { "m.aiio.chat": { "supportsSearchTool": true } }
   ```
   or flip the switch in the Providers page.
2. **A lower declared window makes Codex compact earlier** - that is the point, but it also means
   more compactions (shorter conversations, an occasional "summarized too early" feeling) and a
   slower first turn after each compaction.
3. **The image brake gives something up when it fires.** With downsampling off, images are
   dropped - by value, not by age: a repeated payload goes first (it carries no new
   information), then early history, biggest first. The CURRENT turn's images are never
   dropped unless nothing else is left. With downsampling ON, an oversized image is first
   scaled down to the provider family's standard edge (Anthropic 1568px, OpenAI 2048px) and
   only dropped if it still does not fit. Every drop and every resize is logged per image
   (`upstream prompt budget: dropped image #N ... / downscaled image #N ...`).
4. **The brake only protects the prompt.** If the conversation *text* alone is over the window,
   dropping images cannot help - only compaction can. The proxy logs the estimate either way.
5. **The learned ceiling is per provider and lives in memory**, so it resets on restart; until
   the upstream rejects one request, the proxy falls back to the declared window (conservative).
6. **The compaction request is treated separately**: it carries the pre-compaction history, so it
   gets 85% of the window plus an output reserve. This is the request shape that actually died.
7. **Downsampling changes what the upstream sees.** It is off by default precisely because a
   downscaled screenshot is a smaller screenshot: a model that had to read fine print may
   read it wrong. Turn it on per provider or per model when the provider bills by pixel and
   the pictures are decorative.

## The downsampling switch

Three levels, same shape as the context-cap settings, resolved in this order:
model -> provider -> global.

```json
{
  "imageDownsample": false,
  "providerImageDownsample": { "m.aiio.chat": true },
  "modelImageDownsample": { "m.aiio.chat/MiniMax-M3.1-Flash-Preview": false }
}
```

In the GUI (Models page) this is the **图片降采样** switch next to each provider's cap switch,
plus a per-model dropdown (跟随 Provider / 开 / 关). `imageDownsampleMaxEdge` (256..8192) pins
the target long edge instead of deriving it from the provider family.

## Reading the upstream's refusal (2026-11-16)

The upstream that refused us (m.aiio.chat) is a Go service. `json.Marshal` escapes ">" as the
six characters `\u003e`, and the inner error object is then embedded in the outer envelope as a
STRING, which escapes that backslash a second time. The body on the wire therefore carried
`\\u003e`:

```json
{"error":{"type":"prompt_too_long","message":"{\"code\":11115,\"msg\":\"prompt is too long: 5010629 tokens \\u003e 1048576 maximum\"}"}}
```

The old parser read the RAW body with a regex after one unescape pass, which left a stray
backslash in front of ">" and made the pattern miss. The ASCII phrase "prompt is too long"
survived the escaping, so the proxy knew the request was refused for being too long but never
learned the ceiling: six refusals, six "rejected without limit", no learned gate, no learned
token scale - and the 5M-token body kept going upstream.

Now the body is UNWRAPPED first, with bounds (4 JSON layers, 64 KB body, 256 strings, 64 KB of
collected text), and the numbers are read from the decoded text. One reading feeds every
decision: the gate that gets learned, the refusal the circuit counts, the message the client
sees.

The reading also names a FAMILY, which is what the request log now carries
(`upstreamErrorFamily`):

| family | what it means | what the proxy may do with it |
|---|---|---|
| `prompt_too_long` | the upstream named a size refusal | learn the ceiling, learn the scale, brake |
| `context_length_exceeded` | the same, worded differently | learn the ceiling, brake |
| `quota_exhausted` | balance / plan / permission refusal | stop retrying, do NOT learn a ceiling |
| `content_policy` | the content was refused | report it, do NOT retry it |
| `auth` | credential problem | report it, do NOT touch the key pool |
| `unknown` | we could not read it | record it and fall back to the brake |

`prompt_too_long` and `context_length_exceeded` are kept apart on purpose: the wording differs
and they are not proven to behave identically. A structured `type` that disagrees with the
message text is recorded as a conflict rather than silently resolved.

## The optional LLM assist (off by default)

Some refusals are worded in ways no rule set anticipates. For those - and ONLY those - an
operator can let a small model name the family:

```json
{
  "upstreamErrorLlmAssist": {
    "enabled": true,
    "provider": "NAS",
    "model": "sn-sensenova-6-8-flash-lite",
    "timeoutMs": 5000
  }
}
```

`provider` takes `baseUrl` and `apiKey` from that provider in `config.json`; `baseUrl` / `apiKey`
can also be given directly. The model is called through the anthropic-style `/v1/messages`.

What the assist is allowed to do, and what it is not:

- It may only fill a family our own reader could NOT name. A family we already read is never
  second-guessed, and the model is not even called.
- It NEVER supplies a number. Token counts and ceilings come from the deterministic reader. If
  the model volunteers a number that disagrees with the one we already know, its whole answer
  is discarded.
- It never writes a learned limit or a learned token scale.
- It never blocks the request: a timeout, a 429, an unreadable answer or a disagreement all end
  with the deterministic reading standing.
- The request log records `upstreamErrorFamilySource: "llm"` so a family that came from the
  model is never mistaken for one we read ourselves.

Measured on `Qwen/Qwen3.5-4B` (2026-11-16): the family was right 10/10 on the incident body, the
observed size 9/10, the provider code 5/10, and the provider type was invented. That is exactly
why only the family is taken from it.

## What was NOT changed

- Codex itself: its estimator and its brake stay as they are. Codex-Stitch is read-only for us,
  and the cheapest correct place for the missing brake is the relay - it is the only component
  that sees the final wire body.
