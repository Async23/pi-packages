# Async23 Pi Packages

A monorepo of independently installable packages for the [Pi coding agent](https://pi.dev).

## Packages

| Package | Description |
| --- | --- |
| [`@async23/pi-codex-fast`](./packages/codex-fast) | Toggle OpenAI Codex Fast mode with `/fast` |
| [`@async23/pi-context-control`](./packages/context-control) | Enable or disable Context instruction files with `/context` |

## Development

Test a package directly from the repository:

```bash
pi --no-extensions -e ./packages/codex-fast
pi --no-extensions -e ./packages/context-control
```

Inspect the files that would be published:

```bash
npm pack --workspace packages/codex-fast --dry-run
npm pack --workspace packages/context-control --dry-run
```

## License

[MIT](./LICENSE)
