# browser-pilot

Give your AI agent control of your real browser — with your logins, cookies, and extensions intact. No extension needed.

```bash
npm install -g browser-pilot-cli
```

## Agent Setup

### 1. Enable Chrome remote debugging (one-time)

Open `chrome://inspect/#remote-debugging` in Chrome (144+) and click Allow. No command-line flags, no restart needed.

> Chrome 136 disabled the old `--remote-debugging-port` flag for security. Chrome 144 introduced this new UI toggle as the replacement — browser-pilot uses this.

Check every installed supported browser and its exact setup state with:

```bash
bp browsers
```

Use `bp connect --browser <id|product|channel>` for an explicit choice. Product
embedders can pass the same selector to `browser-pilot bridge --stdio
--browser <selector>`; otherwise selection follows a stable platform order.

### 2. Install the plugin for your agent

**Claude Code:**
```
/plugin marketplace add https://github.com/relixiaobo/browser-pilot.git
/plugin install browser-pilot@browser-pilot-marketplace
```

**Codex CLI:**
```bash
npx skills add relixiaobo/browser-pilot
```

**OpenClaw:**
```bash
cp -r plugin/skills/browser-pilot ~/.agents/skills/
```

**Cursor / VS Code Copilot:**
```bash
npx skills add relixiaobo/browser-pilot
```

### 3. Use it

Just tell your agent what you want to do:

- "Open GitHub and check my notifications"
- "Go to Hacker News and summarize the top 5 posts"
- "Fill out the form on this page"

The agent will use `bp` commands automatically. Your real login sessions are preserved — no need to re-authenticate.

## Why browser-pilot?

- **No extension required** — Uses Chrome 144's native remote debugging toggle, not the Extension Debugger API
- **Real login sessions** — Operates your actual browser profile. Cookies, extensions, logins all intact
- **CLI-native** — Any agent with bash access can use it. No MCP protocol, no SDK integration needed
- **Auto-snapshot** — Every action returns page state with numbered `[ref]` elements, so the agent always knows what's on screen
- **Lightweight npm install** — About 200KB as an npm tarball. No bundled Chromium (unlike Playwright's 400MB+)
- **Rich editor support** — Works with contenteditable editors (Draft.js, ProseMirror, Quill, Slate) and Shadow DOM elements out of the box

## Comparison

| | browser-pilot | Playwright MCP | Chrome DevTools MCP | browser-use |
|---|---|---|---|---|
| **Interface** | CLI (bash) | MCP protocol | MCP protocol | Python SDK |
| **Login session reuse** | Yes | No | Depends | Yes |
| **Extension required** | No | No | No | No |
| **Element refs** | Numbered (accessibility tree) | Named refs (ARIA) | CSS selectors | Numbered (DOM) |
| **Auto-snapshot after action** | Yes | Yes | No | Yes |
| **Network interception** | Yes (block/mock/headers) | Yes | Yes | No |
| **Multi-browser** | Chromium-only | Chromium + Firefox + WebKit | Chromium-only | Chromium-only |
| **Dialog handling** | Explicit | Automatic | Manual | Automatic |
| **JSON output** | Default | MCP structured | MCP structured | Python objects |
| **File upload** | Auto-detect input | Yes | No | Yes |

## How It Works

```
Agent (bash tool)
  │  bp open / bp click / bp eval ...
  ▼
CLI Process ──── HTTP/Unix Socket ──── Daemon Process (persistent)
                                           │
                                           │  WebSocket (CDP)
                                           ▼
                                       Chrome (your browser, your profile)
                                       ├── Your windows (untouched)
                                       └── Pilot window (agent operates here)
```

The Broker maintains the browser connection and isolated state for each Agent.
An independent private janitor owns only Browser Pilot-created tabs so it can
clean them after a Broker crash without touching user-opened tabs. A pulsing
blue glow around a Pilot window indicates Agent activity.

## Platform Evolution

Browser Pilot now routes direct `bp` commands and embedded clients through the
same Agent-neutral, multi-client Browser Broker.
The approved architecture and execution plans are:

- [Platform specification](docs/architecture/browser-pilot-platform-spec.md)
- [Universal Agent integration plan](docs/plans/universal-agent-integration.md)
- [Browser capability and reliability plan](docs/plans/browser-capability-evolution.md)
- [Stdio bridge integration contract](docs/integration/stdio-bridge.md)
- [Stdio black-box conformance suite](docs/integration/stdio-conformance.md)
- [Reference consumer adapters](https://github.com/relixiaobo/browser-pilot/tree/main/examples/adapters),
  including Tenon and OpenClaw lifecycle mappings

The public integration direction remains CLI-only: one-shot commands for direct
Agent use and a persistent `bridge --stdio` mode for products that embed the
official executable. Browser Pilot will not require an extension, Native SDK,
or MCP server. The repository's consumer adapters are source examples built
only on the stdio contract; they are intentionally excluded from the npm
package and do not create a second public library API.

The dedicated Pilot window remains the default managed tab set for independent
Agent work. The Broker architecture also includes all eligible user tabs in the
Agent's inventory without a separate grant step, so an Agent can operate a page
the user already opened. Invoking or exposing the tool is the authorization
boundary; products may apply their own approval UX or remove operations when
launching the bridge. Bulk cleanup remains limited to managed tabs, and user
tabs remain open when a session ends.

The `browser-pilot bridge --stdio` transport, Broker lifecycle, browser tool
dispatch, event replay, protected Artifacts, and protocol 1.1 transport limit
negotiation are implemented. Browser disconnect/reconnect handling, scoped
download Artifacts, Workspace resource isolation, and typed watchdog events for
stalled navigation, selected-frame detach, pending dialogs, and repeated
browser-observable no-progress actions are also implemented. An internal
managed-target janitor owns Broker-created tabs through a separate CDP
connection and closes only those tabs and their managed popup descendants if
the daemon exits or crashes; it does not persist target IDs or close user tabs.
Compatible Agent products reuse one per-user Broker through protocol
negotiation. Protected shutdown cannot terminate live embedded clients, and an
incompatible product must explicitly select a separate `BROWSER_PILOT_HOME`.
Global npm installation, local npm/npx use, and product-bundled absolute-path
launches are covered by distribution black-box tests. Native self-contained
release artifacts use one executable for the public CLI and its private Broker
and janitor roles, with no runtime download or system-Node fallback.

## Installation and Embedding

Agent-managed installation remains supported:

```bash
npm install -g browser-pilot-cli
bp tabs
```

A project can pin Browser Pilot locally and run the same CLI without a global
installation:

```bash
npm install --save-exact browser-pilot-cli@0.1.6
npx --no-install browser-pilot tabs
```

Agent products should pin either the npm package or a native archive from the
GitHub release. Launch an absolute path directly with `bridge --stdio`; do not
invoke a shell, import `src/*`, or depend on Broker locator/socket files. The
npm form launches `node_modules/browser-pilot-cli/dist/cli.js` with the
product's pinned Node runtime. The native archive launches its single
`browser-pilot` executable and does not require Node to be installed.

Each native archive contains `manifest.json`, per-file `SHA256SUMS`, licenses,
and an adjacent archive checksum. The manifest reports the actual signature
kind: Developer ID or ad-hoc on macOS, Authenticode or unsigned on Windows, and
unsigned on Linux. Release automation never labels an artifact signed when its
signing credentials were unavailable.

All three forms use the same protocol and compatible per-user Broker. Use a
distinct absolute `BROWSER_PILOT_HOME` only when a product deliberately needs
an incompatible isolated Broker.

## Commands

### Core Loop

| Command | Returns | Description |
|---------|---------|-------------|
| `bp open <url>` | snapshot | Navigate to URL |
| `bp snapshot` | snapshot | Get interactive elements |
| `bp click <ref>` | snapshot | Click element by ref number (`--double`, `--right`) |
| `bp click --xy x,y` | snapshot | Click at viewport coordinates (canvas, maps) |
| `bp locate <selector>` | coords | Get element center x,y + size (for `click --xy`) |
| `bp type <ref> <text>` | snapshot | Type into element (`--clear`, `--submit`) |
| `bp keyboard <text>` | snapshot | Type via keyboard events (`--click`, `--clear`) |
| `bp press <key>` | snapshot | Press key (Enter, Escape, Control+a, Meta+c) |
| `bp eval [js]` | value | Run JavaScript (escape hatch for anything) |

### Utilities

| Command | Description |
|---------|-------------|
| `bp screenshot [file]` | Capture screenshot (`--full`, `--selector`) |
| `bp pdf [file]` | Save page as PDF (`--landscape`) |
| `bp cookies [domain]` | View cookies (includes HttpOnly) |

### Edge Cases

| Command | Description |
|---------|-------------|
| `bp upload <filepath>` | Upload file (auto-finds `<input type="file">`) |
| `bp auth <user> <pass>` | Set HTTP Basic Auth credentials (`--clear`) |
| `bp frame [index]` | List or switch iframe context (0 = top) |
| `bp dialogs` | List pending JavaScript dialogs |
| `bp dialog <id> --accept\|--dismiss` | Explicitly respond to a dialog (`--prompt`) |

Dialogs remain pending until explicitly accepted or dismissed. One-shot CLI
dialogs are scoped to the compatibility Workspace and isolated from embedded
Broker clients.

Run `bp tabs` to list Pilot-managed tabs, their popups, and eligible tabs the
user opened elsewhere in the same browser. `bp tab <n>` switches control to any
listed tab.

### Network

| Command | Description |
|---------|-------------|
| `bp net` | List recent requests (`--url`, `--method`, `--status`, `--type`) |
| `bp net show <id>` | Full request/response details (`--save <file>`) |
| `bp net block <pattern>` | Block requests matching URL pattern |
| `bp net mock <pattern>` | Mock responses (`--body`, `--file`) |
| `bp net headers <pattern> <header...>` | Add/override request headers |
| `bp net rules` | List active interception rules |
| `bp net remove [id]` | Remove rule(s) (`--all`) |
| `bp net clear` | Clear captured request log |

### Session

| Command | Description |
|---------|-------------|
| `bp connect` | Connect to Chrome, create pilot window |
| `bp disconnect` | Close the CLI Pilot window; stop the daemon when no embedded client is live |
| `bp tabs` | List all controllable tabs in the current browser |
| `bp tab <n>` | Switch to any listed managed or user tab |
| `bp close` | Close the current tab (`--all` closes Pilot-managed tabs only) |

## Refs

Action commands return a snapshot of interactive elements, each with a `[ref]` number:

```
[1] link "Home"
[2] textbox "Search"                ← <input>, <textarea>, or contenteditable
[3] textbox ""                      ← unnamed input (still interactive)
[4] combobox ""                     ← <select> dropdown
[5] spinbutton "Quantity"           ← <input type="number">
[6] button "Submit"
[7] checkbox "Agree" checked
[8] slider "Volume"                 ← <input type="range">
```

Use the number in subsequent commands: `bp click 1`, `bp type 2 "hello"`.

Refs are scoped to the current page — they refresh automatically after every action. Elements inside Shadow DOM are included automatically.

Across one-shot CLI processes, active target, frame, and refs live only in the
daemon's keyed compatibility Workspace and renewable Lease. They are never
written to `state.json` or `refs.json`; after Lease expiry the Agent must
observe again. `bp disconnect` explicitly clears the compatibility Workspace.

## Output

**JSON by default** when piped (for LLM/script consumption). Human-readable when run in a terminal.

```json
{"ok":true, "title":"Example", "url":"https://example.com", "elements":[{"ref":1, "role":"link", "name":"More info"}]}
```

Errors include hints:
```json
{"ok":false, "error":"Ref [99] not found.", "hint":"Run 'bp snapshot' to refresh element refs."}
```

Force human output: `bp --human open https://example.com`

`bp screenshot [file]`, `bp pdf [file]`, and `bp net show <id> --save <file>`
return an absolute local path. Screenshot and PDF bytes are first protected
Artifacts, explicitly exported to that path, then released from Broker storage.
`bp upload <file>` similarly imports a protected copy and releases it after the
browser receives the file; the source file is never removed.

## Eval

`eval` is the escape hatch — anything JavaScript can do:

```bash
bp eval "history.back()"                            # go back
bp eval "history.forward()"                         # go forward
bp eval "location.reload()"                         # reload
bp eval "window.scrollBy(0, 500)"                   # scroll down
bp eval "document.querySelector('h1').textContent"   # extract text
bp eval "document.querySelector('div').innerHTML"    # extract HTML
bp eval "JSON.stringify(localStorage)"               # read storage
echo 'complex js here' | bp eval                    # stdin for complex JS
```

## File Upload

`bp upload` auto-detects `<input type="file">` on the page:

```bash
bp open https://images.google.com
bp click 5                        # click "Search by image"
bp upload ~/Downloads/photo.jpg    # auto-finds file input, triggers upload
```

## Rich Text Editors & Shadow DOM

`bp type` works with contenteditable-based editors (Draft.js, ProseMirror, Quill, Slate, Lexical). They appear as `textbox` in snapshots:

```bash
bp type 3 "new content" --clear     # replace content in a rich text editor
```

For canvas-based editors (Google Docs, Google Sheets, Figma), use `bp keyboard` which sends real keyboard events:

```bash
bp keyboard "Hello Docs!" --click ".kix-appview-editor"   # Google Docs
bp press Meta+b                                            # toggle bold
bp keyboard "bold text"
bp click --xy 400,300                                    # click canvas area
```

Shadow DOM elements are traversed automatically — no special commands needed. Elements inside open shadow roots (even deeply nested) appear in snapshots and can be clicked/typed normally.

For `<select>` dropdowns (shown as `combobox`), use `bp eval`:

```bash
bp eval 'document.querySelector("select").value = "opt2"; document.querySelector("select").dispatchEvent(new Event("change",{bubbles:true}))'
```

## Network Interception

Monitor, block, and mock HTTP requests:

```bash
# Monitor traffic
bp net                                 # list recent requests
bp net --url "*api*" --method POST     # filter by URL and method
bp net show 3                          # full details + response body

# Block requests
bp net block "*tracking*"              # block analytics/tracking
bp net block "*ads*"

# Mock API responses
bp net mock "*api/data*" --body '{"ok":true}'
bp net mock "*api/users*" --file mock.json

# Override request headers
bp net headers "*api*" "Authorization:Bearer test123"

# Manage rules
bp net rules                           # list active rules
bp net remove <id-from-bp-net-rules>   # rule IDs are opaque
bp net remove --all                    # clear all rules
bp net clear                           # clear captured request log
```

## Testing

Local release tests are deterministic. Real-site checks run separately as
non-blocking canaries so a third-party outage cannot fail the release gate:

```bash
npm test                         # unit + local core, compat, and network gates
npm run test:capabilities        # isolated-Chrome quantitative capability gate
npm run test:distribution        # packed global/local/product-bundled launch modes
npm run test:canary              # real-site drift report; non-blocking
npm run test:canary:strict       # fail on drift or unavailability
npm run test:integration         # compatibility alias for strict canaries
npm run test:all                 # release gates plus non-blocking canaries
```

Maintainers can build and verify a native artifact with an official,
SEA-capable Node 22.17.0 runtime:

```bash
BROWSER_PILOT_SEA_NODE=/absolute/path/to/node npm run build:standalone
npm run verify:standalone
npm run package:standalone
```

The canary report is written to
`test-results/real-site-canary/report.json`. It distinguishes semantic drift,
third-party unavailability, and runner errors. Set
`BROWSER_PILOT_CANARY_REPORT` to use another report path.

## Requirements

- Chrome 144+ / Edge / Brave (any Chromium-based browser)
- Node.js >= 18
- Remote debugging enabled (`chrome://inspect/#remote-debugging`)

## License

MIT
