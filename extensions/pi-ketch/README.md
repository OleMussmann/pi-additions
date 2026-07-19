# Pi Ketch — External Research via the ketch CLI

Native Pi tool wrapping the [`ketch`](https://github.com/1broseidon/ketch) CLI for external
research: web search, OSS code search, library docs, scrape, and crawl. One tool, `web`, with
a `mode` enum — no shell-out, no bash dependency.

## Why ketch

[`ketch`](https://github.com/1broseidon/ketch) is a well-tested, general-purpose CLI tailored
for agent usage. It provides:

- **Multiple backends** with automatic fallback: Brave, DuckDuckGo, SearXNG, Exa, Firecrawl,
  Keenable (web search); Grep.app, Sourcegraph, GitHub (code search); Context7 (library docs).
- **One interface** for five research surfaces: `search`, `code`, `docs`, `scrape`, `crawl`.
- **Exit-code-driven control flow** — non-zero codes map to specific failure modes (bad input,
  not found, network error, missing API key), so the agent can surface actionable errors.
- **Read-only by design** — safe in plan mode; no side effects, no state.

`pi-ketch` wraps ketch as a first-class Pi tool so the agent can call it directly instead of
shelling out via bash.

## Installation

`pi-ketch` ships inside the [`pi-additions`](https://github.com/OleMussmann/pi-additions)
bundle, but its folder is also a standalone pi package (own `package.json` with a
`pi.extensions` manifest). Install the whole bundle:

```bash
pi install git:github.com/OleMussmann/pi-additions
```

Or install just this extension on its own (from the repo root):

```bash
pi install ./extensions/pi-ketch

# Or load it for a single run (temp dir, not installed)
pi -e ./extensions/pi-ketch/index.ts
```

After install, start Pi (`pi`) and press `Ctrl+O` to expand startup resources — the
`[Extensions]` section should list `pi-additions:*` (bundle) or `pi-ketch:*` (standalone).

### Prerequisites

`ketch` must be on PATH:

```bash
brew install 1broseidon/tap/ketch
# or
go install github.com/1broseidon/ketch@latest
```

## Tool: `web`

One tool with a `mode` enum. All modes are read-only.

### Modes

| Mode | Use for | Required param |
|------|---------|----------------|
| `search` | General web research / facts | `query` |
| `code` | Real OSS usage across repos | `query` |
| `docs` | Version-aware library docs (Context7) | `query` |
| `scrape` | Clean markdown from a URL / PDF | `url` |
| `crawl` | Walk a docs site / sitemap | `url` |

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `search \| code \| docs \| scrape \| crawl` | — | Research surface (required) |
| `query` | `string` | — | Search query (`search`, `code`, `docs`) |
| `url` | `string` | — | URL or sitemap URL (`scrape`, `crawl`) |
| `library` | `string` | — | `docs`: Context7 library ID (e.g. `/org/repo`) to skip resolution |
| `lang` | `string` | — | `code`: language filter (e.g. `go`, `ts`) |
| `limit` | `number` | `5` | Max results to return |
| `maxChars` | `number` | `4000` | Truncate the LLM-facing summary to N chars |
| `scrape` | `boolean` | `false` | `search`: fetch full content from each result |
| `multi` | `boolean` | `false` | `search`: federate across all usable backends (rank-fused) |
| `backend` | `string` | — | Explicit backend (e.g. `searxng`, `exa`, `grepapp`, `github`) |
| `regex` | `boolean` | `false` | `code`: treat query as regex |
| `tokens` | `number` | — | `docs`: Context7 token budget |
| `depth` | `number` | `3` | `crawl`: max BFS depth |
| `concurrency` | `number` | `8` | `crawl`: worker pool size |
| `allow` | `string` | — | `crawl`: path substring allow filter |
| `deny` | `string` | — | `crawl`: regex deny pattern |

### Token control

Always tune `limit` and `maxChars` per call. Lower both when context is tight; raise for
broader coverage.

### Error handling

ketch uses documented exit codes — the tool surfaces these as helpful messages:

| Code | Meaning |
|------|---------|
| `2` | Bad input (validation error) |
| `3` | Not found |
| `4` | Upstream / network failure |
| `5` | Missing precondition (e.g. no API key) — message tells user to run `ketch config` |
| `6` | Cancelled (SIGINT/SIGTERM) |

## Bundled Skill

A `ketch` skill ships with the extension and is auto-discovered via the `pi.skills` manifest
entry in `package.json`. Load it with `/skill:ketch` or let Pi offer it automatically on
research intent.

The skill documents when to use each mode, useful flags, token-control best practices, and
edge cases.

## Synthesized Answers

`pi-ketch` is **raw-only** — it returns source material, not summaries. For synthesized
research, delegate to a research subagent (if one is installed) rather than summarizing inline.

## Limitations

`pi-ketch` cannot:

- **Clone git repositories** — `crawl` only walks rendered website/sitemap HTML, not git trees or file contents.
- **Fetch YouTube transcripts** — ketch has no YouTube support.
- **Extract from piped HTML** — `ketch extract` requires a stdin pipe, so it's available via bash but not as a Pi tool.

For public OSS *discovery* ("where is X used?"), prefer `web` mode `code` — it is often
better than cloning.

## Health Check

On session start, `pi-ketch` runs `ketch doctor` (read-only). On failure, a **non-blocking**
notification names the broken backend(s). If `ketch` is missing from PATH, the notification
tells you to install it.

## Verb Allowlist (Defense in Depth)

`pi-ketch` builds the argv from typed params and only emits verbs in
`{search, code, docs, scrape, crawl, doctor, config}` where `config` is **show-only**. By
construction these are impossible: `config set`, `cache clear`, `mcp`, `browser install`,
`--force-browser`.

## Architecture

| Component | Purpose |
|-----------|---------|
| `index.ts` | Entry point: tool registration, health check, subagent detection |
| `skills/ketch/SKILL.md` | Bundled skill (auto-discovered via `pi.skills` manifest) |
| `PLAN.md` | Design decisions and rationale |
| `IMPL.md` | Implementation progress tracker |

Execution: `child_process.execFile("ketch", argv, { signal, timeout })` directly in TypeScript.
Never invoked through the agent's `bash` tool. The tool's `AbortSignal` is passed through; a
60s timeout kills hung processes. No shell → argument injection is impossible (real argv array).

## License

MIT

Original work by Ole Mussmann. See `LICENSE`.
