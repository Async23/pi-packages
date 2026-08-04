# @async23/pi-mcp-control

A Pi extension for discovering, editing, connecting, and inspecting MCP servers without losing their Agent-specific configuration identity.

`/mcp` follows the interaction style of `@async23/pi-skill-control`: every known Agent stays visible as a tab, non-empty tabs appear first, zero-count tabs remain dimmed, and `ALL` stays grouped by the actual Agent. A server named `github` in Claude, Codex, and Cursor is always shown as three independent source entries. It is never flattened or deduplicated by name, command, or URL.

## Local development

This package has not been published from this repository. Run it directly:

```bash
pi --no-extensions -e ./packages/mcp-control
```

Then open:

```text
/mcp
```

## Experience

The panel shows:

- `ALL`, `.agents`, Pi, Claude, Codex, OpenCode, Gemini, Antigravity, Cursor, Trae, Grok, Kimi Code, and Zed tabs in the same baseline order as `pi-skill-control`;
- Global / Project / Temporary groups inside one Agent tab;
- exact source file and JSON Pointer or TOML table identity;
- transport, masked environment/header names, effective-source state, connection state, and primitive counts;
- redacted source configuration in the preview;
- separate connection runtimes for every effective Agent/server instance.

Keyboard controls:

- Left/Right or `h`/`l`: switch focus between the MCP list and Details (`Tab` also cycles focus in wide layouts);
- Up/Down or `j`/`k`: select in the MCP list, or scroll Details when the preview is focused;
- Page Up/Page Down: move through the list or scroll Details by one page;
- `[`/`]`: previous/next Agent tab;
- Enter or `c`: connect or disconnect the selected effective server;
- `a`: add a server to the selected Agent's Global or Project source;
- `e`: edit transport fields, enablement, or one top-level field;
- `d`: delete the selected source entry;
- `p`: explicitly invoke a connected server prompt;
- `r`: rescan source files;
- `/`: filter;
- Escape: close.

Connecting is deliberately explicit in this version: opening `/mcp` never starts commands or contacts remote endpoints. After a connection succeeds, MCP tools are registered in Pi with stable Agent/server-qualified names. Resources receive a server-qualified read tool. Prompts remain user-controlled and are invoked with `p` from the panel rather than exposed as model-controlled tools.

## Configuration sources

| Agent tab | Discovered sources | Write support |
| --- | --- | --- |
| Pi | `~/.pi/agent/mcp.json`, `<project>/.pi/mcp.json` | Yes |
| Claude | `~/.claude.json` user/local entries, `<project>/.mcp.json`, Claude Desktop local config | Yes |
| Codex | `~/.codex/config.toml` and every applicable project `.codex/config.toml` | Yes |
| OpenCode | user/project `opencode.json` or `opencode.jsonc` | Yes |
| Gemini | `~/.gemini/settings.json`, `<project>/.gemini/settings.json` | Yes |
| Cursor | `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json` | Yes |
| Kimi Code | `$KIMI_CODE_HOME/mcp.json` or `~/.kimi-code/mcp.json`, `<project>/.kimi-code/mcp.json` | Yes |
| Zed | user/project `settings.json` `context_servers` | Read-only |
| `.agents`, Antigravity, Trae, Grok | Tab retained; no verified local MCP configuration contract | No guessed path |

Claude's known precedence is retained (`local > project > user`). Gemini, Kimi Code, OpenCode, and Pi use whole-record project-over-user resolution. Codex uses a deep-merged effective entry and keeps every contributing origin visible. Cursor, Claude Desktop, and Zed sources remain independent where an authoritative collision rule is unavailable; the extension does not invent a winner.

Project-level MCP files are neither read nor writable until Pi reports the current project as trusted. Global sources remain available in an untrusted project.

## Safe writes

Every mutation is planned against one exact source identity and shows a redacted before/after diff. Commit then:

1. rechecks the source file hash to detect concurrent edits;
2. creates a timestamped backup when the file already exists;
3. writes a same-directory temporary file with restricted permissions;
4. flushes and atomically renames it into place.

JSON/JSONC uses structural edits so comments and unrelated fields survive. Codex TOML replaces only the selected `mcp_servers.<name>` table and its child tables, preserving unrelated sections and comments. Field edits start from the original unredacted entry internally, so masked secrets and unknown fields are not replaced by placeholder text. Symlink targets and non-regular files are rejected for writes.

Environment values, HTTP header values, credential-like fields, CLI arguments, URL credentials, query strings, and fragments are masked before reaching the panel, change preview, or diagnostics. The extension never copies OAuth sessions from another Agent.

## MCP runtime

The runtime uses the official `@modelcontextprotocol/client` v2 client with automatic modern/legacy negotiation. It supports:

- stdio, Streamable HTTP, and explicitly configured legacy SSE transports;
- paginated tools, resources, resource templates, and prompts;
- text/image content plus explicit lowering notices for audio, links, and binary embedded resources;
- structured tool content and MCP tool-level `isError` results;
- request cancellation and bounded request/list timeouts;
- configured static headers, environment-backed Codex headers, and bearer-token environment variables.

An HTTP authentication challenge is surfaced as `Authentication required`; this version does not launch an interactive OAuth browser flow. Activation persistence, reconnect policy, and per-tool approval policy are intentionally isolated behind runtime/policy seams for the later decisions requested for those behaviors.

## Verification

```bash
node --test packages/mcp-control/tests/*.test.mjs
npm test
npm pack --workspace packages/mcp-control --dry-run
```

## License

MIT
