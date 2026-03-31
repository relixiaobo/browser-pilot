# browser-pilot

CLI tool that controls your real browser. Uses your logged-in sessions, cookies, and extensions — no separate browser instance needed. Designed for LLM agents.

## Why

Browser automation tools typically launch a clean, isolated browser. But you're already logged into dozens of sites. `browser-pilot` connects to **your running Chrome** via CDP and operates in a **separate window**, so it can:

- Access content behind login walls and paywalls
- Use your existing cookies and sessions
- Work with your extensions (password managers, ad blockers, etc.)
- Never interfere with your browsing

## Quick Start

```bash
# Install
npm install -g browser-pilot

# Enable debugging in Chrome (one-time)
# Open chrome://inspect/#remote-debugging → toggle ON

# Connect (click Allow in Chrome's dialog)
bp connect

# Use
bp open https://github.com       # navigate — returns interactive elements
bp click 3                        # click element [3] — returns updated page
bp type 5 "hello" --submit        # type into element [5], press Enter
bp eval "document.title"          # run any JavaScript
bp screenshot page.png            # capture screenshot
bp disconnect                     # done
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

The daemon maintains a single CDP WebSocket connection. Chrome's "Allow" dialog appears once per session. All CLI commands go through the daemon — no repeated auth prompts.

## Commands

14 commands. Run `bp --help` for full details including workflow, refs, and eval examples.

### Core Loop

| Command | Returns | Description |
|---------|---------|-------------|
| `bp open <url>` | snapshot | Navigate to URL |
| `bp snapshot` | snapshot | Get interactive elements |
| `bp click <ref>` | snapshot | Click element by ref number |
| `bp type <ref> <text>` | snapshot | Type into element |
| `bp press <key>` | snapshot | Press key (Enter, Escape, Control+a) |
| `bp eval [js]` | value | Run JavaScript (escape hatch for anything) |

### Utilities

| Command | Description |
|---------|-------------|
| `bp screenshot [file]` | Capture screenshot (`--full`, `--selector`) |
| `bp pdf [file]` | Save page as PDF |
| `bp cookies [domain]` | View cookies (includes HttpOnly) |

### Session

| Command | Description |
|---------|-------------|
| `bp connect` | Connect to Chrome, create pilot window |
| `bp disconnect` | Close pilot window, stop daemon |
| `bp tabs` | List pilot tabs |
| `bp tab <n>` | Switch tab |
| `bp close` | Close current tab |

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

## Requirements

- Chrome / Chromium / Edge / Brave (any Chromium-based browser)
- Node.js >= 18
- Chrome remote debugging enabled (`chrome://inspect/#remote-debugging`)

## License

MIT
