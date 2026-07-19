# subagent-plus

Live model-aware subagent delegation for [pi](https://github.com/earendil-works/pi). Spawn read-only research subagents that automatically discover and select free models by capability tier.

## Why subagent-plus?

The official pi subagent example is excellent but requires manually specifying models per agent. subagent-plus adds:

- **Live model discovery**: Queries `ctx.modelRegistry.getAvailable()` to find zero-cost models at runtime
- **Automatic tier selection**: Classifies available models into fast/balanced/powerful tiers using percentile scoring on model metadata (context window, reasoning, multimodal support)
- **Read-only guardrails**: Subagents can explore and search but never modify files
- **Summarization modes**: Control how much context the subagent returns to the parent
- **Sensitive path blocking**: Guardrail extension prevents subagents from reading SSH keys, env files, etc.

## Installation

subagent-plus ships inside the [`pi-additions`](https://github.com/OleMussmann/pi-additions) package, but its folder is also a standalone pi package (own `package.json` with a `pi.extensions` manifest). You can install just this extension:

```bash
# From the pi-additions repo root
pi install ./extensions/pi-subagents

# Or load it for a single run (temp dir, not installed)
pi -e ./extensions/pi-subagents/index.ts
```

To install the whole bundle instead:

```bash
pi install git:github.com/OleMussmann/pi-additions
```

> **Note:** You do **not** need to symlink the extension files. `pi install ./extensions/pi-subagents`
> (or `pi install git:github.com/OleMussmann/pi-additions` for the bundle) registers it directly.
> The extension also auto-discovers its own agents from its bundled `agents/` folder — no agent
> symlinks required either.

### Agent definitions

The extension ships with three agents (`subagent-scout`, `subagent-researcher`, `subagent-web-search`)
and **automatically loads them from its own `agents/` folder** — no symlinks required.

Behind the scenes, `discoverAgents()` resolves the extension directory via `import.meta.url`
(and falls back to `__dirname`) and reads `extensions/pi-subagents/agents/*.md` as `source: "bundled"`.
These are always available regardless of `agentScope`.

If you want to add your **own** agents beyond the bundled ones, place them in:

```bash
mkdir -p ~/.pi/agent/agents
# copy or symlink YOUR agents here — not the shipped ones
```

Then reload pi with `/reload`.

## Configuration

Create `~/.pi/agent/subagent-config.json`:

```json
{
  "excludeProviders": ["ollama", "lmstudio"],
  "excludePatterns": ["localhost", "127.0.0.1"],
  "sensitivePaths": []
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `excludeProviders` | `["ollama", "lmstudio"]` | Provider names to exclude from subagent pool |
| `excludePatterns` | `["localhost", "127.0.0.1"]` | Substrings to filter from provider/model IDs |
| `sensitivePaths` | `[]` | Additional path patterns to block beyond defaults |

## Usage

### Tool: `subagent`

The LLM can call the `subagent` tool to delegate tasks.

#### Single agent

```json
{
  "agent": "subagent-scout",
  "task": "Find all authentication-related code",
  "tier": "fast"
}
```

#### Parallel execution

```json
{
  "tasks": [
    { "agent": "subagent-scout", "task": "Find model definitions" },
    { "agent": "subagent-scout", "task": "Find provider configurations" }
  ],
  "tier": "balanced"
}
```

#### Chained workflow

```json
{
  "chain": [
    { "agent": "subagent-scout", "task": "Find the auth module" },
    { "agent": "subagent-researcher", "task": "Analyze {previous} for security issues" }
  ],
  "tier": "powerful"
}
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | `string` | — | Agent name (single mode) |
| `task` | `string` | — | Task description (single mode) |
| `tasks` | `Array<{agent, task, cwd?}>` | — | Parallel tasks |
| `chain` | `Array<{agent, task, cwd?}>` | — | Sequential tasks with `{previous}` placeholder |
| `tier` | `"fast" \| "balanced" \| "powerful"` | `"balanced"` | Model capability tier |
| `outputFormat` | `"summary" \| "detailed" \| "full"` | `"detailed"` | How much context to return |
| `agentScope` | `"bundled" \| "user" \| "project" \| "both"` | `"user"` | Which agent directories to search. `"bundled"` uses only the extension's shipped agents (no symlinks, no user/project mix-in). `"user"` adds your `~/.pi/agent/agents/`. `"project"` adds repo `.pi/agents/`. `"both"` adds all three (user/project override bundled). |
| `confirmProjectAgents` | `boolean` | `true` | Confirm before running project-local agents |

### Command: `/delegate`

Quick delegation with safe defaults (balanced tier, summary output):

```
/delegate find all places where user input is validated
```

This wraps the subagent tool with sensible defaults.

## Model Discovery and Tier Selection

subagent-plus discovers available models at runtime using pi's `modelRegistry.getAvailable()`.

### Scoring

All available models are scored using metadata:

```
score = contextWindow/1000 + maxTokens/100 + reasoning_bonus(500) + multimodal_bonus(100)
```

### Tier Assignment

The 33rd and 67th percentiles of the **full** model spectrum define tier boundaries:

- **fast** (bottom 33%): Small context, no reasoning
- **balanced** (middle 33%): Moderate context, general purpose
- **powerful** (top 33%): Large context, reasoning, multimodal

Only **zero-cost models** (`cost.input === 0 && cost.output === 0`) from non-local providers are eligible.

### Fallback

If a tier has no eligible models, the extension falls back:

```
requested tier → next lower tier → any free model → error with diagnostics
```

## Read-Only Guardrails

Subagents are **always read-only**. They cannot modify files.

### Tool restrictions

Subagents receive only: `read`, `grep`, `find`, `ls`, `bash`

### Bash filtering

Bash commands are filtered through an allowlist/blocklist. Allowed: `cat`, `head`, `tail`, `grep`, `find`, `ls`, `git log`, `npm list`, etc. Blocked: `rm`, `mv`, `cp`, `git commit`, `npm install`, redirects, editors, `sudo`, etc.

### Sensitive path blocking

A guardrail extension is injected into every subagent process. It blocks access to:

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`
- `.env`, `.env.local`, `*.pem`, `id_rsa`, `id_ed25519`
- Any path matching `.gitignore` patterns
- User-configured additional paths

### Environment sanitization

Sensitive environment variables are stripped from subagent processes: `SSH_AUTH_SOCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `extensions/pi-subagents/agents/*.md` — Bundled (always loaded automatically, no symlink needed)
- `~/.pi/agent/agents/*.md` — User-level (loaded when scope is `"user"` or `"both"`; can override bundled)
- `.pi/agents/*.md` — Project-level (loaded when `agentScope` is `"project"` or `"both"`)

The `model` field is optional. If omitted, the tier parameter selects the model automatically.

## Summarization Modes

Control how much output the subagent returns:

- **`summary`**: Concise report (max ~500 words). Saves parent context window. Best for web search and quick lookups.
- **`detailed`**: Thorough report with excerpts and file paths. Default for most tasks.
- **`full`**: Complete output without length constraints.

## Design Decisions

### Why percentile-based scoring?

Model names and IDs change constantly. Hardcoded lists become stale. Percentile scoring on metadata adapts automatically to new models.

### Why score all models, not just free ones?

Scoring the full spectrum ensures tier boundaries reflect the current state of the AI model landscape. If all free models are small, they still distribute meaningfully across tiers relative to the global baseline.

### Why no writeAccess parameter?

Subagents are research delegates. File modifications should happen in the main model where the full conversation context is available. This eliminates a whole class of security concerns.

### Why user confirmation for write access was rejected

The simpler and stronger design is to simply not allow writes. No confirmation dialogs, no edge cases, no accidental modifications.

## Included Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| `subagent-scout` | Fast codebase exploration | read, grep, find, ls, bash |
| `subagent-researcher` | Deep analysis | read, grep, find, ls, bash |
| `subagent-web-search` | Search and summarize | read, bash |

## Limitations

- Parallel mode limited to 8 tasks, 4 concurrent
- Per-task output capped at 50 KB in parallel mode (full results in tool details)
- Model discovery requires at least one zero-cost model configured in pi
- Free tiers often have rate limits; spawn failures are reported to the parent

## License

MIT

Based on the [pi Subagent Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) by Mario Zechner (MIT, earendil-works/pi). See `LICENSE` for dual copyright attribution.
