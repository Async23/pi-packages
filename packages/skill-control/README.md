# @async23/pi-skill-control

A Pi extension for controlling model visibility and direct `/skill:name` access for every Skill Pi has discovered.

Pi remains responsible for discovery: default directories, `settings.json`, packages, `--skill`, and other extensions determine the candidate Skill set. This package applies an access policy to those candidates; it does not add scan paths or edit Pi's resource settings.

## Install

```bash
pi install npm:@async23/pi-skill-control
```

Restart Pi after installation, or run `/reload` in an existing session to load the extension code.

For local development from this repository:

```bash
pi --no-extensions -e ./packages/skill-control
```

## Usage

Run:

```text
/skills
```

The inspector lists the Skills Pi discovered for the current session, groups them by their actual source, and previews each `SKILL.md` with theme-aware YAML frontmatter and Markdown highlighting. The selected file path remains visible in both wide and narrow layouts.

- Up/Down or `j`/`k` selects a Skill while Skills is focused and scrolls while Preview is focused.
- Left/Right or `h`/`l` cycles focus between Skills and Preview. Moving past either end wraps to the other pane; Tab remains an alternative on wide terminals.
- `[`/`]` cycles backward/forward through source filters that contain discovered Skills. Moving past either end wraps around.
- `/` enters filter input from either pane; it is a trigger, not part of the displayed query. Typing ranks exact, close, and fuzzy Skill-name matches first; descriptions, sources, and paths match contiguous text only.
- Filter input uses Pi's native single-line editor, including Unicode/IME cursor positioning, paste, Left/Right, Home/End, and customized keybindings. Defaults include Backspace or Ctrl+H to delete a character, Ctrl+W to delete a word, and Ctrl+U to delete to the start.
- While filter input is active, printable characters—including `h`, `j`, `k`, `l`, `[`, `]`, Space, and `?`—edit the query. Up/Down navigates results, Enter keeps the filter, and Escape cancels the edit and restores the previous filter.
- Outside filter input, Escape returns from the narrow Preview first, then clears a kept filter before closing the inspector. Pending access changes still require explicit discard confirmation.
- Space cycles access forward; Shift+Space cycles backward when the terminal reports shifted Space distinctly. `r` resets the selected Skill to its default, and `u` undoes the latest access change.
- `?` opens a read-only guide to the four access states.
- Ctrl+S writes and applies all pending changes; no Pi reload is needed.

### Access states

Model access and direct user access are independent:

| State | Model sees the Skill | `/skill:name` is shown and accepted |
| --- | --- | --- |
| **Model + User** | Yes | Yes |
| **Model only** | Yes | No |
| **User only** | No | Yes |
| **Neither** | No | No |

The inspector uses one Unicode symbol for each state: `●` Model + User, `◐` Model only, `◑` User only, and `○` Neither. Every row labels its policy status as `Default`, `Override`, or `Pending`. The selected Skill also shows its current access, frontmatter default, and whether it is using the default, a saved override, a pending override, or a pending reset. `disable-model-invocation: true` maps to **User only** by default. An explicit policy can override that default in either direction.

Press Space repeatedly to cycle **Model + User → Model only → User only → Neither**; Shift+Space cycles in reverse. Changes remain pending until Ctrl+S. When the cycle reaches the Skill's default state—or when `r` resets it—the saved override is removed automatically so the Skill follows its frontmatter again. `u` restores the previous pending access value. Access shortcuts do nothing while the preview is focused.

Effective policy precedence is:

```text
Saved setting > Skill frontmatter default
```

## Configuration

User policy:

```text
~/.pi/agent/skill-control.json
```

Version 3 stores explicit model/user permissions by canonical `SKILL.md` path:

```json
{
  "version": 3,
  "overrides": {
    "/absolute/path/to/example/SKILL.md": {
      "model": false,
      "user": true
    }
  }
}
```

Project-local `.pi/skill-control.json` files are not read or modified. Existing files are left untouched.

Version 1 and 2 `disabledPaths` entries are read as **Neither** and are written in version 3 format on the next Apply. The old `discover` setting is no longer used; configure additional Skill paths through Pi's native `skills` setting instead:

```json
{
  "skills": ["~/.claude/skills", "~/.codex/skills"]
}
```

## Enforcement

For Skills that Pi can remove through its own settings, Pi's resource configuration remains the discovery authority. For temporary `--skill` entries and Skills injected by other extensions, stock Pi does not expose a resource-removal hook. This package therefore enforces policy at the observable entry points:

- Model-off Skills are removed from `<available_skills>`.
- User-off Skills are removed from slash-command autocomplete.
- A manually typed user-off `/skill:name` invocation is intercepted before expansion.

The underlying Skill file is never modified or deleted.

## License

MIT
