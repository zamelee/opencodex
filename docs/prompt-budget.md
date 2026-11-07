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
| image degradation | automatic | - | when the outgoing body is over the upstream's budget, unusable images are dropped first, then the **oldest** images are textified |

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
3. **The image brake loses screenshots when it fires.** It degrades the OLDEST images first, so
   the newest screenshot (the one the user just took) survives longest. The drop is logged
   (`upstream prompt budget: dropped N image(s)`) and visible in the request log.
4. **The brake only protects the prompt.** If the conversation *text* alone is over the window,
   dropping images cannot help - only compaction can. The proxy logs the estimate either way.
5. **The learned ceiling is per provider and lives in memory**, so it resets on restart; until
   the upstream rejects one request, the proxy falls back to the declared window (conservative).
6. **The compaction request is treated separately**: it carries the pre-compaction history, so it
   gets 85% of the window plus an output reserve. This is the request shape that actually died.

## What was NOT changed

- Codex itself: its estimator and its brake stay as they are. Codex-Stitch is read-only for us,
  and the cheapest correct place for the missing brake is the relay - it is the only component
  that sees the final wire body.
