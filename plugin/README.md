# browser-pilot plugin

Agent plugin that teaches AI coding agents (Claude Code, Codex, OpenClaw, Cursor, etc.) to control your real Chrome browser via the `bp` CLI.

## Install browser-pilot-cli first

```bash
npm install -g browser-pilot-cli
```

Enable Chrome remote debugging: open `chrome://inspect/#remote-debugging` and toggle ON.

## Install the plugin

### Claude Code

Add this repo as a marketplace and install:

```
/plugin marketplace add relixiaobo/browser-pilot
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
- `bp screenshot` — capture the page
- `bp net` — monitor network requests

The agent uses your real browser with your existing login sessions — no separate browser needed.

## Slash commands

- `/browser-pilot:browse <url>` — browse a website interactively
