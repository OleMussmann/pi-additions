# Plan Mode Default Extension for pi

Plan mode by default for interactive sessions. Structured plan management via `plan_item` tool.

## Features

- **Plan mode default**: Interactive sessions start in read-only exploration mode
- **Hybrid tool allowlist**: Safe builtins restricted, extension/MCP tools auto-allowed
- **Structured plan management**: `plan_item` tool for add/update/toggle/remove/clear/list
- **Session persistence**: Plan survives session resume via `appendEntry`
- **Keyboard shortcut**: `Ctrl+Alt+P` to toggle plan/exec mode
- **CLI flags**: `--plan` and `--exec` to override defaults

## Installation

This extension is bundled in the [`pi-additions`](https://github.com/OleMussmann/pi-additions) package, but its folder is also a standalone pi package (own `package.json` with a `pi.extensions` manifest). Install the whole bundle:

```bash
pi install git:github.com/OleMussmann/pi-additions
```

Or install just this extension on its own (from the repo root):

```bash
pi install ./extensions/pi-plan-mode-default

# Or load it for a single run (temp dir, not installed)
pi -e ./extensions/pi-plan-mode-default/index.ts
```

## Usage

### Modes

| Mode | Description | Tools |
|------|-------------|-------|
| **Plan mode** | Read-only exploration | `read`, `bash` (safe only), `grep`, `find`, `ls` + all extension tools |
| **Exec mode** | Full tool access | All tools |

### Switching modes

| Method | Action |
|--------|--------|
| `/plan` | Enter plan mode |
| `/exec` | Enter exec mode |
| `Ctrl+Alt+P` | Toggle between modes |
| `pi --plan` | Start in plan mode |
| `pi --exec` | Start in exec mode |

### Creating a plan

1. Type `/create-plan` or ask the agent to create a plan
2. The agent uses `plan_item` tool to add steps:

```
plan_item(action: "add", text: "Step description", priority: "high")
```

3. Switch to exec mode with `/exec` or `Ctrl+Alt+P`
4. Agent executes steps and marks them complete:

```
plan_item(action: "toggle", step: 1)
```

### Managing plans

| Command | Description |
|---------|-------------|
| `/plan-status` | Show current plan progress |
| `/create-plan` | Trigger agent to create a plan |

### plan_item tool

| Action | Description |
|--------|-------------|
| `add` | Add a new step (requires `text`, optional `priority`) |
| `update` | Update step text or priority (requires `step`) |
| `toggle` | Mark step complete/uncomplete (requires `step`) |
| `remove` | Delete a step (requires `step`) |
| `clear` | Delete all steps |
| `list` | Show all steps |

## How It Works

### Plan mode restrictions

- **edit/write tools**: Blocked entirely
- **Bash**: Restricted to safe read-only commands via allowlist
- **Extension tools**: All allowed (user explicitly installed them)

### Hybrid allowlist

```typescript
const PLAN_SAFE_BUILTINS = new Set(["read", "bash", "grep", "find", "ls"]);

function getPlanModeTools(): string[] {
    return pi.getAllTools()
        .filter((t) => {
            // Allow all extension/MCP tools
            if (t.sourceInfo.source !== "builtin") return true;
            // For builtins, only allow safe read-only commands
            return PLAN_SAFE_BUILTINS.has(t.name);
        })
        .map((t) => t.name);
}
```

This means:
- New extension/MCP tools auto-appear in plan mode
- Builtin tools restricted to safe set
- No need to maintain extension tool allowlist

## Command Allowlist

### Safe commands (allowed)

- **File inspection**: `cat`, `head`, `tail`, `less`, `more`
- **Search**: `grep`, `find`, `rg`, `fd`
- **Directory**: `ls`, `pwd`, `tree`
- **Git read**: `git status`, `git log`, `git diff`, `git branch`, `git show`
- **Package info**: `npm list`, `npm outdated`, `yarn info`
- **System info**: `uname`, `whoami`, `date`, `uptime`, `ps`

### Blocked commands

- **File modification**: `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`
- **Git write**: `git add`, `git commit`, `git push`, `git reset`, `git checkout`
- **Package install**: `npm install`, `yarn add`, `pip install`, `apt install`
- **System**: `sudo`, `kill`, `reboot`, `shutdown`
- **Editors**: `vim`, `nano`, `emacs`, `code`

## Configuration

### Keyboard shortcuts

Override the default `Ctrl+Alt+P` in `~/.pi/agent/keybindings.json` (string or array):

```json
{
  "extensions.pi-plan-mode-default.toggle": "ctrl+alt+m"
}
```

### CLI flags

| Flag | Description |
|------|-------------|
| `--plan` | Start in plan mode (overrides default) |
| `--exec` | Start in exec mode (overrides default) |

## License

MIT

Based on the [pi Plan Mode Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/plan-mode) by Mario Zechner (MIT, earendil-works/pi). See `LICENSE` for dual copyright attribution.
