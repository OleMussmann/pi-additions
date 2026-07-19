# Pi Notify — Idle / Ready-for-Input Terminal Notifications

Sends a **native terminal notification** when Pi finishes a run and becomes idle, i.e. it is
waiting for your input. No desktop daemon, no external dependencies — it uses your terminal
emulator's built-in notification protocol.

## Why

Long agent runs are easy to lose track of. `pi-notify` pings your terminal the moment Pi is
done thinking, so you can switch back to the session without polling.

## How it works

The extension listens for pi's `agent_settled` event — the point at which Pi will **not**
continue running automatically (unlike `agent_end`, which also fires before auto-retries or
queued follow-ups). When the session is idle (`ctx.isIdle()`), it writes a notification escape
sequence to stdout.

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

None. The extension is zero-config and uses only environment variables that your terminal
sets automatically.

## Compatibility

- Requires `@earendil-works/pi-coding-agent` (provided by pi).
- Pure Node.js `node:child_process` for the Windows toast path; everything else writes
  directly to `process.stdout`.

## License

MIT

Based on the [pi Notify Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/notify.ts) by Mario Zechner (MIT, earendil-works/pi). See `LICENSE` for dual copyright attribution.
