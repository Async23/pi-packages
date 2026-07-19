# Async23 Pi Packages

A monorepo of independently installable packages for the [Pi coding agent](https://pi.dev).

## Packages

| Package | Description |
| --- | --- |
| [`@async23/pi-codex-fast`](./packages/codex-fast) | Toggle OpenAI Codex Fast mode with `/fast` |

## Development

Test a package directly from the repository:

```bash
pi --no-extensions -e ./packages/codex-fast
```

Inspect the files that would be published:

```bash
npm pack --workspace packages/codex-fast --dry-run
```

## License

[MIT](./LICENSE)
