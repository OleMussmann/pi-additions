# Pi Notify — Idle / Ready-for-Input Terminal Notifications

Sends a **native terminal notification** when Pi finishes a run and becomes idle, i.e. it is
waiting for your input. No desktop daemon, no external dependencies — it uses your terminal
emulator's built-in notification protocol.

## Why

Long agent runs are easy to lose track of. `pi-notify` pings your terminal the moment Pi is
done thinking, so you can switch back to the session without polling.

## How it works

`pi-notify` fires a notification in two situations:

1. **Agent idle** — Pi finishes a run and is waiting for your next prompt. The extension
   listens for the `agent_settled` event (the point at which Pi will **not** continue
   running automatically) and writes a notification escape sequence to stdout when
   `ctx.isIdle()` is true.
2. **User-interaction tool** — Pi calls a tool that requires your input (e.g. `ask_user`).
   The extension listens for `tool_call` and notifies immediately when a tool from the
   config list is invoked, before its UI appears.

Supported terminal protocols (auto-detected):

| Protocol | Terminals | Detection |
|----------|-----------|-----------|
| **OSC 777** | Ghostty, iTerm2, WezTerm, rxvt-unicode | default |
| **OSC 99** | Kitty | `KITTY_WINDOW_ID` env var |
| **Windows toast** | Windows Terminal (WSL) | `WT_SESSION` env var |

> If your terminal supports OSC 777 or OSC 99, notifications "just work". Terminals that do
> not implement these sequences simply ignore the escape codes (no error, no output).

## Installation

`pi-notify` ships inside the [`pi-additions`](https://github.com/OleMussmann/pi-additions)
bundle, but its folder is also a standalone pi package (own `package.json` with a
`pi.extensions` manifest). Install the whole bundle:

```bash
pi install git:github.com/OleMussmann/pi-additions
```

Or install just this extension on its own (from the repo root):

```bash
pi install ./extensions/pi-notify

# Or load it for a single run (temp dir, not installed)
pi -e ./extensions/pi-notify/index.ts
```

After install, start Pi (`pi`) and press `Ctrl+O` to expand startup resources — the
`[Extensions]` section should list `pi-additions:*` (bundle) or `pi-notify:*` (standalone).

## Configuration

### The config file

On first session start, `pi-notify` auto-creates a config file:

**`~/.pi/agent/extensions/pi-notify/tools.json`**

```json
{
  "toolsRequiringInteraction": ["ask_user"]
}
```

- `toolsRequiringInteraction` — array of tool names that should trigger a notification
  when called. Pi notifies immediately when the tool is invoked, before its UI appears.

The config file is the sole source of truth. To add more tools, edit the file and run
`/reload`. To disable tool notifications, set the array to `[]`.

## Differences from the original pi example

`pi-notify` is derived from the [notify.ts example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/notify.ts) in the pi documentation. Key differences:

| Feature | Original example | pi-notify |
|---------|-----------------|----------|
| **Trigger** | `agent_settled` only | `agent_settled` + `tool_call` for user-interaction tools |
| **User-interaction tools** | Not handled | Notifies immediately when tools in the config list are called |
| **Config file** | None | Auto-created `tools.json` to specify which tools trigger notifications |
| **Package** | Single-file example | Installable pi package with `package.json` |

The original example is a minimal starting point. `pi-notify` extends it to cover the
case where Pi pauses for your input mid-run (e.g. a question from `ask_user`), not just
when it finishes a run.

## Compatibility

- Requires `@earendil-works/pi-coding-agent` (provided by pi).
- Pure Node.js `node:child_process` for the Windows toast path; everything else writes
  directly to `process.stdout`.

## License

MIT

Based on the [pi Notify Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/notify.ts) by Mario Zechner (MIT, earendil-works/pi). See `LICENSE` for dual copyright attribution.
