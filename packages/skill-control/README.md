# @async23/pi-skill-control

A Pi extension for marking every Skill Pi has discovered as **Unblocked** or **Blocked**, while showing Pi's native invocation routes.

Pi remains responsible for discovery and invocation semantics: default directories, `settings.json`, packages, `--skill`, other extensions, and each Skill's `disable-model-invocation` frontmatter determine the candidate Skill set and its native availability. **Unblocked** means Skill Control adds no restriction and preserves Pi's native behavior; **Blocked** means Skill Control blocks both observable invocation routes. It does not add scan paths, edit `SKILL.md`, or override `disable-model-invocation`.

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

The inspector lists the Skills Pi discovered for the current session, groups them by their actual source, and previews each `SKILL.md` with theme-aware YAML frontmatter and Markdown highlighting. The selected file path remains visible in both wide and narrow layouts. A symlinked Skill shows both its lexical `Scanned` entry and canonical `Target`; a regular Skill shows a single `Path`.

The Source strip recognizes `.agents`, Pi, Claude, Codex, OpenCode, Gemini, Antigravity, Cursor, Trae, Grok, and Kimi Code. Zed is also counted because it consumes `.agents` rather than owning a separate Skill root. Sources with discovered Skills stay in their stable order, while known tools with no distinct candidate collapse into a dimmed `N empty sources` summary. An empty source commonly means the tool reuses `.agents`, has no Skill in its independent root, points to the same file through a symlink, or lost a same-name collision; it does not imply that Pi skipped the configured directory.

In `ALL`, the Skill list remains grouped by its actual source. In a specific Source filter, the same list is grouped by Pi's configuration scope: **Global** (`user`), **Project**, then **Temporary**. Group headings stay at the top level while their Skill rows are indented beneath them. Groups start expanded, show `▾` or `▸`, and can be selected and folded for the lifetime of the inspector. Filtering temporarily expands groups that contain matches without changing their saved fold state, and a long scrolled list keeps the current group heading visible.

- Up/Down or `j`/`k` selects a group heading or Skill while Skills is focused and scrolls while Preview is focused.
- Space or Enter folds or unfolds a selected group heading. On narrow terminals, Enter opens Preview for a selected Skill.
- On a selected group heading, Left or `h` collapses the group and Right or `l` expands it. On a selected Skill, Left/Right or `h`/`l` cycles focus between Skills and Preview. Moving past either end wraps to the other pane; Tab remains an alternative on wide terminals.
- `[`/`]` cycles backward/forward through source filters that contain discovered Skills. Empty known-tool entries remain visible in the summary but are skipped while cycling. Moving past either end wraps around.
- `/` enters filter input from either pane; it is a trigger, not part of the displayed query. Filtering mirrors Codex CLI: it matches only Skill names with a case-insensitive subsequence fuzzy match, ranks tighter and leading matches first, and does not search descriptions, sources, or paths.
- Filter input uses Pi's native single-line editor, including Unicode/IME cursor positioning, paste, Left/Right, Home/End, and customized keybindings. Defaults include Backspace or Ctrl+H to delete a character, Ctrl+W to delete a word, and Ctrl+U to delete to the start.
- While filter input is active, printable characters—including `h`, `j`, `k`, `l`, `[`, `]`, Space, and `?`—edit the query. Up/Down navigates results, Enter keeps the filter, and Escape cancels the edit and restores the previous filter.
- Outside filter input, Escape returns from the narrow Preview first, then clears a kept filter before closing the inspector. Pending policy changes still require explicit discard confirmation.
- On a selected Skill, Space toggles between **Unblocked** and **Blocked**. `r` unblocks the selected Skill, and `u` undoes the latest policy change.
- `?` opens a read-only guide to native availability and the blocking policy.
- Ctrl+S writes and applies all pending changes without closing the inspector; the saved state becomes the new editing baseline, so you can continue adjusting other Skills. No Pi reload is needed.

### Native availability and policy

Pi defines the native invocation routes of every discovered Skill:

| Native availability | Model sees the Skill | `/skill:name` is shown and accepted |
| --- | --- | --- |
| **Model + /skill** | Yes | Yes |
| **/skill only** | No | Yes |

`disable-model-invocation: true` produces **/skill only**; otherwise Pi uses **Model + /skill**. Skill Control displays this native information but does not edit or override it.

Skill Control adds one binary policy:

| Policy | Effective behavior |
| --- | --- |
| **Unblocked** | Add no restriction; preserve Pi's native **Model + /skill** or **/skill only** availability |
| **Blocked** | Hide the Skill from the model and block direct `/skill:name` invocation |

Skill rows keep the two dimensions visually independent. A normal **Model + /skill** Skill has no native marker; a native **/skill only** Skill shows a user marker. A saved **Blocked** policy shows `⊘` in the same left-side status area, after the user marker when both apply, while an unsaved edit shows `Unsaved` on the right. The preview still spells out native availability, effective availability, and policy. Changes remain pending until Ctrl+S; saving keeps the inspector open and starts a fresh undo history from the new baseline. Policy shortcuts do nothing while Preview is focused.

The inspector header is Source-first. The active Source keeps its brackets, empty Sources stay aggregated, and the filter prompt shares a row with the `[/] source` hint. Native availability and policy move into the **Skills** divider as a compact live summary: `Skills <visible> · model <model-visible> · <user marker> <command-only> · ⊘ <blocked>`. A pending policy change adds `△ <pending>`. Text filtering updates these counts to describe the Skills currently shown, while the **Skills** and **Preview** divider labels continue to show keyboard focus.

The user marker is Font Awesome `user` (`U+F007`) when Nerd Font support is detected, otherwise `ⓤ` (`U+24E4`). Detection checks `PI_SKILL_CONTROL_NERD_FONT`, Ghostty's effective font configuration, then `fontconfig` support for `U+F007`. Set `PI_SKILL_CONTROL_NERD_FONT=1` or `0` before starting Pi to override automatic detection.

## Configuration

User policy:

```text
~/.pi/agent/skill-control.json
```

Version 5 stores blocked canonical `SKILL.md` paths:

```json
{
  "version": 5,
  "blockedPaths": [
    "/absolute/path/to/example/SKILL.md"
  ]
}
```

Project-local `.pi/skill-control.json` files are not read or modified. Existing files are left untouched.

Version 1, 2, and 4 `disabledPaths` entries migrate directly to `blockedPaths`. Version 3 invocation overrides that removed either route migrate conservatively to **Blocked**; fully open overrides migrate to **Unblocked**. Migration is written immediately in version 5 format. The old `discover` setting is no longer used; configure additional Skill paths through Pi's native `skills` setting instead. For the supported tool roots on macOS/Linux:

```json
{
  "skills": [
    "~/.pi/agent/skills",
    "~/.agents/skills",
    "~/.codex/skills",
    "~/.claude/skills",
    "~/.config/opencode/skills",
    "~/.gemini/config/skills",
    "~/.cursor/skills",
    "~/.trae/skills",
    "~/.grok/skills",
    "~/.kimi-code/skills"
  ]
}
```

Pi already scans `~/.pi/agent/skills` and `~/.agents/skills`; the example repeats them to make their precedence explicit. In this layout, Gemini CLI and Zed use the shared `.agents` root, while Antigravity uses `~/.gemini/config/skills`. Kimi Code reads both `.agents/skills` and its independent global `~/.kimi-code/skills` / project `.kimi-code/skills` roots; shared Skills remain labeled `.agents`, while independent Skills are labeled `Kimi Code`. Add `~/.gemini/skills` only when that separate Gemini directory exists. The source classifier preserves the lexical discovery path, so a Skill loaded through a tool-specific symlink is labeled with that tool while policy continues to use the canonical file path.

When source ownership matters, explicitly placing `~/.pi/agent/skills` and `~/.agents/skills` first in the array keeps their Skills ahead of tool-specific symlink aliases and same-name copies. Pi still deduplicates by canonical file path and keeps the first Skill for a name collision.

## Enforcement

Pi does not expose a per-Skill enable/disable API. Pi's resource configuration remains the discovery authority, and **Unblocked** is not an active enable operation—it only means this extension is not blocking the Skill. For temporary `--skill` entries and Skills injected by other extensions, stock Pi also does not expose a resource-removal hook. This package therefore enforces **Blocked** through extension hooks at the observable entry points:

- Blocked Skills are removed from `<available_skills>` when Pi would normally show them.
- Blocked Skills are removed from slash-command autocomplete.
- A manually typed `/skill:name` invocation for a blocked Skill is intercepted before expansion.

The underlying Skill file is never modified or deleted.

## License

MIT
