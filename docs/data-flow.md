# opencodex data flow

Last verified: 2026-08-31 against ~/.codex/config.toml on the user machine.
wire_api = responses, base_url = http://localhost:10100/v1.

## End-to-end request flow (mermaid)

```mermaid
sequenceDiagram
    autonumber
    participant U as User (Codex Desktop)
    participant C as Codex Core
    participant Ox as opencodex proxy :10100
    participant Up as minimax.chat upstream
    U->>C: 1. type prompt
    C->>Ox: 2. POST /v1/responses (OpenAI Responses wire)
    Ox->>Ox: 3. parseRequest() Responses to OcxReq
    note over Ox: parser.ts handles empty call_id
    Ox->>Ox: 4. resolve provider to anthropic adapter
    Ox->>Up: 5. POST /v1/messages (Anthropic wire)
    Up-->>Ox: 6. SSE stream 6 events
    Ox->>Ox: 7. parseStream() SSE to AdapterEvent
    note over Ox: anthropic.ts heldMessageDelta flush
    Ox->>Ox: 8. bridge AdapterEvent to Responses SSE
    Ox-->>C: 9. SSE stream response.created then items then response.completed
    C->>U: 10. Codex renders chat DOM
```
## Failure points (known + observed)

```mermaid
flowchart TD
    F1[F1 empty call_id 400]:::fixed
    F2[F2 SSE chunk boundary 4 over 6 events]:::fixed
    F3[F3 minimax reverse proxy embeds tool_use as markdown]:::open
    F4[F4 slash v1 slash messages streaming hangs]:::deferred
    subgraph Legend
        fixed[fixed]
        open[deferred to upstream]
        deferred[deferred]
    end
    F1 --> fixed
    F2 --> fixed
    F3 --> open
    F4 --> deferred
```
## Configuration that picks this path

From ~/.codex/config.toml verbatim on 2026-08-31:

    model_provider = custom
    model = minimax.chat slash MiniMax-M3
    wire_api = responses
    base_url = http://localhost:10100 slash v1

Key fact: wire_api = responses, NOT chat, NOT anthropic_messages.
Codex posts OpenAI Responses shape to opencodex. opencodex then rewraps to
Anthropic messages upstream. So the only wire format Codex sees on the
wirein side is OpenAI Responses; the Anthropic messages wire is hidden
behind opencodex.

## Where exceptions live

parseRequest failure returns 400 with JSON error body in Anthropic shape.
parseStream midstream failure closes the SSE response; Codex sees an
incomplete stream and surfaces an error to the user.

## What this document is NOT

Not a protocol spec. For Anthropic SSE event ordering, see AGENTS.md.
Not a deployment diagram. Single host, all local.
Not a benchmark. Step latency not profiled here.
