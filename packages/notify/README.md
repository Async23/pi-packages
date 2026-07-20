# @async23/pi-notify

Native macOS completion notifications for the Pi coding agent, with Ghostty/tmux click-to-focus.

## Features

- Notifies on `agent_settled`, after retries, compaction retries, and queued follow-ups finish.
- Shows the tmux coordinates and Pi session or project name.
- Uses the latest user prompt as the subtitle and the final outcome as the body.
- Reports terminal provider errors and cancelled tasks explicitly, including `cyber_policy`, instead of treating them as successful completion.
- Plays the macOS `Glass` sound by default.
- Clicking the notification activates Ghostty and selects the original tmux pane.
- Keeps one notification per Pi session instead of collapsing concurrent sessions together.
- Logs delivery metadata only, not prompt or answer contents.

## Requirements

- macOS
- [terminal-notifier](https://github.com/julienXX/terminal-notifier):

  ```bash
  brew install terminal-notifier
  ```

Ghostty and tmux are optional. Notifications still work without them, but click-to-focus requires both.

## Install

```bash
pi install npm:@async23/pi-notify
```

Restart Pi after installation, or run `/reload` in an existing session.

For local development:

```bash
pi install /absolute/path/to/pi-packages/packages/notify
```

Do not load both the package and a separate copy of `pi-notify.ts`, or every completion will send two notifications.

## Setup

The package works immediately through Homebrew's `terminal-notifier` and uses its bundled Pi icon.

For a dedicated `Pi Notifier` sender in macOS Notification settings, run once:

```text
/pi-notify-setup
```

Then verify notification delivery and click-to-focus:

```text
/pi-notify-test
```

The setup command creates:

```text
~/Applications/Pi Notifier.app
```

macOS may ask for notification permission the first time it sends a notification.

## Notification content

```text
Title:    0:21:1 · session or project name
Subtitle: latest user prompt
Body:     final assistant response, terminal error, or cancellation status
```

Long text and image markers are cleaned before display.

## Commands

| Command | Description |
| --- | --- |
| `/pi-notify-setup` | Install or refresh the dedicated macOS notifier app |
| `/pi-notify-test` | Send a test notification and test tmux click-to-focus |

## Configuration

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `PI_NOTIFY_DISABLED=1` | Disable notifications |
| `PI_NOTIFY_SOUND=name` | Change the macOS sound; defaults to `Glass` |
| `PI_NOTIFY_APP=/path/app` | Override the notifier app path |
| `PI_NOTIFY_FOCUS_SCRIPT=/path/script` | Override the tmux focus script |
| `PI_NOTIFY_LOG_PATH=/path/log` | Override the metadata log path |
| `PI_NOTIFY_DISABLE_LOG=1` | Disable metadata logging |

The default log is:

```text
~/.pi/agent/logs/pi-notify.log
```

It records timestamps, delivery method, session ID, and tmux coordinates only.

## Fallback order

```text
Pi Notifier.app
→ Homebrew terminal-notifier
→ Ghostty AppleScript
→ macOS AppleScript
```

The AppleScript fallbacks can display notifications but cannot guarantee exact tmux pane selection when clicked.

## License

MIT
