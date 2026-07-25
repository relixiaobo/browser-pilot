# Browser Pilot One-Shot Command Reference

Use these commands when an Agent has shell access and needs to operate the
browser directly. Machine-oriented output is JSON when stdout is not a TTY;
`bp --human ...` forces human-readable output.

## Connection

### `bp connect [--browser <name>]`

Connect to an authorized local Chromium browser and create the managed Pilot
window. Supported compatibility names are `chrome`, `chromium`, `edge`, and
`brave`. Chrome may ask the user to click Allow.

### `bp disconnect`

Close Browser Pilot managed targets and stop the compatibility daemon. Do not
use this as routine per-task cleanup when other clients may still need Browser
Pilot.

## Tabs and Navigation

### `bp tabs`

List all controllable page tabs in the connected browser. Results include
Browser Pilot managed tabs, their eligible popups, and eligible user-opened
tabs. Each JSON tab has `index`, `url`, `title`, `active`, and `origin`.

### `bp tab <index>`

Select any tab returned by the latest `bp tabs`. Tab indexes are inventory
positions and may change; list again after tabs open or close.

### `bp open <url> [--new] [--limit <n>]`

Navigate the current tab and return a snapshot. `--new` creates a new managed
tab instead of replacing the selected tab. A URL without a scheme defaults to
HTTPS.

### `bp close [--all]`

Without `--all`, explicitly close the current tab, including a selected user
tab. `--all` closes Browser Pilot managed tabs only and leaves user tabs open.

## Observation

### `bp snapshot [--limit <n>]`

Return bounded interactive elements with numbered refs. The default limit is
50. A ref belongs to the current tab/frame/page state; refresh after navigation,
tab/frame changes, or a ref error.

### `bp read [selector] [--limit <n>]`

Return cleaned readable text for the main page or a CSS selector. The default
text limit is 3000 characters. Use this for articles, search results, lists,
prices, and other content not represented by interactive refs.

### `bp locate <selector>`

Return an element's viewport center and bounding box. Use it only when a canvas,
map, chart, or other non-semantic surface requires coordinate interaction.

## Interaction

### `bp click [ref] [--xy <x,y>] [--double] [--right] [--limit <n>]`

Click a fresh ref or explicit viewport coordinates and return the resulting
snapshot. `--double` and `--right` are mutually exclusive. Ref clicks validate
live layout, enabled state, and obstruction before pointer dispatch.

### `bp type <ref> <text> [--clear] [--submit] [--limit <n>]`

Edit a semantic text/value control and return the resulting snapshot. `--clear`
replaces existing content; `--submit` presses Enter after input. Browser Pilot
reads back native/contenteditable state internally and rejects controls that
are disabled, readonly, inert, detached, or unsupported.

### `bp keyboard <text> [--click <selector>] [--clear] [--submit] [--delay <ms>] [--limit <n>]`

Send keyboard events to the focused control. Use this for canvas-style editors
that do not expose a semantic textbox. `--click` focuses a selector first.
Browser Pilot stops remaining characters if focus, page, frame, or document
identity changes during the composite action.

### `bp press <key> [--limit <n>]`

Press a key or combination and return the resulting snapshot. Examples include
`Enter`, `Escape`, `Tab`, `ArrowDown`, `Control+a`, and `Meta+b`.

## Frames and Dialogs

### `bp frame [index]`

List frames or select one. Index `0` returns to the top frame. List and snapshot
again after frame navigation or detachment.

### `bp dialogs`

List pending JavaScript dialogs. Dialogs remain pending until explicitly
handled.

### `bp dialog <dialog-id> --accept|--dismiss [--prompt <text>]`

Respond to one pending dialog. Provide exactly one of `--accept` or `--dismiss`.
Use `--prompt` only when accepting a prompt dialog.

## Files and Capture

### `bp screenshot [filename] [--full] [--selector <selector>]`

Write a PNG and return `{ "ok": true, "file": "..." }`. `--full` captures the
full scrollable page; `--selector` captures one matching element. Without a
filename, the CLI writes a timestamped PNG in the current working directory.

### `bp pdf [filename] [--landscape]`

Write a PDF and return its path. Without a filename, the CLI writes a
timestamped PDF in the current working directory.

### `bp upload <filepath> [--nth <n>]`

Resolve the path, select a file input, assign one file, verify the browser
filename/count internally, and return a fresh snapshot. `--nth` selects a
1-based file input when the page has more than one.

## Page Evaluation

### `bp eval [expression]`

Evaluate JavaScript in the selected frame and return the value. If no argument
is supplied, read the expression from stdin. Prefer `read`, `snapshot`, and
semantic actions for ordinary work; use eval for a specific missing operation
or structured value.

```bash
bp eval "document.title"
bp eval "history.back()"
bp eval "window.scrollBy(0, 500)"
echo 'document.querySelector("a")?.href' | bp eval
```

## Cookies and HTTP Authentication

### `bp cookies [domain]`

Return cookies visible to the selected target, including HttpOnly cookies.
Treat the complete output as credential-sensitive.

### `bp auth [username] [password] [--clear]`

Set compatibility-session HTTP Basic Auth credentials before navigation, or
clear them with `--clear`. Command-line arguments may be visible to local
process inspection/history; an embedding host should use the structured bridge
instead of placing credentials in argv.

## Network

### `bp net [filters]`

List recent requests. Filters include `--limit`, `--url`, `--method`,
`--status`, `--type`, and `--after`.

### `bp net show <id> [--save <file>]`

Return bounded request/response detail. `--save` writes the response body to the
specified path. Headers and bodies may contain credentials or private data.

### `bp net block <pattern>`

Add a blocking rule.

### `bp net mock <pattern> [--body <text>] [--file <path>] [--status <code>]`

Add a mock response rule. The default status is 200.

### `bp net headers <pattern> <header...>`

Add or override request headers. Header values may contain credentials.

### `bp net rules`

List compatibility-session interception rules.

### `bp net remove [rule-id] [--all]`

Remove one rule or all rules.

### `bp net clear`

Clear the compatibility request journal.

## JSON Results and Failures

Successful snapshots contain `title`, `url`, and `elements`; content reads also
include `text`, `length`, and `truncated`. Capture commands return a local
`file` path. Failed one-shot commands return `ok: false`, an English `error`,
and sometimes a recovery `hint`, then exit nonzero.

The one-shot error shape is intentionally smaller than the embedded bridge
contract. Do not infer that a partially completed mutation was rolled back from
an English error message. Inspect current tab/page state before retrying.
