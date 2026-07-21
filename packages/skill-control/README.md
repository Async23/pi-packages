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

The inspector lists the Skills Pi discovered for the current session, groups them by their actual source, and previews each `SKILL.md`.

- Up/Down selects a Skill or scrolls the focused preview.
- Left/Right switches between source filters that actually contain discovered Skills.
- Tab switches between the Skill list and preview on wide terminals.
- Typing filters by name, description, source, or path; Backspace edits the filter.
- Space opens the access selector for the selected Skill.
- Ctrl+S writes and applies all pending changes; no Pi reload is needed.
- Escape closes the inspector. Pending changes require explicit discard confirmation.

### Access states

Model access and direct user access are independent:

| State | Model sees the Skill | `/skill:name` is shown and accepted |
| --- | --- | --- |
| **Model + User** | Yes | Yes |
| **Model only** | Yes | No |
| **User only** | No | Yes |
| **Neither** | No | No |

The inspector uses one Unicode symbol for each state: `●` Model + User, `◐` Model only, `◑` User only, and `○` Neither. `disable-model-invocation: true` maps to **User only** by default. An explicit policy can override that default in either direction.

Press Space, choose any of the four states in the Model/User permission matrix, then press Enter. While the selector is open, Tab switches where the choice is saved:

- **All projects** — applies everywhere for this user.
- **This project** — applies only in the current trusted project.
- **Use inherited access** — removes the saved choice at that scope.

Effective policy precedence is:

```text
This project > All projects > Skill frontmatter default
```

## Configuration

Global policy:

```text
~/.pi/agent/skill-control.json
```

Project policy:

```text
<cwd>/.pi/skill-control.json
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
