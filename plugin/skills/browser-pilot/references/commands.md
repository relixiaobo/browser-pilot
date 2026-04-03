# Browser Pilot CLI — Complete Command Reference

## Session Management

### `bp connect [--browser <name>]`
Connect to Chrome and create a pilot window. Chrome shows an "Allow" dialog on first connect.
- `--browser brave` — connect to Brave instead of Chrome
- Supported browsers: chrome, chromium, edge, brave

### `bp disconnect`
Close the pilot window and stop the daemon process.

## Navigation

### `bp open <url> [--new] [--limit <n>]`
Navigate to a URL. Returns a snapshot of interactive elements.
- `--new` — open in a new tab instead of navigating the current one
- `--limit 20` — limit snapshot to 20 elements
- URL can omit `https://`: `bp open github.com` works

### `bp snapshot [--limit <n>]`
Get the current page's interactive elements without navigating.

## Interaction

### `bp click <ref> [--limit <n>]`
Click an element by its `[ref]` number from the snapshot.

### `bp type <ref> <text> [--clear] [--submit] [--limit <n>]`
Type text into an input element.
- `--clear` — clear the field before typing
- `--submit` — press Enter after typing

### `bp press <key>`
Press a keyboard key or combination.
- Single keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`
- Arrow keys: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
- Navigation: `Home`, `End`, `PageUp`, `PageDown`
- Combos: `Control+a`, `Control+c`, `Meta+v`, `Shift+Enter`, `Alt+Tab`

### `bp keyboard <text> [--click <selector>] [--clear] [--submit] [--delay <ms>]`
Type text via real keyboard events. Works with canvas-based editors (Google Docs, Sheets, Figma) that don't expose DOM inputs.
- `--click ".selector"` — click an element first to focus it (real CDP mouse click)
- `--clear` — select all + delete before typing
- `--submit` — press Enter after typing
- `--delay 50` — delay between keystrokes in ms (for apps that need slower input)

Unlike `bp type`, this does not target a specific `[ref]` element. It sends keyboard events to whatever is currently focused.

```bash
bp keyboard "Hello Docs!" --click ".kix-appview-editor"    # Google Docs
bp keyboard "new content" --clear                           # replace focused content
bp keyboard "slow input" --delay 100                        # type slowly
```

## JavaScript

### `bp eval [expression]`
Execute JavaScript in the page context and return the result.

```bash
# Inline
bp eval "document.title"
bp eval "document.querySelector('h1').textContent"
bp eval "window.scrollBy(0, 500)"
bp eval "history.back()"
bp eval "history.forward()"
bp eval "location.reload()"
bp eval "JSON.stringify(localStorage)"
bp eval "document.querySelectorAll('a').length"
bp eval "getComputedStyle(document.body).backgroundColor"

# Stdin (for complex scripts)
echo 'document.querySelectorAll("li").forEach(e => console.log(e.textContent))' | bp eval
```

## Capture

### `bp screenshot [file] [--full] [--selector <sel>]`
Take a screenshot.
- No file argument: outputs to stdout (base64 when piped)
- `--full` — capture the entire scrollable page
- `--selector "div.main"` — capture a specific element

### `bp pdf [file] [--landscape]`
Save the page as a PDF.
- `--landscape` — landscape orientation

## Cookies

### `bp cookies [domain]`
View cookies, including HttpOnly cookies not accessible via JavaScript.
- `bp cookies` — all cookies for current page
- `bp cookies github.com` — filter by domain

## File Upload

### `bp upload <filepath> [--nth <n>]`
Upload a file. Automatically finds `<input type="file">` on the page.
- `--nth 2` — use the 2nd file input if multiple exist

## HTTP Auth

### `bp auth [user] [pass] [--clear]`
Set HTTP Basic Authentication credentials for the session.
- `bp auth admin password123` — set credentials
- `bp auth --clear` — remove credentials

## Tabs

### `bp tabs`
List all pilot tabs. Popup windows opened by the page are auto-detected.

### `bp tab <index>`
Switch to a tab by its index number (from `bp tabs` output).

### `bp close [--all]`
Close the current pilot tab.
- `--all` — close all pilot tabs

## Frames

### `bp frame [index]`
List iframes or switch execution context to an iframe.
- `bp frame` — list all iframes with their indices
- `bp frame 1` — switch to iframe 1
- `bp frame 0` — switch back to top-level frame

## Network Monitoring & Interception

### `bp net [--limit <n>] [--url <pattern>] [--method <m>] [--status <code>] [--type <t>]`
List captured network requests.
- `--url "*api*"` — filter by URL pattern
- `--method POST` — filter by HTTP method
- `--status 404` — filter by status code
- `--type xhr` — filter by resource type

### `bp net show <id> [--save <file>]`
Show full details of a captured request (headers, body, response).
- `--save response.json` — save response body to file

### `bp net block <pattern>`
Block all requests matching a URL pattern.
- `bp net block "*tracking*"` — block analytics
- `bp net block "*ads*"` — block ad requests

### `bp net mock <pattern> [--body <json>] [--file <path>]`
Return a mock response for matching requests (always returns status 200).
- `bp net mock "*api/data*" --body '{"items":[]}'`
- `bp net mock "*api/users*" --file mock.json`

### `bp net headers <pattern> <header...>`
Add or override request headers for matching URLs.
- `bp net headers "*api*" "Authorization:Bearer tok123"`
- `bp net headers "*" "X-Custom:value"`

### `bp net rules`
List all active interception rules (block/mock/headers).

### `bp net remove [id] [--all]`
Remove interception rules.
- `bp net remove 2` — remove rule #2
- `bp net remove --all` — remove all rules

### `bp net clear`
Clear the captured request log.
