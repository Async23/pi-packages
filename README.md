# Async23 Pi Packages

A monorepo of independently installable packages for the [Pi coding agent](https://pi.dev).

## Packages

| Package | Description |
| --- | --- |
| [`@async23/pi-codex-fast`](./packages/codex-fast) | Toggle OpenAI Codex Fast mode with `/fast` |
| [`@async23/pi-context-control`](./packages/context-control) | Enable or disable Context instruction files with `/context` |
| [`@async23/pi-skill-control`](./packages/skill-control) | Show native Skill availability and block or unblock discovered Skills |
| [`@async23/pi-mcp-control`](./packages/mcp-control) | Manage Agent-scoped MCP configs, connections, tools, resources, and prompts with `/mcp` |
| [`@async23/pi-tool-control`](./packages/tool-control) | Inspect and control the LLM Tool selection per Session Branch with `/tools` |
| [`@async23/pi-sessions-studio`](./packages/pi-sessions-studio) | Local session observability workbench with `/studio` |
| [`@async23/pi-notify`](./packages/notify) | Native macOS completion notifications with Ghostty/tmux click-to-focus |
| [`@async23/pi-tmux-window-wrap`](./packages/tmux-window-wrap) | Report Pi agent activity to aipane's tmux status indicator |

## Development

Test a package directly from the repository:

```bash
pi --no-extensions -e ./packages/codex-fast
pi --no-extensions -e ./packages/context-control
pi --no-extensions -e ./packages/skill-control
pi --no-extensions -e ./packages/mcp-control
pi --no-extensions -e ./packages/tool-control
pi --no-extensions -e ./packages/pi-sessions-studio
pi --no-extensions -e ./packages/notify
pi --no-extensions -e ./packages/tmux-window-wrap
```

Inspect the files that would be published:

```bash
npm pack --workspace packages/codex-fast --dry-run
npm pack --workspace packages/context-control --dry-run
npm pack --workspace packages/skill-control --dry-run
npm pack --workspace packages/mcp-control --dry-run
npm pack --workspace packages/tool-control --dry-run
npm pack --workspace packages/pi-sessions-studio --dry-run
npm pack --workspace packages/notify --dry-run
npm pack --workspace packages/tmux-window-wrap --dry-run
```

Run package tests:

```bash
npm test
```

## License

[MIT](./LICENSE)
