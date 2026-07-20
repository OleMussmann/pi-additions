---
name: ketch
description: Research outside the codebase — web search, OSS code search, library docs, scrape, crawl. For summarized answers, delegate to subagent-web-search.
---

# ketch — External Research (pi-ketch)

`pi-ketch` exposes the `ketch` CLI as a single Pi tool, `web`, with a `mode` enum.
All modes are read-only. ketch is a stateless binary; this skill documents when to
use each mode and which flags matter.

## When to use `web` (vs other tools)

| Need | `web` mode | Notes |
|------|-----------|-------|
| General web research / facts | `search` | add `scrape: true` for full content; `multi: true` to federate across backends (rank-fused) |
| Find real OSS usage across repos | `code` | add `lang` (e.g. `go`); `regex: true` for regex queries; `backend: github` for GitHub code search |
| Version-aware library docs | `docs` | set `library: /org/repo` to skip resolution; `tokens` for budget |
| Clean markdown from a URL / PDF | `scrape` | single or multiple URLs; auto-detects PDFs |
| Walk a docs site / sitemap | `crawl` | set `depth` (default 3), `allow`/`deny` filters; **use sparingly** (many requests) |

## Token control (protect context)

Always tune per call:
- `limit` (default 5) — number of results.
- `maxChars` (default 4000) — truncate the returned summary.

Lower both when context is tight; raise for broader coverage.

## Control flow (exit codes)

ketch uses documented exit codes — surface these to the user when a call fails:
- `2` bad input · `3` not found · `4` upstream/network failure
- `5` missing precondition (e.g. no API key) → run `ketch config` and set the key
- `6` cancelled (SIGINT/SIGTERM)

`ketch doctor` reports backend health; `ketch config` shows active backends.

## Synthesized answers

`pi-ketch` is **raw-only**. Delegate to `subagent-web-search` for summaries.

## Edge cases: use pi-web-access instead

`ketch` cannot:
- **Clone a repository** for deep local exploration (`ketch crawl` only walks
  rendered website/sitemap HTML — not a git tree or file contents).
- **Fetch YouTube video transcripts** (`ketch` has no YouTube support).

For public OSS *discovery* ("where is X used?"), prefer `web` mode `code` — it is
often better than cloning.
