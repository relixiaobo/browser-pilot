# Browser Pilot One-Shot Command Reference

Use these commands when an Agent has shell access and needs to operate the
browser directly. Machine-oriented output is JSON when stdout is not a TTY;
`bp --human ...` forces human-readable output.

## Contents

- [Connection](#connection)
- [Tabs and Navigation](#tabs-and-navigation)
- [Observation](#observation)
- [Interaction](#interaction)
- [Frames and Dialogs](#frames-and-dialogs)
- [Files and Capture](#files-and-capture)
- [Page Evaluation](#page-evaluation)
- [Cookies and HTTP Authentication](#cookies-and-http-authentication)
- [Network](#network)
- [JSON Results and Failures](#json-results-and-failures)

## Connection

### `bp --version`

Print the resolved CLI version. Confirm that it satisfies
`browserPilotCli.supportedVersionRange` in the skill's bundled
`compatibility.json` before the first Browser Pilot operation.

### `bp browsers [--browser <selector>]`

Passively list installed supported browser candidates and their process,
remote-debugging, authorization, and aggregate readiness states. This command
never opens a browser WebSocket or triggers Chrome's Allow dialog. Use the
returned ID, product, or channel as a `connect --browser` selector.

### `bp connect [--browser <selector>]`

Connect to an authorized local Chromium browser. Run passive `bp browsers`
first when the intended browser is ambiguous; pass a returned browser ID,
product, or channel such as stable, beta, or canary rather than relying on a
hard-coded browser list. Chrome may ask the user to click Allow. With one live
Profile, Browser Pilot also creates the managed Pilot window. With several
Profiles, it lists them and waits for explicit routing; do not run `connect`
again.

### `bp profiles [--identify] [--refresh]`

Passively list live Chrome Profile contexts, tab counts, bounded representative
tabs, and the current Workspace selection. With `--identify`, explicitly open
and close temporary visible `chrome://version` pages and return a Profile name,
account name/email, and directory only after exact Profile-path verification.
`--refresh` repeats that probe instead of using the connection-generation
cache. IDs and verified identity last only for the current browser connection.

### `bp profile <index|id|label|verified-name|verified-email>`

Select one freshly listed Profile for subsequent managed tabs. Selection is
routing, not a permission grant, and does not focus or close a user tab. The
index is one-based; verified Profile/account names and email addresses are also
valid selectors when they resolve exactly one current context.

### `bp disconnect`

Release only the current CLI namespace and its managed targets. The Broker
stops only when no other active Lease or embedded client remains. Do not use
this as routine per-task cleanup when other clients may still need Browser
Pilot.

### `--client-key <stable-key>` / `BROWSER_PILOT_CLIENT_KEY`

Give each independent Agent that directly invokes one-shot commands a distinct,
stable key. Reuse the same key for every command from that Agent; never generate
one per tool call. The key isolates its Workspace, Lease, selected target,
frame, refs, auth, and network state from other CLI Agents. Embedded stdio hosts
already use separate Connection identities and do not need this option.

## Tabs and Navigation

### `bp tabs`

List all controllable page tabs in the connected browser. Results include
Browser Pilot managed tabs, their eligible popups, and eligible user-opened
tabs across all live Profiles. Each JSON tab has `index`, `url`, `title`,
`selected`, `origin`, and an opaque `profileContextId`. Extension-owned and
browser-internal pages are excluded. `selected` is the current Agent Lease's
logical target, not Chrome's foreground tab or operating-system focus.
Tabs remain controllable when they belong to an expanded or collapsed Chrome
tab group, but Browser Pilot does not expose or manage the groups themselves.

### `bp tab <index>`

Select any tab returned by the latest `bp tabs`. Tab indexes are inventory
positions, are one-based, and may change; list again after tabs open or close.

### `bp open <url> [--new] [--profile <selector>] [--limit <n>]`

Navigate the current tab and return a snapshot. `--new` creates a new managed
tab instead of replacing the selected tab. A URL without a scheme defaults to
HTTPS. `--profile` requires `--new` and resolves a fresh Profile index, opaque
ID, neutral label, or verified Profile/account name or email.

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

### `bp search <query> [--selector <selector>] [--case-sensitive] [--whole-word] [--limit <n>]`

Return bounded visible-text matches with nearby context and viewport geometry.
Use this for a targeted lookup when returning an entire page with `read` would
waste context. Open Shadow DOM is searched. The default limit is 20 and the
maximum is 200.

### `bp find <selector> [--limit <n>] [--attributes <name,...>] [--no-shadow]`

Run a bounded CSS query and return safe metadata: tag, role, accessible name,
text, visibility, enabled state, viewport geometry, and explicitly requested
attributes. This does not return DOM/CDP handles or actionable refs. Open Shadow
DOM is included unless `--no-shadow` is supplied.

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

### `bp scroll [up|down|left|right] [--amount <n>] [--unit pixels|viewport] [--selector <selector>|--ref <ref>] [--to start|end] [--to-text <text>] [--exact] [--limit <n>]`

Scroll the page or one scrollable element and return a fresh snapshot plus
typed scroll evidence. The default is down by 0.8 viewport. `--to-text` reveals
the first visible text match, while `--to start|end` moves to a boundary. A ref
uses the latest snapshot and becomes stale after the returned state replaces it.

### `bp dropdown <target>`

List bounded options for a native `<select>` or an exposed ARIA combobox/listbox.
`target` may be a current ref or CSS selector. A closed custom control can
report `open required`; use `select` with a ref so Browser Pilot can open it and
continue from fresh state.

### `bp select <target> <option> [--by label|value|index] [--contains] [--limit <n>]`

Select an option and return a fresh snapshot with verification evidence. Native
selects emit `input` and `change` and are read back. Custom/ARIA controls require
an Observation ref and use trusted clicks; selector targets are supported only
for native selects.

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

### `bp screenshot [filename] [--full] [--selector <selector>] [--annotate [refs]]`

Write a PNG and return `{ "ok": true, "file": "..." }`. `--full` captures the
full scrollable page; `--selector` captures one matching element. Without a
filename, the CLI writes a timestamped PNG in the current working directory.
`--annotate` draws boxes and numbered labels for the latest snapshot's refs;
pass comma-separated refs to limit them. Annotation is viewport-only and cannot
be combined with `--full` or `--selector`. Drawing runs in an isolated world and
does not expose bytes to page scripts or mutate the page DOM.

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

Successful snapshots contain `title`, `url`, `elements`, and may include `page`,
`hints`, and typed action `evidence`; content reads also include `text`,
`length`, and `truncated`. Capture commands return a local `file` path and
annotated captures include `annotationCount`. Failed one-shot commands return
`ok: false`, an English `error`, stable `code`, and `retryable`, plus optional
`context`, `remediation`, and recovery `hint`, then exit nonzero. Parser and
user-input failures use `invalid_argument`; Broker failures retain the same
stable code used by the stdio protocol.

Branch on `code`, not English text. `retryable: true` means a later call may be
valid, not that the same mutation is safe to replay. Do not infer that a
partially completed mutation was rolled back; inspect current tab/page state
before retrying.
