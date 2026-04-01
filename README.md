# browser-pilot

CLI tool that gives LLM agents control of your real browser — with your logins, cookies, and extensions intact.

```bash
bp open https://github.com       # navigate — returns interactive elements
bp click 3                        # click [3] — returns updated page
bp type 5 "hello" --submit        # type + Enter — returns updated page
bp eval "document.title"          # run any JavaScript
```

## Comparison

| | browser-pilot | Playwright MCP | Chrome DevTools MCP | browser-use |
|---|---|---|---|---|
| **Interface** | CLI (bash) | MCP protocol | MCP protocol | Python SDK |
| **Login session reuse** | Yes | No | Depends | Yes |
| **Element refs** | Numbered (accessibility tree) | Named refs (ARIA) | CSS selectors | Numbered (DOM) |
| **Auto-snapshot after action** | Yes | Yes | No | Yes |
| **Network interception** | Yes (block/mock/headers) | Yes | Yes | No |
| **Drag and drop** | No | Yes | Yes | No |
| **Mobile emulation** | No | Yes | Yes | Yes |
| **Multi-browser** | Chromium-only | Chromium + Firefox + WebKit | Chromium-only | Chromium-only |
| **Connection model** | Daemon (one-time Allow) | MCP server | MCP server | Python process |
| **Dialog auto-handling** | Yes | Yes | No | Yes |
| **JSON output** | Default | MCP structured | MCP structured | Python objects |
| **Visual indicator** | Pulsing glow | None | None | None |
| **File upload** | Auto-detect input | Yes | No | Yes |
| **Autonomous agent** | No (tool, not agent) | No (tool) | No (tool) | Yes (plans + executes) |

**browser-pilot is best when:**
- You need your existing login sessions (paywalled content, internal tools)
- Your LLM has bash access but no MCP support
- You want every action to return page state automatically

**Use Playwright MCP when:**
- You need multi-browser or mobile emulation
- Your LLM supports MCP natively
- You don't need existing login sessions

**Use browser-use when:**
- You want an autonomous agent that plans and executes multi-step tasks
- You're building in Python

## Quick Start

```bash
# Install
npm install -g browser-pilot

# Enable debugging in Chrome (one-time)
# Open chrome://inspect/#remote-debugging → toggle ON

# Connect (click Allow in Chrome's dialog)
bp connect

# Use
bp open https://github.com
bp click 3
bp type 5 "hello" --submit
bp eval "document.title"
bp screenshot page.png
bp disconnect
```

## How It Works

```
LLM (bash tool)
  │  bp open / bp click / bp eval ...
  ▼
CLI Process ──── HTTP/Unix Socket ──── Daemon Process (persistent)
                                           │
                                           │  WebSocket (CDP, one-time Allow)
                                           ▼
                                       Chrome (your browser, your profile)
                                       ├── Your windows (untouched)
                                       └── Pilot window (bp operates here)
```

The daemon maintains a single CDP WebSocket connection. Chrome's "Allow" dialog appears once per session. A pulsing blue glow around the Pilot window indicates the agent is active.

## Commands

Run `bp --help` for full details including workflow, refs, and eval examples.

### Core Loop

| Command | Returns | Description |
|---------|---------|-------------|
| `bp open <url>` | snapshot | Navigate to URL |
| `bp snapshot` | snapshot | Get interactive elements |
| `bp click <ref>` | snapshot | Click element by ref number |
| `bp type <ref> <text>` | snapshot | Type into element (`--clear`, `--submit`) |
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

Dialogs (`alert`/`confirm`/`prompt`) are auto-handled by the daemon.

Popup windows (target="_blank", window.open) are auto-detected. Run `bp tabs` to see and switch to them.

### Network

| Command | Description |
|---------|-------------|
| `bp net` | List recent requests (`--url`, `--method`, `--status`, `--type`) |
| `bp net show <id>` | Full request/response details (`--save <file>`) |
| `bp net block <pattern>` | Block requests matching URL pattern |
| `bp net mock <pattern>` | Mock responses (`--body`, `--file`, `--status`) |
| `bp net headers <pattern> <header...>` | Add/override request headers |
| `bp net rules` | List active interception rules |
| `bp net remove [id]` | Remove rule(s) (`--all`) |
| `bp net clear` | Clear captured request log |

### Session

| Command | Description |
|---------|-------------|
| `bp connect` | Connect to Chrome, create pilot window |
| `bp disconnect` | Close pilot window, stop daemon |
| `bp tabs` | List pilot tabs (auto-adopts popups) |
| `bp tab <n>` | Switch tab |
| `bp close` | Close current tab (`--all`) |

## Refs

Action commands return a snapshot of interactive elements, each with a `[ref]` number:

```
[1] link "Home"
[2] textbox "Search"
[3] button "Submit"
```

Use the number in subsequent commands: `bp click 1`, `bp type 2 "hello"`.

Refs are scoped to the current page — they refresh automatically after every action.

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
bp net mock "*api/users*" --file mock.json --status 200

# Override request headers
bp net headers "*api*" "Authorization:Bearer test123"

# Manage rules
bp net rules                           # list active rules
bp net remove 2                        # remove rule #2
bp net remove --all                    # clear all rules
bp net clear                           # clear captured request log
```

## Requirements

- Chrome / Chromium / Edge / Brave (any Chromium-based browser)
- Node.js >= 18
- Chrome remote debugging enabled (`chrome://inspect/#remote-debugging`)

## License

MIT
