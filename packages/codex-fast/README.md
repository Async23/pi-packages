# @async23/pi-codex-fast

A Pi extension that toggles OpenAI Codex Fast mode by setting `service_tier` to `priority` on Codex requests.

## Install

```bash
pi install npm:@async23/pi-codex-fast
```

Restart Pi after installation, or run `/reload` in an existing session.

## Usage

```text
/fast    Toggle Fast mode on or off
```

The command does not accept arguments.

When enabled with an `openai-codex` model, the extension adds:

```json
{
  "service_tier": "priority"
}
```

Fast mode is stored globally in `codex-fast.json` under Pi's agent configuration directory (normally `~/.pi/agent/codex-fast.json`). It persists across projects, sessions, reloads, resumes, and Pi restarts.

Each running Pi instance reads the global state when its session starts. `/fast` updates the current instance and writes the new global state. Other Pi instances that are already running keep their in-memory state until their session restarts, `/reload` runs, or Pi restarts.

If another provider is selected, the footer shows a dim, struck-through `fast`; Fast mode takes effect again after selecting an `openai-codex` model.

## Usage warning

Fast mode consumes Codex credits at a higher rate than Standard mode.

## License

MIT
