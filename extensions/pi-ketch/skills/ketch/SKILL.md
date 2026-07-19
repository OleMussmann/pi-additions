---
name: ketch
description: External research via the ketch CLI — web search, OSS code search, library docs, scrape, and crawl. Use when researching the web, finding real OSS code usage, reading version-aware library docs, or extracting markdown from pages. For synthesized/summarized answers, delegate to the subagent-web-search subagent.
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
| Piped HTML → markdown | (manual) | `curl -L <url> | ketch extract` — not a tool; use via bash if needed |

## Token control (protect context)

Always tune per call:
- `limit` (default 5) — number of results.
- `maxChars` (default 4000) — truncate the returned summary.

Lower both when context is tight; raise for broader coverage.

## Useful flags

- `search`: `--multi` (fuse all usable backends), `--backend` (brave/ddg/searxng/exa/firecrawl/keenable), `--scrape` (full content).
- `code`: `--lang`, `--regex`, `--backend` (grepapp/sourcegraph/github).
- `docs`: `--library`, `--tokens`, `--resolve` (resolve a library name instead of searching).
- `scrape`: `--max-chars`, `--select` (CSS selector), `--no-cache`.
- `crawl`: `--depth`, `--concurrency`, `--allow`, `--deny`, `--sitemap`, `--background`.

## Control flow (exit codes)

ketch uses documented exit codes — surface these to the user when a call fails:
- `2` bad input · `3` not found · `4` upstream/network failure
- `5` missing precondition (e.g. no API key) → run `ketch config` and set the key
- `6` cancelled (SIGINT/SIGTERM)

`ketch doctor` reports backend health; `ketch config` shows active backends.

## Synthesized answers (subagent coordination)

`pi-ketch` is **raw-only** — it returns source material, not summaries. For a
synthesized/summarized answer, delegate to the **`subagent-web-search`** subagent
(part of `pi-subagents`), which uses ketch under the hood and returns a concise
summary. This keeps `pi-ketch` and `pi-subagents` independent: if the subagent is
not installed, just use `web` directly and summarize yourself.

## Edge cases: use pi-web-access instead

`ketch` cannot do everything. For these, use the **pi-web-access** tools:
- **Cloning a repository** for deep local exploration (`ketch crawl` only walks
  rendered website/sitemap HTML — it does NOT give you a git tree or file contents).
- **YouTube video transcripts** (`ketch` has no YouTube support at all).

For public OSS *discovery* ("where is X used?"), prefer `web` mode `code` — it is
often better than cloning.
