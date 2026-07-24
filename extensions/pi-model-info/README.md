# pi-model-info

Enriched model roster for [pi](https://github.com/earendil-works/pi). Discovers all models from configured providers, fetches pricing and benchmark scores from [BenchLM.ai](https://benchlm.ai), tracks free-model availability, and annotates `/model` with pricing, context window, and scores.

## What it does

- **Discovers all models** from every configured non-local provider (OpenRouter, Anthropic, Google, etc.)
- **Enriches `/model`** with pricing, context window, and benchmark scores — no more guessing which model is which
- **Tracks free-model availability** with live liveness probing (green/yellow/red/restricted/unverified)
- **Fetches benchmarks** from [BenchLM.ai](https://benchlm.ai)'s free API — overall score (top-level `displayScore`, matching the web leaderboard) for 290+ model families
- **Updates in real-time** via `after_provider_response` — real usage feeds back into the catalog for free

### Display format in /model

```
✓ Qwen3-235B ($0/$0 · 128k · 56%)       ← free, green, overall score = 56%
~ Hy3 ($0/$0 · 200k · ~50 req/min)       ← free, yellow (tight limits)
✗ Hy3 ($0/$0 · 128k) — unavailable       ← free, dead
? Small Model ($0/$0 · ?) — unchecked     ← free, unverified
Claude Sonnet 4 ($3/$15 · 200k · 42%)     ← paid, overall score = 42%
! GPT-4o ($5/$15 · 128k) — restricted    ← paid, account-blocked
```

## Installation

### As part of pi-additions bundle

```bash
pi install git:github.com/OleMussmann/pi-additions
```

### Standalone

```bash
# From the pi-additions repo root
pi install ./extensions/pi-model-info

# Or load for a single run
pi -e ./extensions/pi-model-info/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/refresh-models` | Force-refresh the catalog: re-discover models, re-fetch benchmarks, reset probe timers |

## How it works

### Startup (async factory)

1. Fetches `/models` from all configured non-local providers
2. Filters to zero-cost entries for free-model tracking
3. Fetches benchmark scores from BenchLM.ai (cached 24h)
4. Re-registers each provider with enriched model names via `pi.registerProvider()`

### Background prober (session_start)

- Only probes **free models** (paid models are stable)
- Rate-shaped: ~10% of provider RPM budget
- Stalest-first: checks oldest entries first
- Retry-aware: respects `Retry-After` headers
- Jittered: ±20% interval variation

### Real-usage capture (after_provider_response)

- Every real API call updates the catalog for free
- 200/201 → reinforces green, records `last_real_call`
- 404 → immediately marks red
- 429 → reinforces yellow, stores `retry_after`
- 401/403/402 → marks as restricted (account-specific)

## Catalog file

Stored at `~/.pi/agent/extensions/pi-model-info/model-catalog.json`.

### Schema

```jsonc
{
  "schema_version": 1,
  "generated_by": "pi-model-info",
  "benchmark_source_date": "2026-07-22",
  "entries": {
    "<normalized_model_key>": {
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "is_free": true,
      "benchmarks": {
        "overall_score": 56.02,
        "coding_score": null,
        "agentic_score": null
      },
      "providers": {
        "openrouter": {
          "raw_id": "qwen/qwen3-235b:free",
          "context_length": 128000,
          "status": "green",
          "status_reason": "ok",
          "status_code": 200,
          "source": "real",
          "rpm_documented": 20,
          "rpd_documented": null,
          "retry_after": null,
          "last_checked": "2026-07-22T09:15:00Z",
          "last_real_call": "2026-07-22T09:10:00Z",
          "consecutive_synthetic_failures": 0
        }
      }
    }
  }
}
```

### Schema versioning

The `schema_version` field tracks breaking changes to the catalog format. Current version: **1**. If the schema changes in a backward-incompatible way, the version increments and consumers should check compatibility.

## Configuration

The extension uses sensible defaults. Local providers (Ollama, LM Studio, llama.cpp, etc.) are automatically excluded from probing.

### Excluded providers

Providers with these characteristics are skipped:
- Provider ID or API type matches: `ollama`, `lmstudio`, `llama.cpp`, `lm-studio`, `vllm`
- Base URL contains: `localhost`, `127.0.0.1`, `0.0.0.0`, private IP ranges

## Dependencies

- [BenchLM.ai](https://benchlm.ai) — free API for benchmark scores (no API key required, MIT license)
- pi's `modelRegistry` — for discovering configured providers and models

## Optional: pi-subagents integration

The `pi-subagents` extension can optionally consume this catalog to prefer green > yellow > red models within each tier. If the catalog file exists and is fresh, it uses availability data; otherwise it falls back to metadata-only scoring. This is a soft dependency — `pi-model-info` is never required.

## License

MIT

Benchmark data from [BenchLM.ai](https://benchlm.ai) used under MIT license with attribution.
