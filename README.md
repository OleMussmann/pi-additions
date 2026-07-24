# pi-additions

A single installable [Pi](https://github.com/earendil-works/pi) package that bundles five
coding-agent extensions:

| Extension | What it does |
|-----------|--------------|
| [`pi-frame`](./extensions/pi-frame) | Decorates the editor input area with a styled box/bar + live stats (model, mode, context, cost, git, …) |
| [`pi-ketch`](./extensions/pi-ketch) | Native `web` tool wrapping the `ketch` CLI for external research — web search, OSS code search, library docs, scrape, crawl (with a bundled `ketch` skill) |
| [`pi-subagents`](./extensions/pi-subagents) | Read-only, model-aware subagent delegation (`/delegate`, `subagent` tool) with automatic free-model tier selection and guardrails |
| [`pi-plan-mode-default`](./extensions/pi-plan-mode-default) | Plan mode by default for interactive sessions; structured plan management via the `plan_item` tool (`/plan`, `/exec`, `Ctrl+Alt+P`) |
| [`pi-notify`](./extensions/pi-notify) | Native terminal notification when Pi is idle and waiting for input (OSC 777, OSC 99/Kitty, Windows toast) |

Install once, enable/disable each extension independently from your Pi config.

## Install

From git (no npm publish needed). Pi registers the package and clones it under
`~/.pi/agent/git/`:

```bash
# Global (all projects) — user settings
pi install git:github.com/OleMussmann/pi-additions

# Project-local (current repo, shared via .pi/settings.json) — review-then-trust
pi install git:github.com/OleMussmann/pi-additions -l --approve
```

Load a single extension without installing:

```bash
pi -e ./extensions/pi-frame/index.ts
```

Each sub-extension is also installable **on its own** (it carries its own `package.json`
with a `pi.extensions` manifest). From the repo root:

```bash
# Install just one extension as a standalone package
pi install ./extensions/pi-frame
pi install ./extensions/pi-ketch
pi install ./extensions/pi-subagents
pi install ./extensions/pi-plan-mode-default
pi install ./extensions/pi-notify
pi install ./extensions/pi-model-info

# Or load a single extension for one run (temp dir)
pi -e ./extensions/pi-subagents/index.ts
pi -e ./extensions/pi-ketch/index.ts
pi -e ./extensions/pi-frame/index.ts
pi -e ./extensions/pi-plan-mode-default/index.ts
pi -e ./extensions/pi-notify/index.ts
pi -e ./extensions/pi-model-info/index.ts
```

After install, start Pi (`pi`) and press `Ctrl+O` to expand startup resources —
the `[Extensions]` section should list all six `pi-additions:*` entries.

## Activate / deactivate extensions

Each extension is a separate, toggleable resource. Use Pi's **native** config
mechanism — no custom code required.

### Interactive (`pi config`)

```
pi config
```

Starts in global settings; press `Tab` to switch between global and project-local.
Toggle individual extensions on/off.

### Manual (`settings.json`)

Edit the package entry in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project-local). Add an `extensions` filter array that **excludes** the entry you want off.
Filter paths are relative to the package root.

Disable `pi-subagents` only:

```json
{
  "packages": [
    {
      "source": "git:github.com/OleMussmann/pi-additions",
      "extensions": [
        "./extensions/pi-frame/index.ts",
        "!./extensions/pi-subagents/index.ts",
        "./extensions/pi-plan-mode-default/index.ts",
        "./extensions/pi-notify/index.ts"
      ]
    }
  ]
}
```

Filter rules:
- Omit `extensions` → load all four.
- `"extensions": []` → load none from this package.
- `"!./extensions/pi-subagents/index.ts"` → exclude just that one.
- `"!./extensions/*/index.ts"` glob exclusions also work.

## Extension details

### pi-frame
Decorates the input area with a **box** (`╭─╮╰─╯`) or **bar** (`█`) and shows live stats:
model + provider, session summary, mode, thinking level, tokens/sec, cost, context-window
fill, cwd, git status, and Pi version. Switch flavors with `/frame box` | `/frame bar`;
toggle stats with `/frame show <stat>` / `/frame hide <stat>`.

> **Note:** The `mode` stat needs a plan-mode extension (e.g. `pi-plan-mode-default` here) to
> toggle `plan`/`exec`. Without one it always shows `exec`.

### pi-ketch
Native Pi tool (`web`) wrapping the [`ketch`](https://github.com/1broseidon/ketch) CLI for
external research: web search, OSS code search, library docs, scrape, and crawl. One tool with
a `mode` enum; `ketch`'s exit codes drive error handling, and a bundled `ketch` skill documents
when to use each mode, token-control flags, and how to combine it with the `subagent-web-search`
subagent for synthesized answers. Read-only — safe in plan mode. Requires `ketch` on PATH
(`brew install 1broseidon/tap/ketch`).

> **Note:** `pi-ketch` is raw-only. For summarized research, delegate to `subagent-web-search`
> (from `pi-subagents`). For full repo clones or YouTube transcripts, use `pi-web-access`.

### pi-subagents
Spawns read-only research subagents that auto-discover zero-cost models and pick one by
capability tier (`fast` / `balanced` / `powerful`). Bash is allow/block-listed; sensitive
paths and env vars are stripped. Use via the `subagent` tool or `/delegate`.

> **No setup needed for the bundled agents.** The extension auto-discovers its own agents
> (`subagent-scout`, `subagent-researcher`, `subagent-web-search`) from its bundled `agents/`
folder — no symlinks required. To add your *own* agents, drop `.md` files in
> `~/.pi/agent/agents/` (see `extensions/pi-subagents/README.md`).

- Optional config at `~/.pi/agent/subagent-config.json` (see
  `extensions/pi-subagents/README.md`).

### pi-plan-mode-default
Interactive sessions start in **plan mode** (read-only; `edit`/`write` blocked, bash limited
to a safe allowlist, extension/MCP tools auto-allowed). Switch with `/plan`, `/exec`, or
`Ctrl+Alt+P`; start forced with `pi --plan` / `pi --exec`. The agent manages an implementation
plan through the `plan_item` tool. Plan state persists across session resumes.

### pi-notify
Sends a **native terminal notification** when Pi settles and is idle, waiting for your input.
Zero-config; supports OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode), OSC 99 (Kitty), and
Windows toast (Windows Terminal / WSL). See `extensions/pi-notify/README.md`.

### pi-model-info
Enriched model roster — discovers all models from configured providers, fetches pricing and
benchmark scores from [BenchLM.ai](https://benchlm.ai) (free API, no key required), tracks
free-model availability with background liveness probing, and annotates `/model` with pricing,
context window, and scores. Free models get glyph prefixes (✓/~/✗/!/?). Use `/refresh-models`
to force a refresh. See `extensions/pi-model-info/README.md`.

## Layout

```
pi-additions/
├── package.json            # pi manifest: lists the extensions
├── README.md
└── extensions/
    ├── pi-frame/           # index.ts + helpers, render, git, types
    ├── pi-ketch/            # index.ts + skills/ketch (bundled skill), PLAN.md, IMPL.md
    ├── pi-subagents/       # index.ts + agents/, models, config, guardrail
    ├── pi-plan-mode-default/  # index.ts + utils
    ├── pi-notify/          # index.ts
    └── pi-model-info/      # index.ts + catalog, discovery, benchmarks, prober, annotate
```

## License

MIT. This bundle is copyrighted by Ole Mussmann, and three of its extensions
(`pi-subagents`, `pi-notify`, `pi-plan-mode-default`) are derived from MIT-licensed
pi example extensions originally authored by Mario Zechner (earendil-works/pi). See
[`LICENSE`](./LICENSE) for the full dual copyright attribution, and each extension's
own `LICENSE` / `package.json` for per-extension details.

Benchmark data used by `pi-model-info` is provided by [BenchLM.ai](https://benchlm.ai)
under the MIT license with attribution.
