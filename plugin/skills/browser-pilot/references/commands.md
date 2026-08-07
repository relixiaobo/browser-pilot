# Browser Pilot Command Reference

Use this reference only when the main skill does not cover the needed command
or option. CLI output is JSON when stdout is not a TTY. Add global `--human` to
force human-readable output.

## Contents

- [Global Options](#global-options)
- [Connection and State](#connection-and-state)
- [Tabs and Navigation](#tabs-and-navigation)
- [Observation and Interaction](#observation-and-interaction)
- [Frames and Dialogs](#frames-and-dialogs)
- [Files and Captures](#files-and-captures)
- [Cookies and Authentication](#cookies-and-authentication)
- [Network](#network)

## Global Options

Place global options before the command:

```bash
bp --client-key <stable-key> --timeout 30000 snapshot
bp --request-id <stable-id> click 4
bp --human tabs
```

- `--client-key <key>` selects stable state for one independent Agent. The
  `BROWSER_PILOT_CLIENT_KEY` environment variable is equivalent.
- `--request-id <id>` supplies a stable intended-call identity for command
  recovery. The `BROWSER_PILOT_REQUEST_ID` environment variable is equivalent.
- `--timeout <ms>` sets the command deadline. It does not make an interrupted
  mutation safe to repeat.
- `--human` changes formatting only. A positional value equal to `--human`
  remains command data.

## Connection and State

### `bp browsers [--browser <selector>]`

Passively list installed supported browsers with process, remote-debugging,
authorization, and readiness state. Use a returned ID, product, or channel as
the connect selector.

### `bp connect [--browser <selector>]`

Request one browser connection only after `bp browsers` reports that the
selected browser is ready for an explicit connection. Before invoking the
command through an Agent shell, tell the user that Chrome may show an Allow
dialog and ask them to click Allow once if it appears. Machine-readable output
is returned only after the command finishes. Do not run concurrent or blind
retry attempts.

### `bp status`

Return service, browser, selected profile/tab, active commands, uncertain
commands, and structured recovery state for the current Agent key. `paths.sites`
is the absolute site knowledge directory for this installation, reported whether
or not a browser is connected.

### `bp profiles [--identify] [--refresh]`

List live Chrome profiles and representative tabs. `--identify` performs a
visible, path-verified identity probe. `--refresh` repeats that probe.

### `bp profile <selector>`

Select a fresh one-based index, profile ID, neutral label, verified profile
name, account name, or email for newly created managed tabs.

### `bp disconnect`

Release the current Agent key's state and managed tabs. Stop the background
service only when it is otherwise unused and the invoking executable owns it.

## Tabs and Navigation

### `bp tabs`

List all eligible Browser Pilot-created and user-opened tabs across live Chrome
profiles. Each entry includes a one-based index, title, URL, origin, selected
state, and profile context. List again after tabs open, close, or reconnect.

### `bp tab <index>`

Select a tab from the latest inventory. `selected` means selected for this
Agent, not necessarily Chrome foreground focus.

### `bp open <url> [--new] [--profile <selector>] [--limit <n>]`

Navigate the selected tab and return page state. `--new` creates a managed tab.
`--profile` requires `--new`.

### `bp close [--all]`

Close the selected tab explicitly. `--all` closes only Browser Pilot-created
tabs, never user-opened tabs.

## Observation and Interaction

### `bp snapshot [--limit <n>]`

Return bounded interactive elements with numbered refs and page geometry.
A `site` array carries durable knowledge matching the URL; see the Site
Knowledge section of `SKILL.md`.
`truncationReasons` can report element, text, depth, byte, or work limits.
`work_limit` means Browser Pilot stopped expensive DOM text derivation; use a
narrower page state representation before inferring that content is absent.

### `bp read [selector] [--limit <characters>]`

Return cleaned readable text for the page or one CSS-selected region.

### `bp search <query> [options]`

Return bounded visible-text matches and nearby context. Options are
`--selector`, `--case-sensitive`, `--whole-word`, and `--limit`.

### `bp find <selector> [options]`

Return bounded visibility, geometry, role, and requested DOM attributes.
Options are `--limit`, `--attributes <comma-list>`, and `--no-shadow`. This does
not create actionable refs.

### `bp scroll [direction] [options]`

Scroll the page, a selected container, a ref, or matching text, then return
fresh page state. Use `--amount`, `--unit pixels|viewport`, `--selector`,
`--ref`, `--to start|end`, `--to-text`, `--exact`, and `--limit`.

### `bp click <ref> [--double|--right] [--limit <n>]`

Click a fresh numbered ref and return verified action evidence plus fresh page
state. Use `bp click --xy x,y` only for visual surfaces without semantic refs.

### `bp locate <selector>`

Return viewport coordinates and size for a CSS-selected element.

### `bp type <ref> <text> [--clear] [--submit] [--limit <n>]`

Type into a semantic control, verify browser-visible readback, and return fresh
state. Inspect autocomplete suggestions after typing before choosing one.

### `bp keyboard <text> [options]`

Send trusted key events to the focused control. Use for canvas-style editors or
controls not represented by a ref. Options are `--click <selector>`, `--clear`,
`--submit`, `--delay <ms>`, and `--limit`. JSON uses the standard fresh page
state shape, including page geometry, hints, site knowledge, and Profile context
when present.

### `bp press <key> [--limit <n>]`

Press a key or combination such as `Enter`, `Escape`, `Control+a`, or `Meta+c`.

### `bp dropdown <ref|selector>`

List bounded native or exposed ARIA options.

### `bp select <ref|selector> <option> [options]`

Select and verify an option. Use `--by label|value|index`, `--contains`, and
`--limit`.

### `bp eval [expression]`

Evaluate JavaScript in the selected page/frame. Pass complex code through
stdin. It runs in the page's main JavaScript world, where page scripts may
modify globals. Use only when a dedicated command is insufficient.

## Frames and Dialogs

- `bp frame` lists frames.
- `bp frame <index>` selects a frame.
- `bp frame 0` selects the top frame.
- `bp dialogs` lists pending JavaScript dialogs.
- `bp dialog <id> --accept [--prompt <text>]` accepts one dialog.
- `bp dialog <id> --dismiss` dismisses one dialog.

Frame coverage. What a snapshot reaches is decided by the renderer process, and
origin is the practical proxy: a same-origin frame is a same-process iframe,
while Chrome's site isolation puts a cross-origin frame in its own process.

- A snapshot descends into every same-process iframe, at any nesting depth.
  Their controls arrive as ordinary refs, including DOM-only controls the
  accessibility tree does not expose, and `bp click` reaches them without
  selecting the frame first.
- A snapshot never includes a cross-origin iframe. Nothing in the result reports
  the omission, so an absent control is indistinguishable from a control that
  does not exist.
- `bp frame` lists same-process frames only. A cross-origin frame cannot be
  listed or selected, so `bp frame` is not a way to discover what a snapshot
  left out.
- Selecting a frame narrows observation to that frame and its own descendants;
  it never widens it to the parent.

Selector-based commands, coordinates from `bp locate`, and `bp click --xy` are
all scoped to the selected subframe, and a selector naming a top-frame element
does not resolve while a subframe is selected.

To reach a cross-origin frame, discover its source and open it as its own page:

```bash
bp find "iframe" --attributes src
bp open "<the cross-origin src>" --new
```

The page then loads as a top-level document, where its controls observe and act
normally. A frame that only renders correctly when embedded is the exception;
report that to the user rather than working around it.

## Files and Captures

### `bp upload <path> [--nth <n>]`

Upload one local file through a matching file input and return fresh page state.

### `bp screenshot [filename] [options]`

Capture a PNG. Use `--full`, `--selector <selector>`, or `--annotate [refs]`.
Annotations require a current snapshot and work only on viewport captures.

### `bp pdf [filename] [--landscape]`

Export the selected page to PDF.

### `bp downloads`

List completed downloads retained for the current Agent key.

### `bp download <index> [filename]`

Export one listed download to a local file. Re-list after a download completes.

Capture and download results include an absolute `file`, MIME type, byte size,
and image dimensions when applicable. Set `BROWSER_PILOT_OUTPUT_DIR` to an
absolute task-owned directory to confine all captures, PDFs, download exports,
and saved network bodies. While it is set, relative filenames resolve inside
that directory; absolute filenames must already be inside it; and `..` or
symbolic-link escapes fail before browser or network work starts. Without it,
explicit filenames and then the current working directory remain available.

## Cookies and Authentication

- `bp cookies [domain]` reads cookies scoped to the current URL or a domain,
  including HttpOnly values.
- `bp auth <username> <password>` configures HTTP Basic Auth for the current
  Agent key.
- `bp auth --clear` removes that configuration.

Avoid these commands unless the task requires the sensitive data or behavior.

## Network

- `bp net [--limit <n>] [--url <pattern>] [--method <method>]`
  `[--status <code-pattern>] [--type <types>] [--after <id>]` lists requests.
- `bp net show <id> [--save <file>]` returns details under the same numeric
  request `id` shown by `bp net`, and optionally saves the response body.
- `bp net block <pattern>` blocks matching requests.
- `bp net mock <pattern> [--body <text>|--file <path>] [--status <code>]`
  installs a mock response.
- `bp net headers <pattern> <header...>` adds or replaces request headers.
- `bp net rules` lists current rules.
- `bp net remove <uuid|rule:uuid>` or `bp net remove --all` removes rules.
- `bp net clear` clears the request journal.

Network rules belong only to the current Agent key and are cleaned up when its
state is released.
