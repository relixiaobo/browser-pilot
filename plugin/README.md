# browser-pilot plugin

Agent-neutral skill that teaches shell-capable AI agents to control eligible
tabs in your real Chrome browser through the `bp` CLI. Product-bundled and
Agent-installed CLIs use the same skill and command workflow.

## Install browser-pilot-cli first

```bash
npm install -g browser-pilot-cli@latest
bp --version
```

The bundled skill reads `compatibility.json`, accepts the declared compatible
CLI range, and rejects versions outside it. Each plugin release records the CLI
version it was tested with; embedded products should pin that exact version.
Native macOS releases support Apple Silicon only.

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
npx skills add relixiaobo/browser-pilot --skill browser-pilot
```

### Cursor / VS Code Copilot

```bash
npx skills add relixiaobo/browser-pilot --skill browser-pilot
```

### OpenClaw

Copy skills manually:

```bash
cp -r skills/browser-pilot ~/.agents/skills/
```

## What it does

After installation, your AI agent learns to use `bp` commands via bash:

- `bp open <url>` — navigate and get page snapshot
- `bp profiles` / `bp profiles --identify` / `bp profile <index>` — identify and route across live Chrome Profiles
- `bp click <ref>` — click elements by reference number
- `bp type <ref> "text"` — fill form fields
- `bp scroll` / `bp dropdown` / `bp select` — use verified page primitives
- `bp eval <js>` — escape hatch for missing operations
- `bp screenshot <file>` — capture the page to a local file
- `bp net` — monitor network requests

The agent uses your real browser with your existing login sessions. `bp tabs`
includes Browser Pilot managed tabs and eligible user-opened tabs; no extension
or separate browser profile is required. Dialogs remain pending until the Agent
explicitly accepts or dismisses them.

Give each independent Agent a stable `BROWSER_PILOT_CLIENT_KEY`. Products
should bundle the CLI, put it on the Agent command environment's `PATH`, and let
the Agent invoke it through its existing shell tool. See the skill's
`references/embedding.md`; no native tools, MCP server, SDK, or persistent
adapter are needed.

## Slash commands

- `/browser-pilot:browse <url>` — browse a website interactively
