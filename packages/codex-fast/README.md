# @async23/pi-codex-fast

A Pi extension that toggles OpenAI Codex Fast mode by setting `service_tier` to `priority` on Codex requests.

## Install

```bash
pi install npm:@async23/pi-codex-fast
```

Restart Pi after installation, or run `/reload` in an existing session.

## Usage

```text
/fast          Toggle Fast mode
/fast on       Enable Fast mode
/fast off      Disable Fast mode
/fast status   Show the current state
```

When enabled with an `openai-codex` model, the extension adds:

```json
{
  "service_tier": "priority"
}
```

Fast mode remains enabled for the current Pi session and survives session reload or resume. A new session starts with Fast mode disabled.

If another provider is selected, the footer shows `fast:inactive`; Fast mode takes effect again after selecting an `openai-codex` model.

## Usage warning

Fast mode consumes Codex credits at a higher rate than Standard mode.

## License

MIT
