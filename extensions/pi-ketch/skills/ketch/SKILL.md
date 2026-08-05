---
name: ketch
description: Research outside the codebase — web search, OSS code search, library docs, scrape, crawl. For summarized answers, delegate to subagent-web-search.
---

# ketch — External Research (pi-ketch)

`web` wraps the `ketch` CLI as one tool with a `mode` enum. Read-only, stateless —
one call, one result. Cite the source URL for every claim; never invent one.

## Mode routing

| Need | mode | Key params / notes |
|---|---|---|
| Web search, opinions, current info | `search` | `scrape:true` → full content per result (costs like a scrape — drop `limit` to 2-3); `multi:true` → federate all backends, rank-fused; `backend` to pin one |
| Real-world OSS usage of an API | `code` | `lang`; `regex:true` (grepapp/sourcegraph only — github rejects it); `backend: github` for GitHub Code Search |
| A library's own docs, version-aware | `docs` | Without `library`, ketch resolves the name for you — sanity-check the result actually matches (a typo can still get a confident wrong match). Set `library: /org/repo` to skip resolution when you know the ID |
| Content of a known URL / PDF | `scrape` | Never re-search a URL you already have. Bare domains auto-probe `/llms.txt` and may return that instead of the page — if the result looks like a site manifest, that's why |
| Many pages under one site | `crawl` | `depth` (default 3), `allow`/`deny` filters, `concurrency`. Use sparingly — many requests |

## Token budget

`limit` (default 5), `maxChars` (default 4000, truncates the whole rendered
summary) — lower both when context is tight, raise for broader coverage.

## Errors

Failures name their class in the returned text: bad input, not found,
upstream/network failure, missing precondition, cancelled.

- Bad input / not found → fix the call; retrying unchanged can't succeed.
- Upstream/network → retry once, optionally with a different `backend`.
- Missing precondition (no API key) → tell the user; don't run `ketch config` yourself.
- Cancelled → rerun with a smaller scope.

## Gotchas

- **Batch scrape partial failure.** A scrape of multiple URLs can return `isError=false` with individual `results[].error` set on some entries. Check each result — a success summary doesn't mean every URL succeeded.
- **`regexp` backend restriction.** `regex:true` works on grepapp and sourcegraph only; github rejects it.
- **Docs resolve needs vetting.** `docs` never returns empty — a typo gets confident fuzzy matches. Check the name, not just the trust score.

## Synthesis

`web` is raw-only. For a summarized, cited answer, delegate to
`subagent-web-search` (via the `subagent` tool) if available.

## Subagent tiering

| Scenario | Tool | Why |
|---|---|---|
| Known URL | `web` mode scrape directly | No exploration needed; subagent adds latency + paraphrase |
| Unknown URL, known problem | `web` search in main loop | SERP is ~1-3k tokens; main agent knows repo constraints |
| Unknown landscape / N libraries / whole-docs crawl | `subagent-web-search` as **librarian** | Subagent scrapes to disk, returns manifest (paths, URLs, excerpts) — not a summary |

## Edge cases: use pi-web-access instead

`web` can't download a GitHub repo to `/tmp` for local code access, or fetch
YouTube transcripts — use `fetch_content` (pi-web-access) for both. For OSS
*discovery* ("where is X used?"), prefer `web` mode `code` over a full download.

If `web`/ketch isn't installed at all, fall back to `web_search` (pi-web-access).

## Diagnostics

Pi can shell out for read-only diagnostics:
- `ketch doctor --json` — backend health
- `ketch config` — active backends and settings

Don't mutate config yourself — tell the user what to run.
