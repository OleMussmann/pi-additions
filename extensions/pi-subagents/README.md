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

The extension ships with four agents (`subagent-scout`, `subagent-researcher`, `subagent-web-search`, `subagent-critic`)
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
| `catalogPath` | `~/.pi/agent/extensions/pi-model-info/model-catalog.json` | Path to pi-model-info's catalog for availability-aware model selection (optional) |

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

### Command: `/verify`

Review recent code changes with the critic agent:

```
/verify
```

Spawns the `subagent-critic` agent to review all code changes made in the current session. Checks for correctness, edge cases, security issues, and performance problems. Findings include file:line references and severity levels.

## Optional: pi-model-info integration

If [`pi-model-info`](https://github.com/OleMussmann/pi-additions/tree/main/extensions/pi-model-info) is installed, subagent-plus reads its `model-catalog.json` to make **availability-aware model selections** instead of picking the highest-scored model in a tier blindly.

When the catalog is present, the selection follows a three-pass priority ladder:

| Pass | What | Tier order | Why |
|------|------|------------|-----|
| 1 | **green** models | target → higher → lower | Confirmed working — preferred |
| 2 | **unverified** models | target → higher → lower | Unknown but might work — try before known-rate-limited |
| 3 | **yellow** models | target → higher → lower | Known rate-limited — last resort before failure |

If all models in every tier are `red` (confirmed dead) or `restricted` (account-gated), the subagent reports "no free model available" with a clear error message rather than silently trying a dead model.

### Fallback when catalog is absent

If `pi-model-info` is not installed, the catalog is missing, malformed, or has an unknown schema version: subagent-plus falls back to its original behavior (pick the highest-scored model in the requested tier, no availability filtering). This is a soft dependency — never blocks or errors a subagent spawn.

### Status lifecycle

Models not yet in the catalog default to `unverified` (pass 2). Once a model is used and returns a response, pi-model-info's `after_provider_response` handler records the outcome:
- **200/201** → `green` (pass 1 next time)
- **429** → `yellow` (pass 3)
- **404** → `red` (skipped entirely)

This means models in active rotation self-correct after one failure.

### Configuration

The catalog path can be overridden via `subagent-config.json`:

```json
{
  "catalogPath": "/custom/path/model-catalog.json"
}
```

Default: `~/.pi/agent/extensions/pi-model-info/model-catalog.json`

## Model Discovery and Tier Selection

subagent-plus discovers available models at runtime using pi's `modelRegistry.getAvailable()`.

### Scoring

Free models are scored using metadata:

```
score = contextWindow/1000 + maxTokens/100 + reasoning_bonus(500) + multimodal_bonus(100)
```

### Tier Assignment

Tier boundaries are computed from the **free-only** model pool (33rd/67th percentiles), so tiers reflect meaningful distinctions within what's actually usable:

- **fast** (bottom 33%): Small context, no reasoning
- **balanced** (middle 33%): Moderate context, general purpose
- **powerful** (top 33%): Large context, reasoning, multimodal

Only **zero-cost models** (`cost.input === 0 && cost.output === 0`) from non-local providers are eligible.

### Fallback

If a tier has no eligible models, the extension falls back:

```
requested tier → next lower tier → error with diagnostics
```

When pi-model-info is installed and the catalog is available, the fallback also checks higher tiers for green models before lower tiers for yellow — see [optional integration](#optional-pi-model-info-integration).

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

### Why free-only percentile scoring?

Earlier versions scored all models (paid + free) and then assigned tiers from global percentiles. In practice, paid models dominate the upper range, collapsing all free models into the "fast" tier. Switching to **free-only** percentiles ensures the three tiers reflect meaningful distinctions within what's actually usable — the top third of free models are "powerful", not just the top third of all models (which are all paid).

### Why no writeAccess parameter?

Subagents are research delegates. File modifications should happen in the main model where the full conversation context is available. This eliminates a whole class of security concerns.

### Why user confirmation for write access was rejected

The simpler and stronger design is to simply not allow writes. No confirmation dialogs, no edge cases, no accidental modifications.

### Why automatic local provider exclusion?

Local inference backends (Ollama, llama.cpp, LM Studio, vLLM, llama-swap) compete with the main model for VRAM and may not be running when a subagent needs them. Rather than relying on users to configure exclusions, the extension maintains a built-in list of known local providers and checks provider names — matching pi-model-info's detection logic. Users can still add exclusions via `subagent-config.json`.

## Included Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| `subagent-scout` | Fast codebase exploration | read, grep, find, ls, bash |
| `subagent-researcher` | Deep analysis | read, grep, find, ls, bash |
| `subagent-web-search` | Search and summarize | read, bash |
| `subagent-critic` | Code review for correctness, security, edge cases | read, grep, find, ls, bash |

## Limitations

- Parallel mode limited to 8 tasks, 4 concurrent
- Per-task output capped at 50 KB in parallel mode (full results in tool details)
- Model discovery requires at least one zero-cost model configured in pi
- Free tiers often have rate limits; spawn failures are reported to the parent
- If all eligible models are dead or restricted (when pi-model-info is installed), the subagent reports "no free model available" rather than silently trying a broken model

## License

MIT

Based on the [pi Subagent Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) by Mario Zechner (MIT, earendil-works/pi). See `LICENSE` for dual copyright attribution.
