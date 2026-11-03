# pi-gentle-shell-ollama-cloud-subscription

Shows your **Ollama Cloud** subscription usage in Gentle Shell's sidebar
**Status card** (the "Integrations" group), refreshes it on a timer, and lets
you turn it on or off with `/ollama-cloud`.

It uses Ollama Cloud's documented **`GET /api/balance`** endpoint with your
Bearer API key — no browser cookie and no local Ollama server.

```
Ollama 5h 13% · 7d 23%          ← compact status line
Ollama session 13% (2h 5m) · weekly 23% (6d 3h)   ← long form
```

- `5h` / `7d` / `30d` map to the session, weekly, and monthly windows.
- Percentages are **used**, converted from the API's `remaining_percent`.

## Requirements

- Pi (Gentle Shell) with Node ≥ 22.6.
- An Ollama Cloud account. The API key is read from Pi's own credential store
  (`/login` → **Ollama Cloud**), the `OLLAMA_API_KEY` environment variable, or
  this extension's config file.

## Install

Symlink this repository into Pi's agent directory so Pi discovers it as a loose
extension:

```bash
# Gentle Shell isolated home (the default)
PI_CODING_AGENT_DIR=~/.gentle-shell/agent node scripts/install.mjs

# ordinary Pi home
node scripts/install.mjs
```

Restart Gentle Shell. Run `/ollama-cloud` to open the panel, or `/ollama-cloud
on|off|refresh|reset` for quick control.

## Credential sources (checked in order)

1. `OLLAMA_API_KEY` (or `OLLAMA_CLOUD_API_KEY`) environment variable
2. `apiKey` in `<agent-dir>/ollama-cloud-status.json`
3. `<agent-dir>/auth.json` → `ollama-cloud.key` (written by `/login`)

The key never lives in this repository.

## Config

`<agent-dir>/ollama-cloud-status.json`:

```json
{
  "version": 1,
  "enabled": true,
  "compact": true,
  "refreshSeconds": 300,
  "apiKey": "optional-override"
}
```

`compact` shows one line with percentages only; the long form adds reset
countdowns. `refreshSeconds` is clamped to 60–3600.

## Development

```bash
node --no-warnings --experimental-strip-types --test test/*.test.ts
node scripts/smoke.mjs   # prints the live status line (never the key)
```
