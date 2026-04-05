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

Every action (`open`, `click`, `type`, `keyboard`, `press`) returns a snapshot listing interactive elements:

```
[1] link "Home"
[2] textbox "Search"              ← standard <input> or <textarea>
[3] textbox "Editor"              ← contenteditable (rich text editors)
[4] textbox ""                    ← unnamed input (still interactive)
[5] combobox ""                   ← <select> dropdown
[6] spinbutton "Quantity"         ← <input type="number">
[7] button "Submit"
[8] checkbox "Agree" checked
[9] slider "Volume"               ← <input type="range">
```

Use the `[ref]` number in subsequent commands. Refs refresh after every action.

**Common roles:** `textbox` (inputs, textareas, contenteditable), `combobox` (select),
`spinbutton` (number/date/time inputs), `slider` (range), `button`, `link`, `checkbox`, `radio`, `switch`, `tab`.

## Commands

### Navigation & Interaction
| Command | Description |
|---------|-------------|
| `bp open <url>` | Navigate to URL, returns snapshot |
| `bp snapshot` | Refresh current page snapshot |
| `bp click <ref>` | Click element by ref number |
| `bp click 0 --xy 400,300` | Click at x,y coordinates (canvas, maps) |
| `bp click <ref> --double` | Double-click element |
| `bp click <ref> --right` | Right-click (context menu) |
| `bp type <ref> "text"` | Type into element |
| `bp type <ref> "text" --clear` | Clear field first, then type |
| `bp type <ref> "text" --submit` | Type then press Enter |
| `bp press Enter` | Press a key (Enter, Tab, Escape, etc.) |
| `bp press Control+a` | Key combo (Control, Shift, Alt, Meta) |
| `bp keyboard "text"` | Type via keyboard events (no ref needed) |
| `bp keyboard "text" --click ".sel"` | Click element first, then type |
| `bp keyboard "text" --clear` | Select all + delete, then type |
| `bp keyboard "text" --submit` | Type then press Enter |
| `bp keyboard "text" --delay 50` | Type with delay between keystrokes |

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

## Common Patterns

### Rich Text Editors (contenteditable)

`bp type` supports most contenteditable-based editors (Draft.js, ProseMirror, Quill, Slate, Lexical, etc.).
They appear as `textbox` in the snapshot. Use `--clear` to replace existing content:

```bash
bp type 3 "new content" --clear   # works on contenteditable editors
```

If `bp type` doesn't trigger the editor's state update, fall back to `bp eval` with `document.execCommand` or the editor's API.

### Shadow DOM

bp traverses open Shadow DOM automatically. Elements inside shadow roots (even 3+ levels deep) appear in snapshots and can be clicked/typed normally. Closed shadow roots are not accessible.

### Select Dropdowns

`<select>` elements appear as `combobox` in snapshots. **Do not use `bp type`** — use `bp eval` to change the value:

```bash
bp eval 'document.querySelector("select").value = "option2"; document.querySelector("select").dispatchEvent(new Event("change", {bubbles:true}))'
```

### Waiting for Dynamic Content

When content loads asynchronously (spinners, AJAX, animations), wait before interacting:

```bash
bp eval 'new Promise(r => setTimeout(r, 2000))'   # wait 2 seconds
bp snapshot                                         # then get fresh elements
```

Or wait for a specific element to appear:

```bash
bp eval 'new Promise(r => { const i = setInterval(() => { if (document.querySelector("#result")) { clearInterval(i); r(); } }, 200); })'
```

### Canvas Editors (Google Docs, Google Sheets, Figma)

Canvas-based apps don't expose DOM inputs — `bp type` won't work. Use `bp keyboard` instead,
which sends real keyboard events to whatever is currently focused:

```bash
bp keyboard "Hello Docs!" --click ".kix-appview-editor"   # Google Docs
bp keyboard "cell value" --click ".waffle-cell"            # Google Sheets
```

Formatting with keyboard shortcuts:
```bash
bp press Meta+b                          # toggle bold
bp keyboard "bold title"                 # type bold text
bp press Meta+b                          # turn off bold
bp press Enter                           # new line
bp keyboard "normal paragraph"           # type normal text
```

Common Google Docs shortcuts:
- **Bold/Italic/Underline**: `Meta+b`, `Meta+i`, `Meta+u`
- **Heading 1/2/3**: `Meta+Alt+1`, `Meta+Alt+2`, `Meta+Alt+3`
- **Bullet list**: `Meta+Shift+8`
- **Numbered list**: `Meta+Shift+7`
- **Select all**: `Meta+a`

### Iframe-based Editors (TinyMCE, CKEditor)

Some editors use an iframe. Switch to the iframe first:

```bash
bp frame              # list frames — find the editor iframe index
bp frame 1            # switch to it
bp eval "document.body.innerHTML = 'new content'"   # edit via eval
bp frame 0            # switch back to main page
```

## When to Use `type` vs `keyboard`

| Scenario | Command |
|----------|---------|
| Standard `<input>` / `<textarea>` | `bp type <ref> "text"` |
| Contenteditable editors (Draft.js, Quill...) | `bp type <ref> "text"` |
| Google Docs / Sheets / canvas apps | `bp keyboard "text" --click ".selector"` |
| Any app where `bp type` doesn't work | `bp keyboard "text"` (focus first) |

## Tips

- Always read the snapshot output to find the correct `[ref]` numbers before clicking/typing
- Use `bp eval` as an escape hatch for scrolling, extracting data, or any DOM operation
- Dialogs (alert/confirm/prompt) are auto-handled — no action needed
- Popup windows are auto-detected — use `bp tabs` to see them
- The browser uses the user's real profile — all logins and cookies are available
- Use `--limit N` with `bp open` or `bp snapshot` to limit the number of elements returned
- Elements without visible labels still appear in snapshots (as unnamed textbox, etc.)
