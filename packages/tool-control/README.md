# @async23/pi-tool-control

A Pi extension for inspecting and controlling the Tools exposed to the LLM, with an independent selection for every Session Branch.

## Local development

This package has not been published from this repository. Run it directly:

```bash
pi --no-extensions -e ./packages/tool-control
```

Then open:

```text
/tools
```

Remove any other extension that registers `/tools` before installing this package persistently.

## Selection model

When the current Session Branch has no saved selection, `tool-control` preserves the active selection supplied by Pi at Extension startup. It captures the corresponding inactive Tool Names once for the Extension runtime, so visiting another branch cannot replace that baseline with the previous branch's state.

Once a branch has a saved selection, `tool-control` persists only the names of Tools explicitly made inactive:

- the inactive set belongs to the current Session Branch, not to a global config file;
- a saved empty inactive set explicitly means every registered Tool is active;
- a fork inherits the set at its fork point and then evolves independently from sibling branches;
- newly registered Tools are active because their names are absent from the inactive set;
- inactive Tool Names are retained while their Tools are missing or unavailable, so the preference survives later registration or reconnection;
- on Session startup and tree navigation, the active selection is restored as registered Tools minus inactive Tool Names.

Selection is applied through Pi's active Tool list; `tool-control` does not install an execution-time guard. If another Extension changes the active selection after branch restoration, the latest change wins. A Tool excluded by Pi's command-line configuration is not registered and cannot be forced active.

Opening `/tools` reads Pi's current active Tool list through `getActiveTools()` and has no selection side effects. Only Ctrl+S applies the staged selection through `setActiveTools()` and persists it as a custom session entry.

State is stored in versioned Pi custom session entries. Those entries do not participate in LLM context.

## Experience

The header shows the after-apply counts and the global Pending count:

```text
Tools 43  ·  ● 34  ·  ○ 9  ·  △ 2
```

Rows use a fixed-width state column, so every Tool Name remains aligned:

```text
    ●    read
    ○    web_search
    ●→○  write
    ○→●  mcp_search
```

- `●`: active now and after apply;
- `○`: inactive now and after apply;
- `●→○`: pending deactivation;
- `○→●`: pending activation.

The source tabs are `ALL`, Built-in, MCP, Extension, and SDK. `ALL` groups Built-in Tools together, MCP Tools under one-level `Agent / Server` headings, and other Tools by their Registrar. Groups start expanded and folding is kept only for the current panel lifetime.

The Details pane shows the complete definition available to the LLM: Tool Name, current/after state, Registrar, Provider, scope, source path, description, Parameters JSON Schema, and Prompt Guidelines.

Keyboard controls:

- Up/Down or `j`/`k`: select rows while Tools is focused, or scroll while Details is focused;
- Left/Right or `h`/`l`: fold/unfold a selected group, or switch focus for a selected Tool;
- `Tab`: switch panes in wide layouts;
- `[`/`]`: cycle non-empty source tabs; zero-count tabs remain visible but are skipped;
- `/`: filter by Tool Name only using a case-insensitive non-contiguous match;
- Space: stage a selected Tool's opposite state;
- `a` / `d`: stage activation/deactivation for one Tool or every currently visible Tool in a selected group;
- `u`: undo the latest single or grouped staging operation;
- Enter: fold a group or open Details;
- `?`: open the state guide;
- Ctrl+S: apply and persist every Pending change without closing the panel;
- Escape: return from narrow Details, clear a kept filter, or close; dirty state requires discard confirmation.

When a Tool Name filter is active, a group heading shows `(matching/total)` and `a`/`d` affects only the matching Tools. Pending changes made under other filters remain staged and Ctrl+S applies them all.

## MCP integration

`tool-control` optionally consumes the versioned MCP Tool Inventory snapshot published on Pi's Event Bus by a compatible `@async23/pi-mcp-control`. The inventory provides:

- the Agent and MCP Server behind each Pi Tool Name;
- whether that Tool is still available from the connected MCP runtime;
- the remote primitive kind and name.

This is a replace-all metadata contract and contains no MCP configuration, credentials, arguments, or Tool call data. No package is imported across the seam. `mcp-control` remains responsible for registering and activating its own Tools, so it also works when `tool-control` is absent.

When a compatible inventory arrives, `tool-control` starts from `pi.getActiveTools()` and only removes currently available MCP Tools that the current branch has saved as inactive. It never adds Tools or rebuilds non-MCP state, and it calls `pi.setActiveTools()` only when there is something to remove. Saved inactive names are retained while an MCP Tool is disconnected or absent from the inventory, so the preference is applied again after reconnection or a later catalog update.

Without compatible metadata, the panel remains usable and groups those Tools as ordinary Extension Tools. It cannot then distinguish a disconnected MCP Tool whose definition is still retained internally by Pi; current mcp-control and tool-control versions should therefore be used together.

## Verification

```bash
node --test packages/tool-control/tests/*.test.mjs
npm test
npm pack --workspace packages/tool-control --dry-run
```

## License

MIT
