# @async23/pi-skill-control

A Pi extension for interactively enabling or disabling loaded skills so they are excluded from the system prompt's `<available_skills>` section.

This package **toggles already-discovered skills**. It does not unload skills from Pi's discovery pipeline, and `/skill:name` remains available for disabled skills.

## Install

```bash
pi install npm:@async23/pi-skill-control
```

Restart Pi after installation, or run `/reload` in an existing session.

For local development from this repository:

```bash
pi --no-extensions -e ./packages/skill-control
```

## Usage

Run:

```text
/skills
```

The Skills inspector lists skills discovered for the current session, groups them by source (Agents / Pi / Claude / Codex / Package / …), and previews each `SKILL.md`.

- Use Up/Down to select skills or scroll the focused preview.
- Press Space to include or exclude the selected skill from the next model prompt.
- Use Left/Right to switch provider tabs. Filters are grouped as `Scope`, `User`, `Project`, and `Other`, and navigation follows that visual order. Every source remains visible (`ALL`, `Agents`, `Pi`, `Claude`, `Codex`, `OpenCode`, `Package`, …). Native or enabled sources with no loaded skills show `0`; external sources whose automatic discovery is disabled show `off`.
- Badges:
  - **Model** — included in `<available_skills>`
  - **Manual** — `disable-model-invocation: true`; only `/skill:name`
  - **Excluded** — turned off by this extension
- Press Enter to open the preview on narrow terminals.
- Press Tab to switch between the skill list and preview on wide terminals.
- Type while the skill list is focused to search by name, description, source, or path.
- Press Escape to return from a narrow preview or close the inspector.

Changes apply to the next submitted prompt and persist across Pi sessions.

## Extra discovery (optional)

Pi already discovers `~/.pi/agent/skills`, `~/.agents/skills`, project skills, and package skills.

This extension can **append** more directories via `resources_discover`. All extra sources default to **off**. The inspector reports this package-owned setting as `Extra scan`; it is separate from Pi's built-in discovery.

Edit:

```text
~/.pi/agent/skill-control.json
```

Example:

```json
{
  "version": 2,
  "disabledPaths": [],
  "discover": {
    "claudeUser": true,
    "codexUser": true,
    "opencodeUser": false,
    "claudeProject": false,
    "codexProject": false,
    "customPaths": []
  }
}
```

| Key | Path |
| --- | --- |
| `claudeUser` | `~/.claude/skills` |
| `codexUser` | `~/.codex/skills` |
| `opencodeUser` | `~/.config/opencode/skills` |
| `claudeProject` | `<cwd>/.claude/skills` |
| `codexProject` | `<cwd>/.codex/skills` |
| `customPaths` | Extra absolute/`~/`/cwd-relative paths |

After changing `discover`, run `/reload` (or restart Pi).

Disabled skills are stored under `disabledPaths` as canonical absolute `SKILL.md` paths.

## Limitations

- This extension removes disabled skills from the system prompt before each agent run. It does **not** change Pi's startup skill list or unregister `/skill:name`.
- Extra discovery only **adds** paths. It cannot stop Pi from scanning its built-in locations.
- If another extension rewrites Pi's `<available_skills>` section first, filtering may fail and Pi shows a warning.

## License

MIT
