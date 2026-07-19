# Pi Frame — Pi Coding Agent Input Field Extension

Decorates the Pi editor input area with a styled box or bar, plus live stats: model, session summary, mode, thinking level, tokens/sec, cost, context window usage, cwd, git status, and version.

## Quick Start

```bash
# From the pi-additions repo root
pi -e ./extensions/pi-frame/frame.ts

# Or install pi-frame on its own
pi install ./extensions/pi-frame
```

pi-frame also ships inside the [`pi-additions`](https://github.com/OleMussmann/pi-additions) bundle:

```bash
pi install git:github.com/OleMussmann/pi-additions
```

## Extension Dependencies

### Plan Mode (required for `mode` stat)

The `mode` stat (`plan` / `exec`) depends on a **plan-mode extension** being installed. pi-frame detects mode by checking whether `edit` and `write` tools are disabled — this only happens when a plan-mode extension calls `pi.setActiveTools()` to restrict the tool set.

**Without a plan-mode extension:**
- The `mode` stat always displays `exec` (accent color)
- Never shows `plan` (warning color)
- All other stats work normally

**With a plan-mode extension:**
- `mode` toggles between `plan` (warning) and `exec` (accent)
- Reflects actual tool availability

Recommended: [`pi-plan-mode-default`](https://github.com/OleMussmann/pi-additions/tree/main/extensions/pi-plan-mode-default) — bundled in `pi-additions`, starts in plan mode by default, `/plan` and `/exec` to switch.

Install alongside pi-frame (both are standalone-installable sub-packages):

```bash
pi install ./extensions/pi-frame ./extensions/pi-plan-mode-default
```

Or load both for a single run:

```bash
pi -e ./extensions/pi-frame/frame.ts -e ./extensions/pi-plan-mode-default/index.ts
```

Or place both in `~/.pi/agent/extensions/` for auto-discovery.

## Persistence

Mode (box/bar) and visible stats persist across session reloads. State is stored in the session file via `pi.appendEntry()` and restored on `session_start` and `session_tree` events.

On new sessions, state is restored in this order:
1. CLI flag `--frame-mode` (if provided)
2. Persisted session state (from previous session)
3. Global defaults from `~/.pi/agent/settings.json` under `pi-frame` key
4. Hardcoded defaults (box mode, all stats visible)

### Global Defaults

Set default preferences in `~/.pi/agent/settings.json`:

```json
{
  "pi-frame": {
    "flavor": "bar",
    "visible": ["model", "mode", "context", "cwd", "git"]
  }
}
```

## Flavors

Two visual styles. Switch with `/frame`:

| Command | Result |
|---|---|
| `/frame box` | Full box-drawing frame (╭─╮╰─╯) |
| `/frame bar` | Left thick block bar (█) |

Default is `box`. Optionally override with CLI flag for one session:

```bash
pi -e ./frame.ts --frame-mode bar
```

## Stats

Ten stat groups, each togglable per-session:

| Key | Display |
|---|---|
| `model` | Model ID + provider (top-left) |
| `session` | Session name or first user message summary (top-right) |
| `mode` | `plan` or `exec` (bottom-left, requires plan-mode extension) |
| `thinking` | Thinking level / "off" (bottom-left) |
| `tps` | Tokens per second (bottom-right) |
| `cost` | Cumulative session cost in $ (bottom-right) |
| `context` | Context window fill % + progress bar (bottom-right) |
| `cwd` | Current working directory, ~-expanded (footer left) |
| `git` | Branch, state, status glyphs (footer left) |
| `version` | Current Pi version (footer right) |

All colors come from the active theme. Mode uses accent/warning; context bar uses success → warning → error thresholds (50% / 80%).

> **Note:** The `mode` stat requires a plan-mode extension (see [Extension Dependencies](#extension-dependencies)). Without one, it always shows `exec`.

### Toggle visibility

```
/frame show <stat>
/frame hide <stat>
```

Visibility persists across reloads. List current state with no arguments:

```
/frame
```

Output example: `frame: box mode | visible: model, session, mode, thinking, tps, cost, context, cwd, git, version`

## Layout

Both flavors share the same stat positions:

```
╭ model_id (provider)         ── session summary ─────────╮
│ > user prompt text...                                    │
│   continuation lines...                                  │
╰ plan · thinking off    ── 42 t/s · 0.012$ · 23% ━━───────╯
  ~/code/project  main ⇡2 +3 !1 ~1  pi v<current>
```

Box: box-drawing characters with mode-colored borders and gutter.
Bar: single █ column on left, dark-grey background fill across the rest.

## Git Status

Starship-inspired glyphs. Edit `GIT_SYMBOLS` in-source to customize:

| Glyph | Meaning |
|---|---|
| `⇡N` | Ahead of remote by N commits |
| `⇣N` | Behind remote by N commits |
| `+N` | Staged changes |
| `!N` | Modified tracked files |
| `»N` | Renamed files |
| `󰧧N` | Deleted files |
| `󱀣N` | Untracked files |
| `󱠇N` | Conflicted files |
| `*N` | Stashed changes |
| `REBASING`, `MERGING`, etc. | Active git operation state |

Auto-refreshes on session start, agent end, and branch change.

## CLI Flags

| Flag | Description |
|---|---|
| `--frame-mode <box\|bar>` | Override mode for this session only (does not persist) |

## Architecture

Modular structure:

| Module | Purpose |
|---|---|
| `frame.ts` | Entry point, command registration, event handlers |
| `types.ts` | Types, constants, config |
| `git.ts` | Git status parsing and display |
| `helpers.ts` | String formatting, ANSI utilities |
| `render.ts` | Box and bar rendering |

Wraps (doesn't replace) whatever editor component is installed at session start. This means it composes with other extensions like `raw-paste` — each extension's editor gets decorated by pi-frame rather than fighting for sole control.

Marked with `__piFrame` to prevent double-wrapping across `/reload`.

## Load Path

```typescript
// pi -e ./frame.ts
export default function (pi: ExtensionAPI) { ... }
```

Requires:
- `@earendil-works/pi-coding-agent` (ExtensionAPI, CustomEditor)
- `@earendil-works/pi-tui` (EditorComponent, truncateToWidth, visibleWidth)
- `@earendil-works/pi-ai` (ThinkingLevel)
- Node.js `fs.existsSync`, `path.join`

## License

MIT

Original work by Ole Mussmann. Not derived from a pi example extension. See `LICENSE`.
