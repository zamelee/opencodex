# Copilot Response - TypeScript / Bun LLM Probe Framework Survey

**Asked on**: 2026-09-26
**Platform**: github.com/copilot (chat ID `93990ed3-9f89-4163-be9f-051f5ee881d4`)
**URL**: https://github.com/copilot/c/93990ed3-9f89-4163-be9f-051f5ee881d4
**Attachment**: `opencodex_probe_question.md` (6.3KB, Q1-Q5 structured question)
**Copilot model tier**: "汽车" (default Free tier, optimized for balance)

## TL;DR (Copilot's own summary)

- **Q1**: No mature TypeScript / Bun-native LLM probe framework exists. Build a small 200-400 LoC Bun-native harness (Bun fetch + workers + SSE parsing) and borrow methodology from LiteLLM (Python), vegeta/autocannon (load testing), and OpenAI/evals (Python).
- **Q2**: No single mature schema covers both capability discovery and operational probing. **OTel GenAI semantic conventions** cover telemetry (latency, model ID, token counts) but lack rate-limit threshold, cumulative ban threshold, multimodal flags, model-specific token limits. Recommended: OTel for telemetry + custom JSON for capability/quota fields.
- **Q3**: No IETF/W3C RFC for unified discovery. De-facto: OpenAI `/v1/models` (most honored), Google `models.list` (paginated). Anthropic has none. Community specs (LLM-RPC, OpenInference) exist but informal.
- **Q4**: Mature pattern: probe as isolated background worker, atomic JSON snapshot + SQLite dual-store, hot-reload via file watcher + in-memory TTL, circuit breaker exposed to router. Do NOT run aggressive stress tests in critical path.
- **Q5**: Envoy / NGINX / HAProxy / Traefik / Kong - generic proxies with active/passive health checks. Borrow architecture (active vs passive checks, thresholds, hysteresis), NOT code (license + portability issues).

## Training data caveat (Copilot explicit)

Training cutoff: 2024-06. Copilot cannot provide:
- Latest release tags post-cutoff
- Latest commit timestamps
- Exact file:line numbers
- Any RFCs published after 2024-06

So all file paths and project names are pre-2024-06 knowledge. Need live verification.

## Proposed JSON schema (Copilot's draft)

```json
{
  "provider": "string",
  "endpoint": "string",
  "probe_version": "semver",
  "probe_timestamp": "ISO8601",
  "protocols_tested": [{"protocol_name": "string", "endpoint_path": "string", "success": "bool"}],
  "models": [{
    "model_id": "string",
    "protocols": [{
      "protocol_name": "string",
      "supported": "bool",
      "sample_request": {...},
      "latency": {"p50_ms": "int", "p90_ms": "int", "p99_ms": "int", "sample_count": "int"},
      "throughput": {"steady_rps": "float", "burst_rps_estimate": "float"},
      "tokens": {"max_context_tokens_est": "int", "max_output_tokens_est": "int"},
      "multimodal": {"image_input": "bool", "audio_input": "bool", "video_input": "bool"},
      "tool_calls": {"supports_tool_calls": "bool", "observed_tool_call_behavior": ["string"]},
      "error_profile": {
        "rate_5xx": "float",
        "rate_429": "float",
        "connection_drops": "float",
        "example_errors": [{"status": "int", "snippet": "string"}]
      },
      "quota_cliff": {
        "detected": "bool",
        "threshold_requests": "int|null",
        "evidence": ["..."]
      },
      "last_successful_probe": "ISO8601",
      "raw_samples_ref": "string"
    }],
    "notes": "string"
  }],
  "probe_metadata": {"runner_id": "string", "region": "string", "ip": "string", "auth_mode": "string"},
  "raw_probes_file": "path/URL to compressed raw probe traces"
}
```

## Integration architecture (Copilot's recommendation)

- `core/probe-runner.ts` (200-400 LoC): concurrent tasks, Bun.fetch, SSE/stream parsing, OTel or local raw trace emission
- `storage/sqlite.ts`: compact schema, raw SQL preferred over ORM
- `output/snapshot-writer.ts`: atomic write via tmp file + rename
- `control/probe-worker.ts`: rate-limiters, credential isolation, phase-based orchestration (ramp / steady-state / burst / cooldown)
- `routing/probe-cache.ts`: in-proxy hot-reload + TTL for routing decisions

Storage dual-store:
- SQLite tables: `providers`, `models`, `events` (with raw_blob_reference)
- JSON snapshot for bootstrap + human debugging
- Atomic rename write pattern

Hot reload:
- Load JSON snapshot at startup (fast bootstrap)
- Open SQLite for queries
- Periodically (or on file change) reload snapshot into in-memory caches
- TTL 5-15 min so routing degrades gracefully when probe worker is down

## Copilot offered to do next

- **(A)** Draft Bun-native framework skeleton (4-6 files, 200-400 LoC probe harness + JSON schema + simple probe scenario for OpenAI Chat Completions and Anthropic Messages)
- **(B)** Look up real-time repo file paths and exact line numbers (with last commit date)

User should pick which one is more valuable. **My take**: A gives us a starting point to iterate; B gives us better grounding but Copilot can't verify live so the value is limited unless we ourselves open the repos.
