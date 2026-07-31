# @async23/pi-tmux-window-wrap

Report Pi's foreground agent activity to
[aipane](https://github.com/Async23/aipane)'s `tmux-window-wrap` status
indicator.

## Features

- Marks the current tmux pane busy when Pi emits `agent_start`.
- Keeps the marker busy across retries, compaction, and queued follow-ups.
- Clears the marker on `agent_settled`, startup, and shutdown.
- Uses aipane's pane-local marker, so stale state is ignored after the pane
  command changes.
- Becomes a silent no-op outside tmux or when the helper is unavailable.
- Provides `/tmux-window-wrap-test` for a visible 1.2-second indicator pulse.

## Requirements

- Pi coding agent
- tmux
- aipane's `tmux-window-wrap` helper with `activity busy|idle` support

The default helper location is:

```text
~/.local/bin/tmux-window-wrap
```

It should point to aipane's canonical script:

```bash
ln -sf "$HOME/code/demo/aipane/bin/tmux-window-wrap" \
  "$HOME/.local/bin/tmux-window-wrap"
```

## Install

```bash
pi install npm:@async23/pi-tmux-window-wrap
```

Restart Pi after installation, or run `/reload` in an existing session.

For local development:

```bash
pi install /absolute/path/to/pi-packages/packages/tmux-window-wrap
```

## Verify

Run this inside a Pi session under tmux:

```text
/tmux-window-wrap-test
```

The current window label should display an animated `▓` for 1.2 seconds.

Normal lifecycle mapping:

| Pi event | Marker |
| --- | --- |
| `session_start` | idle |
| `agent_start` | busy |
| `agent_settled` | idle |
| `session_shutdown` | idle |

`agent_settled` is intentionally used instead of `agent_end`: it fires only
after retries, compaction, and queued continuations have finished.

## Configuration

Override the helper executable when aipane is installed elsewhere:

```bash
export PI_TMUX_WINDOW_WRAP_BIN=/path/to/tmux-window-wrap
```

## Uninstall

```bash
pi remove npm:@async23/pi-tmux-window-wrap
```

## License

MIT
