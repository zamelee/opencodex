# ChatGPT Response - TypeScript / Bun LLM Probe Framework Survey

**Asked on**: 2026-09-26
**Platform**: chatgpt.com (Free tier, account "ZZZ LEE")
**Chat URL**: https://chatgpt.com/c/WEB:f91c636d-d81f-4c7f-93a8-b524cc59efd6
**Attachment**: `opencodex_probe_question.md` (6.3KB, Q1-Q5 structured question)
**Input path**: `input#upload-files` (Tier 3 fallback, DOM.setFileInputFiles, 100% precision) + `type_text` (CDP Input.insertText) for the prompt (chatgpt.com ProseMirror; per §0a.x.17 v10.14.8 `fill` is BROKEN on ProseMirror - collapses newlines)
**Send**: 4-track validated - composer=867 chars, send-button `disabled=false`, `aria-disabled=false`, `offsetParent!=null`

## TL;DR (ChatGPT's own summary)

- **Q1**: No mature TypeScript/Bun-native project exists. **Closest**: BerriAI/LiteLLM (Python, v1.104.0, MIT) - has structured health result with `model_name`, `model_id`, `status`, `healthy_count`, `unhealthy_count`, `error_message`, `response_time_ms`, `checked_at` persisted to DB. **Recommended**: build 500-1500 LoC internal subsystem, NOT pull a 3rd-party package.
- **Q2**: **OTel GenAI + OpenInference + custom JSON, not either/or**. OTel covers observation (latency, model, streaming, tokens, server.address) but lacks capability/quota discovery fields. OpenInference adds LLM-specific span kinds (`LLM`, `llm.tools.*`) but still no discovery schema. Custom JSON schema is SoT, OTel/OpenInference are exports.
- **Q3**: **No IETF/W3C RFC standardizes LLM discovery**. But ChatGPT cited 2 RFCs Copilot missed:
  - **RFC 8615** Well-Known URIs (§3) - transport primitive for `/.well-known/<name>` but no schema defined
  - **RFC 8631** Link Relation Types (§6.2 service-desc, §6.3 service-meta) - machine-readable service metadata via HTTP Link header
  - De-facto: OpenAI `/v1/models`, Google `models.list` (paginated, returns `inputTokenLimit`, `supported actions`)
- **Q4**: **Mature pattern**: SQLite (persistent history) + in-memory immutable snapshot (runtime routing truth). NOT file-watcher primary. Background probe worker fully isolated from live traffic (separate AbortController, concurrency, timeout, retry budget, rate limiter). **5-phase rate-limit experiment design**: Phase 0 single req -> Phase 1 low-rate -> Phase 2 step-up -> Phase 3 burst -> Phase 4 recovery -> Phase 5 long-term.
- **Q5**: 5 production proxies with file:line refs (where ChatGPT has data):
  - **BerriAI/litellm v1.104.0** (MIT, Python): `litellm/proxy/health_endpoints/_health_endpoints.py` ~L3244 (`_convert_health_check_to_dict()`), ~L3292 (`_save_health_check_to_db()`), ~L3338 (`response_time_ms`)
  - **envoyproxy/envoy v1.39.1** (Apache-2.0, C++, 2026-08-27, commit b579d07): `source/common/upstream/health_checker_impl.cc` ~L604 (hostname), ~L627 (factory), ~L642 (HTTP), ~L650 (TCP), ~L657 (gRPC), ~L672 (custom)
  - **Kong/kong 3.9.3** (Apache-2.0, Lua+Go, commit a643428): `kong/runloop/balancer/healthcheckers.lua`
  - **TykTechnologies/tyk v5.14.0** (MPL-2.0, 2026-07-07, commit 2e94501): `HealthCheckConfig` struct, default 60s sample window. **LICENSE WARNING**: MPL-2.0 fails the opencodex Apache/MIT/BSD constraint.
  - **traefik/traefik v3.7.13** (MIT, Go, 2026-09-04): `pkg/healthcheck/healthcheck.go:125` (logs 503 received, target DOWN)

## 5 explicit boundaries ChatGPT pushed (worth more than the schema itself)

1. **Discovery != health check** (don't reduce probe to "ping /v1/models")
2. **Health != capability** (an endpoint can be alive but not support what you need)
3. **Capability != benchmark** (capability = supports tools, benchmark = how good at tools)
4. **Probe history != routing snapshot** (history is in SQLite; snapshot is in-memory immutable)
5. **Probe traffic != user traffic** (probe needs own quota budget, separate AbortController etc.)

## Concrete recommended architecture (ChatGPT)

```
src/probe/
  scheduler.ts
  executor.ts
  protocols/
    openai-chat.ts
    openai-responses.ts
    anthropic-messages.ts
    google-gemini.ts
  experiments/
    latency.ts
    limits.ts
    rate-limit.ts
  inference.ts
  schema.ts
  store.ts
  snapshot.ts
```

Data flow:
```
provider config
  -> discovery (catalog / protocol / capability)
  -> controlled experiments (latency / limits / rate-limit)
  -> ProbeResult (custom schema)
       |-> SQLite history
       |-> immutable memory snapshot -> runtime router
```

## Self-aware limitations (ChatGPT marked [未核实])

- LiteLLM, Envoy, Kong, Tyk, Traefik **specific commit SHAs marked [未核实]**
- MLCommons unified LLM discovery protocol: **"我没有这项可靠资料"** (no reliable data on this)
- Whether promptfoo / k6 / Vercel AI SDK can be retrofitted: **conservative "no"**

## Bonus correction

ChatGPT pointed out that **opencodex's current version is v2.65.0 (2026-09-24, commit 87a78e5), not ~2.7.x** as the attachment said. The attachment was written from memory of older state. Worth fixing before publishing the survey or using in any docs.

## Verdict vs Copilot

ChatGPT response is significantly more concrete than Copilot:
- File:line refs vs paths only
- Live version verification vs 2024-06 cutoff
- Explicit license warnings (Tyk MPL-2.0, LiteLLM enterprise subdir)
- Architecture recommendation vs just schema
- 5-phase rate-limit experiment design vs generic "phase-based"

Both agree on the core finding: **no mature TS/Bun framework exists, build your own thin subsystem**.