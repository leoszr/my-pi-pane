![pi-pane preview](.github/assets/preview.png)

<div align="center">

UI extension for [pi](https://pi.dev/), the AI coding agent by [Mario Zechner](https://github.com/badlogic) and [Earendil](https://earendil.com).

</div>

## Features

<details>
  <summary>·· Preview (Expand)</summary>
  <video src="https://github.com/user-attachments/assets/e2029328-c352-4f7d-b0a8-6ff8bae524c4" controls></video>
</details>

- **Custom header** — animated logo with aligned, compact startup sections
- **Version check** — local vs latest pi version on startup
- **Origin prefixes** — `git:` / `npm:` source tags on extensions and skills
- **Framed editor** — bordered input with `pi` prefix and panel background
- **Response time** — per-message timing on user messages
- **Usage footer** — subscription usage slot plus context meter, with safe unknown fallback
- **Silent tools** — tool output hidden from chat, replaced by compact status pills
- **Quit guard** — double-press to exit, single press clears input
- **Stable layout** — consistent width during LLM streaming
- **Theme-aware** — colors resolve from the active pi theme

## Requirements

- [pi](https://pi.dev/) **≤ v0.67.68**
- Terminal with [**24-bit truecolor**](#faq) support

## Install Extension

Install as a pi package:

```bash
pi install git:github.com/visua1hue/pi-pane
```

Try without installing:

```bash
pi -e git:github.com/visua1hue/pi-pane
```

## Local Development

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-pane/src/index.ts"]
}
```

TypeScript is transpiled on the fly — no build step required.

### Usage data

pi-pane first tries the Codex subscription usage endpoint used by Codex CLI: `https://chatgpt.com/backend-api/codex/usage`. It reads your local Codex OAuth file at `~/.codex/auth.json`, fetches the rolling 5h and 7d usage percentages, and refreshes the footer cache in the background. No token is printed or stored by pi-pane.

If you already run `codex-cli-usage daemon`, pi-pane can also read its cache at `~/.codex/usage-limits.json`.

If the API/cache is unavailable, pi-pane falls back to a local estimate: it scans recent `~/.pi/agent/sessions/**/*.jsonl` activity and estimates the rolling 5h usage window. This is only a fallback, not an official provider quota API.

For exact values, override with env vars:

```bash
PI_PANE_USAGE_PLAN=Pro
PI_PANE_USAGE_USED=3.1h
PI_PANE_USAGE_LIMIT=5h
PI_PANE_USAGE_RESET_IN=1h18m
```

Local estimation can be disabled with `PI_PANE_USAGE_LOCAL=0`; then the footer falls back to `◆ Usage unavailable` unless env/file data is provided.

Disable the Codex API fetch with `PI_PANE_CODEX_USAGE_API=0`. Use a custom auth file with `PI_PANE_CODEX_AUTH_FILE=/path/to/auth.json`.

## FAQ

**The intention behind pi-pane?**

Evolved from a prototype exploring pi and [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui).

**Which terminals are supported?**

pi-pane requires 24-bit truecolor ANSI. To verify, run:

```bash
printf '\x1b[38;2;255;100;0mTRUECOLOR\x1b[0m\n'
```

If you see orange text, you're good. macOS Terminal.app, PuTTY, and the Linux TTY console lack truecolor support and will render incorrectly — use iTerm2, Ghostty, WezTerm, Kitty, Alacritty, Windows Terminal, or VS Code's integrated terminal instead.

## License

[MIT](LICENSE)
