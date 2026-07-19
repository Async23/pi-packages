# @async23/pi-context-control

A Pi extension for interactively enabling or disabling loaded Context instruction files such as `AGENTS.md` and `CLAUDE.md`.

## Install

```bash
pi install npm:@async23/pi-context-control
```

Restart Pi after installation, or run `/reload` in an existing session.

## Usage

Run:

```text
/context
```

The centered Context inspector lists the instruction files discovered by Pi for the current working directory and previews each file's complete contents.

- Use Up/Down to select files or scroll the focused preview.
- Press Space to include or exclude the selected file.
- Press Enter to open the preview on narrow terminals.
- Press Tab to switch between the file list and preview on wide terminals.
- Use Page Up/Page Down, Home, or End to navigate long files.
- Type while the file list is focused to search by path.
- Press Escape to return from a narrow preview or close the inspector.

Changes apply to the next submitted prompt and persist across Pi sessions. State is stored in:

```text
~/.pi/agent/context-control.json
```

Files are identified by their canonical absolute paths, so instruction files with the same basename in different directories can be controlled independently.

## Limitations

Pi still discovers disabled files during startup, so its startup `[Context]` resource list may include them. This extension removes disabled files from the system prompt before each agent run; it does not change Pi's built-in resource discovery display.

If another extension rewrites Pi's generated `<project_context>` section before this extension runs, context filtering may not be applied and Pi shows a warning.

## License

MIT
