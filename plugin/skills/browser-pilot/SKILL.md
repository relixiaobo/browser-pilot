---
name: browser-pilot
description: >
  Control a real Chrome browser via the `bp` CLI tool. Use when the user needs to
  browse websites, interact with web pages, fill forms, scrape content, test UIs,
  monitor network requests, or take screenshots. The browser keeps the user's real
  login sessions, cookies, and extensions — no separate browser instance needed.
  Activate this skill whenever a task involves web browsing, web scraping, form
  filling, UI testing, or any interaction with a website.
---

# Browser Pilot

Control the user's real Chrome browser via bash commands. Every action returns a
snapshot of interactive elements with `[ref]` numbers you can use in follow-up commands.

## Prerequisites

- Chrome remote debugging must be enabled: `chrome://inspect/#remote-debugging` toggle ON
- Run `bp connect` once per session (user clicks "Allow" in Chrome)
- If `bp` command is not found, install it first: `npm install -g browser-pilot-cli`

## Core Workflow

```bash
bp connect                    # connect to Chrome (once per session)
bp open "https://example.com" # navigate — returns snapshot
bp click 3                    # click element [3] — returns snapshot
bp type 5 "hello" --submit    # type into [5] + Enter — returns snapshot
bp disconnect                 # end session
```

## Understanding Snapshots

Every action (`open`, `click`, `type`, `press`) returns a snapshot listing interactive elements:

```
[1] link "Home"
[2] textbox "Search"
[3] button "Submit"
```

Use the `[ref]` number in subsequent commands. Refs refresh after every action.

## Commands

### Navigation & Interaction
| Command | Description |
|---------|-------------|
| `bp open <url>` | Navigate to URL, returns snapshot |
| `bp snapshot` | Refresh current page snapshot |
| `bp click <ref>` | Click element by ref number |
| `bp type <ref> "text"` | Type into element |
| `bp type <ref> "text" --clear` | Clear field first, then type |
| `bp type <ref> "text" --submit` | Type then press Enter |
| `bp press Enter` | Press a key (Enter, Tab, Escape, etc.) |
| `bp press Control+a` | Key combo (Control, Shift, Alt, Meta) |

### JavaScript (escape hatch for anything)
| Command | Description |
|---------|-------------|
| `bp eval "document.title"` | Run JS, return result |
| `bp eval "history.back()"` | Go back |
| `bp eval "history.forward()"` | Go forward |
| `bp eval "location.reload()"` | Reload page |
| `bp eval "window.scrollBy(0, 500)"` | Scroll down |
| `bp eval "document.querySelector('h1').textContent"` | Extract text |

### Capture
| Command | Description |
|---------|-------------|
| `bp screenshot` | Screenshot to stdout (base64 when piped) |
| `bp screenshot page.png` | Save screenshot to file |
| `bp screenshot --full` | Full page screenshot |
| `bp pdf report.pdf` | Save page as PDF |

### Tabs & Frames
| Command | Description |
|---------|-------------|
| `bp tabs` | List open pilot tabs |
| `bp tab 2` | Switch to tab 2 |
| `bp close` | Close current tab |
| `bp frame` | List iframes |
| `bp frame 1` | Switch to iframe 1 |
| `bp frame 0` | Back to top frame |

### Network Monitoring
| Command | Description |
|---------|-------------|
| `bp net` | List recent requests |
| `bp net --url "*api*"` | Filter by URL pattern |
| `bp net show 3` | Full request/response details |
| `bp net block "*tracking*"` | Block matching requests |
| `bp net mock "*api*" --body '{"ok":true}'` | Mock a response |
| `bp net headers "*api*" "Auth:Bearer tok"` | Override headers |
| `bp net rules` | List active interception rules |
| `bp net remove --all` | Remove all rules |

### Other
| Command | Description |
|---------|-------------|
| `bp upload photo.jpg` | Upload file (auto-finds file input) |
| `bp auth user pass` | Set HTTP Basic Auth |
| `bp cookies` | View cookies (includes HttpOnly) |
| `bp cookies example.com` | Filter cookies by domain |

## Output Format

When piped (default for agents), output is JSON:
```json
{"ok":true, "title":"Example", "url":"https://example.com", "elements":[{"ref":1, "role":"link", "name":"More info"}]}
```

Errors include hints:
```json
{"ok":false, "error":"Ref [99] not found.", "hint":"Run 'bp snapshot' to refresh element refs."}
```

## Tips

- Always read the snapshot output to find the correct `[ref]` numbers before clicking/typing
- Use `bp eval` as an escape hatch for scrolling, extracting data, or any DOM operation
- Dialogs (alert/confirm/prompt) are auto-handled — no action needed
- Popup windows are auto-detected — use `bp tabs` to see them
- The browser uses the user's real profile — all logins and cookies are available
- Use `--limit N` with `bp open` or `bp snapshot` to limit the number of elements returned
