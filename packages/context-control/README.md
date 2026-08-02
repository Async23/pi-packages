# @async23/pi-context-control

A Pi extension for interactively enabling or disabling loaded Context instruction files such as `AGENTS.md` and `CLAUDE.md`.

## Install

```bash
pi install npm:@async23/pi-context-control
```

Restart Pi after installation, or run `/reload` in an existing session.

For local development from this repository:

```bash
pi --no-extensions -e ./packages/context-control
```

## Usage

Run:

```text
/context
```

The Context inspector lists the instruction files Pi discovered for the current working directory, groups them by configuration scope, and previews each file's complete contents. Groups start expanded and can be folded for the lifetime of the inspector. Filtering temporarily expands matching groups without changing their saved fold state.

- Up/Down or `j`/`k` selects a group heading or file while Files is focused and scrolls while Preview is focused.
- Space or Enter folds or unfolds a selected group heading. On narrow terminals, Enter opens Preview for a selected file.
- On a selected group heading, Left or `h` collapses the group and Right or `l` expands it. On a selected file, Left/Right or `h`/`l` cycles focus between Files and Preview. Moving past either end wraps to the other pane; Tab remains an alternative on wide terminals.
- `/` enters path-filter input from either pane; the slash is a trigger and is not part of the displayed query. Matching is case-insensitive and supports non-contiguous path characters.
- Filter input uses Pi's native single-line editor, including Unicode/IME cursor positioning, paste, Left/Right, Home/End, and customized keybindings. Enter keeps the filter, while Escape cancels the edit and restores the previous filter.
- Outside filter input, Escape returns from the narrow Preview first, then clears a kept filter before closing the inspector. Pending changes require explicit discard confirmation.
- On a selected file, Space or Shift+Space stages an include/exclude change, `r` restores the default **Included** state, and `u` undoes the latest state change. These shortcuts do nothing while Preview is focused.
- `?` opens a read-only guide to the two Context states.
- Ctrl+S writes and applies all pending changes without closing the inspector. The saved state becomes the new editing baseline, so more files can be adjusted immediately. No Pi reload is needed.

Every Context file is **Included** by default. An excluded file is a saved override; returning it to Included removes that override. Rows show `Included`, `Excluded`, or `Pending`, and the selected file shows its current state and whether it is using the default, a saved exclusion, a pending exclusion, or a pending reset.

Applied changes affect the next submitted prompt and persist across Pi sessions. State is stored in:

```text
~/.pi/agent/context-control.json
```

Files are identified by their canonical absolute paths, so instruction files with the same basename in different directories can be controlled independently.

## Limitations

Pi still discovers disabled files during startup, so its startup `[Context]` resource list may include them. This extension removes disabled files from the system prompt before each agent run; it does not change Pi's built-in resource discovery display.

If another extension rewrites Pi's generated `<project_context>` section before this extension runs, context filtering may not be applied and Pi shows a warning.

## License

MIT
