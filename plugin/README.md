# browser-pilot plugin

Agent-neutral skill that teaches shell-capable AI agents to control eligible
tabs in your real Chrome browser through the `bp` CLI. It also includes a
separate decision guide for products embedding `browser-pilot bridge --stdio`.

## Install browser-pilot-cli first

```bash
npm install -g browser-pilot-cli
```

Enable Chrome remote debugging: open `chrome://inspect/#remote-debugging` and toggle ON.

## Install the plugin

### Claude Code

Add this repo as a marketplace and install:

```
/plugin marketplace add https://github.com/relixiaobo/browser-pilot.git
/plugin install browser-pilot@browser-pilot-marketplace
```

Or test locally:

```bash
claude --plugin-dir ./plugin
```

### Codex CLI

```bash
npx skills add relixiaobo/browser-pilot
```

### Cursor / VS Code Copilot

```bash
npx skills add relixiaobo/browser-pilot
```

### OpenClaw

Copy skills manually:

```bash
cp -r skills/browser-pilot ~/.agents/skills/
```

## What it does

After installation, your AI agent learns to use `bp` commands via bash:

- `bp open <url>` — navigate and get page snapshot
- `bp click <ref>` — click elements by reference number
- `bp type <ref> "text"` — fill form fields
- `bp eval <js>` — run JavaScript
- `bp screenshot <file>` — capture the page to a local file
- `bp net` — monitor network requests

The agent uses your real browser with your existing login sessions. `bp tabs`
includes Browser Pilot managed tabs and eligible user-opened tabs; no extension
or separate browser profile is required. Dialogs remain pending until the Agent
explicitly accepts or dismisses them.

## Slash commands

- `/browser-pilot:browse <url>` — browse a website interactively
