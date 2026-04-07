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

## Decision Tree (READ THIS FIRST)

For every step, pick the right command in this order:

1. **Need to GO somewhere?** → `bp open <url>`
   - **Always prefer URL parameters over UI navigation** when possible.
     - GitHub: `bp open "https://github.com/search?q=foo&type=repositories"`
     - Allrecipes: `bp open "https://www.allrecipes.com/search?q=lasagna"`
     - Amazon: `bp open "https://www.amazon.com/s?k=keyword"`
     - ArXiv: `bp open "https://arxiv.org/list/cs.CL/recent"`
   - This skips form-filling, is faster, and more reliable.

2. **Need to READ page content** (search results, articles, lists, prices)? → `bp read`
   - The snapshot only shows interactive elements (buttons, links, inputs).
   - Search results, article bodies, recipe details, news, product cards are NOT in the snapshot.
   - `bp read` returns the cleaned text content of the main area.
   - `bp read ".selector"` for a specific region.

3. **Need to CLICK or TYPE on a specific control?** → `bp snapshot` then `bp click <ref>` / `bp type <ref> "text"`
   - The previous action's response already includes a fresh snapshot. **Don't call `bp snapshot` after a click/type — you already have one.**

4. **Need STRUCTURED data** (specific attribute, JSON, computed value)? → `bp eval`
   - Last resort. Use only when read/snapshot can't get what you need.

5. **Have an answer?** → Output `ANSWER: <answer on one line>` and STOP.
   - Don't repeat ANSWER. Don't write multi-line answers — keep it on one line so the runner can capture it.

## Common Patterns

```bash
# Search a site (preferred — direct URL)
bp open "https://github.com/search?q=climate+visualization&type=repositories&s=stars"
bp read --limit 5000     # see the top results
# Pick best match → bp open "https://github.com/owner/repo"
# bp read for details

# Look up a single page
bp open "https://dictionary.cambridge.org/dictionary/english/serendipity"
bp read

# Scrape a list
bp open "https://news.ycombinator.com/"
bp read --limit 8000
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
| `bp click --xy 400,300` | Click at viewport coordinates (canvas, maps) |
| `bp click <ref> --double` | Double-click |
| `bp click <ref> --right` | Right-click (context menu) |
| `bp locate ".selector"` | Get element center x,y + size (for click --xy) |
| `bp type <ref> "text"` | Type into element |
| `bp type <ref> "text" --clear` | Clear field first, then type |
| `bp type <ref> "text" --submit` | Type then press Enter |
| `bp press Enter` | Press a key (Enter, Tab, Escape, etc.) |
| `bp press Control+a` | Key combo (Control, Shift, Alt, Meta) |
| `bp keyboard "text"` | Type via keyboard events (no ref needed) |
| `bp keyboard "text" --click ".sel"` | Click to focus, then type |
| `bp keyboard "text" --clear` | Select all + delete, then type |

### Reading Content
| Command | Description |
|---------|-------------|
| `bp read` | Get cleaned text of the page's main content area |
| `bp read ".search-results"` | Read text from a specific selector |
| `bp read --limit 10000` | Allow longer output (default 5000 chars) |

Use `bp read` whenever you need to *see* what's on the page (search results,
articles, product listings, news, prices, ratings). It strips nav/footer/scripts and returns
cleaned text. **This is what you want 90% of the time** — not `bp eval`.

**ANTI-PATTERN — DO NOT DO THIS:**
```bash
# WRONG: using eval to extract text content
bp eval "Array.from(document.querySelectorAll('.result')).map(e => e.innerText)"
bp eval "document.querySelector('article').textContent"
bp eval "document.body.innerText.substring(0, 3000)"
```

**RIGHT — use bp read:**
```bash
bp read                            # whole page main content
bp read ".result"                  # just the results region
bp read "article"                  # just the article
```

`bp read` is faster, cleaner (auto-strips nav/scripts/ads), and uses fewer tokens.
Reach for `bp eval` only when you need a *specific attribute* (href, value, dataset)
or *computed value* — not for plain text.

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

## How to Choose the Right Command

**Clicking:**
1. Element in snapshot → `bp click <ref>`
2. Element NOT in snapshot (canvas, map, chart) → `bp locate ".sel"` then `bp click --xy x,y`

**Typing:**
1. Element in snapshot as `textbox` → `bp type <ref> "text"`
2. Canvas editor (Google Docs, Sheets) → `bp keyboard "text" --click ".sel"`
3. `<select>` dropdown (`combobox`) → use `bp eval` (see below)

**Complex forms (Google Flights, Booking.com):**
- Prefer URL parameters over field-by-field input when possible:
  `bp open "https://www.amazon.com/s?k=keyword"`

## Patterns

### Coordinate Clicks (Canvas, Maps, Charts)

```bash
bp locate "canvas"                  # → {"ok":true, "x":400, "y":300, "width":800, "height":600}
bp click --xy 400,300               # click at those coordinates
bp click --xy 400,300 --right       # right-click (context menu)
```

### Canvas Editors (Google Docs, Sheets)

```bash
bp keyboard "Hello!" --click ".kix-appview-editor"   # click to focus + type
bp press Meta+b                                       # toggle bold
bp keyboard "bold text"
bp press Meta+b                                       # turn off bold
```

### Select Dropdowns

```bash
bp eval 'document.querySelector("select").value="opt2"; document.querySelector("select").dispatchEvent(new Event("change",{bubbles:true}))'
```

### Waiting for Dynamic Content

```bash
bp eval 'new Promise(r => setTimeout(r, 2000))'     # wait 2 seconds
bp eval 'new Promise(r => { const i = setInterval(() => { if (document.querySelector("#result")) { clearInterval(i); r(); } }, 200); })'
```

### Iframe Editors (TinyMCE)

```bash
bp frame 1                                            # switch to editor iframe
bp eval "document.body.innerHTML = 'content'"         # edit
bp frame 0                                            # back to main
```

## Notes

- Shadow DOM is traversed automatically — no special handling needed
- Dialogs (alert/confirm) are auto-handled by the daemon
- Popup windows are auto-detected — use `bp tabs` to see them
- `--limit N` caps snapshot elements (default 50)
- Contenteditable editors appear as `textbox` in snapshots — `bp type` works
- If `bp type` doesn't work, try `bp keyboard` as fallback
