---
name: browser-pilot
description: >
  Control the user's eligible Chrome tabs through the `bp` CLI without a browser
  extension. Use for browsing signed-in websites, reading pages, filling forms,
  operating web apps, handling tabs or dialogs, uploading files, capturing
  screenshots/PDFs, and inspecting network activity. Also use when integrating
  Browser Pilot into an Agent host through `browser-pilot bridge --stdio`.
---

# Browser Pilot

Use the user's real Chromium browser through the `bp` executable. Existing
logins, cookies, and extensions remain available. Browser Pilot can list and
control both its managed tabs and eligible tabs the user opened; it requires no
browser extension.

## Select the Interface

- For an Agent with shell access completing a browser task now, use the
  one-shot commands in this file.
- For a product embedding long-lived browser control, read
  [references/embedded-stdio.md](references/embedded-stdio.md). Do not drive the
  NDJSON bridge manually for an ordinary browsing task.
- Read [references/commands.md](references/commands.md) only when a command or
  option is not covered here.

## Prepare

Check installation without changing the machine:

```bash
command -v bp
```

If it is absent, install the official executable with
`npm install -g browser-pilot-cli`. Chrome remote debugging must be enabled at
`chrome://inspect/#remote-debugging`. Connect only when a command reports that
Browser Pilot is not connected:

```bash
bp connect
```

Chrome may require the user to click Allow. Do not claim connection until the
command succeeds.

## Operate from Current State

1. Resolve the intended tab.
   - If the user refers to a page already open, run `bp tabs`, identify it by
     URL/title/origin, then run `bp tab <index>`.
   - For independent work, prefer `bp open <url> --new` so an unrelated user tab
     is not replaced.
   - Use plain `bp open <url>` only when navigating the currently selected tab
     is intended.
2. Inspect the right representation.
   - Run `bp snapshot` for controls and numbered refs.
   - Run `bp read [selector]` for article text, search results, lists, prices,
     and other non-interactive content.
   - If `bp read` reports `truncated`, increase its `--limit`. If an expected
     control is absent from a bounded snapshot, refresh with a larger
     `--limit`; do not infer that omitted content is absent.
3. Act on fresh state.
   - Prefer `bp click <ref>` and `bp type <ref> <text>` over selectors or
     coordinates.
   - Treat refs as belonging only to the current tab, frame, and latest page
     state. After navigation, tab/frame changes, or a stale-ref error, obtain a
     new snapshot and choose a new ref.
   - Use `bp locate <selector>` plus `bp click --xy x,y` only for canvas, maps,
     charts, or controls absent from the snapshot.
4. Verify the result.
   - Action commands return the resulting snapshot. Check the URL, relevant
     control state, and page content before concluding that the user's goal
     succeeded.
   - A successful command proves browser dispatch completed, not that a
     purchase, message, upload, or other business outcome succeeded.
   - On failure after possible input/navigation, inspect current state before
     retrying. Never blindly repeat a mutating action.
5. Use `bp eval` only as an escape hatch for a value or operation unavailable
   through `tabs`, `snapshot`, `read`, `click`, `type`, `press`, or `keyboard`.

## Core Commands

```bash
bp tabs                              # all controllable managed and user tabs
bp tab 2                             # select tab index 2
bp open "https://example.com" --new  # create an independent managed tab
bp snapshot                          # interactive controls with refs
bp read                              # readable page content
bp read "main" --limit 10000         # bounded region text
bp click 3                           # click current ref 3
bp type 5 "hello" --clear            # replace a text control
bp type 5 "query" --submit           # type, then press Enter
bp press Escape                      # key or key combination
bp keyboard "text" --click ".editor" # canvas-style editor fallback
```

Direct URLs are often more reliable for search/list pages when the URL contract
is known, but do not replace a user-opened form or draft merely to save steps.

## Read and Interaction Rules

- Prefer `bp read` for text. Do not use `eval` to dump `document.body.innerText`
  or rebuild text extraction.
- Prefer returned refs for semantic controls. Empty-name textboxes and
  contenteditable elements are still valid controls.
- After typing, confirm the displayed/effective value when the task depends on
  exact input. Frameworks may sanitize or reject input.
- For an autocomplete field, type first, inspect the updated snapshot, then
  select the intended suggestion. Do not assume typed text selected an item.
- If a modal or dialog blocks the page, resolve it before interacting with the
  content behind it.
- If repeated actions produce no visible progress, stop repeating them. Refresh
  state and change strategy.
- Treat a main-document 403/429 as an access state. Do not loop the same
  navigation; inspect login state, rate limits, or an alternate user-approved
  path.

## Tabs, Frames, and Dialogs

`bp tabs` includes eligible user tabs as well as Browser Pilot managed tabs.
Selecting a user tab makes it the current controlled tab. `bp close` explicitly
closes the current tab even when it is user-owned; `bp close --all` closes only
managed tabs. Do not close a tab unless the task requires it.

Use `bp frame` to list frames, `bp frame <index>` to select one, and `bp frame 0`
to return to the top frame. Refresh the snapshot after changing frames.

JavaScript dialogs remain pending; Browser Pilot never chooses for the user:

```bash
bp dialogs
bp dialog <dialog-id> --accept
bp dialog <dialog-id> --dismiss
bp dialog <dialog-id> --accept --prompt "text"
```

Choose accept, dismiss, or prompt text only when it follows from the user's
request and current page state.

## Files and Captures

One-shot capture commands always write a local file and return its path. Supply
an explicit absolute or task-owned path when a later step must find it:

```bash
bp screenshot /absolute/path/page.png
bp screenshot /absolute/path/full.png --full
bp screenshot /absolute/path/chart.png --selector ".chart"
bp pdf /absolute/path/report.pdf --landscape
```

Without a filename, Browser Pilot creates a timestamped file in the current
working directory. Confirm the returned `file` before opening or attaching it.

Upload only a path the user or host has authorized:

```bash
bp upload /absolute/path/resume.pdf
bp upload /absolute/path/photo.jpg --nth 2
```

The upload command verifies browser selection internally and returns a fresh
snapshot. Inspect the page for the expected selected filename or upload result.

## Sensitive Data

Page text, element values, URLs, cookies, auth data, network bodies, screenshots,
and files may be sensitive. Do not print, persist, or repeat values that are not
needed for the task. Prefer stdin or structured host input over command-line
arguments for secrets when the surrounding Agent runtime supports it. Avoid
`bp cookies`, response bodies, and broad `eval` unless the task requires them.

## Recover from Direct CLI Errors

- Not connected: run `bp connect`, wait for authorization, then retry the read
  or state-discovery command.
- Ref not found/stale: run `bp snapshot` and select a ref from that result.
- Selector not found: inspect `bp snapshot` or `bp read`; correct the selector
  instead of repeating it.
- Page load timeout or uncertain action: run `bp tabs`, select the intended tab,
  and inspect with `bp snapshot`/`bp read` before deciding whether to continue.
- Pending dialog: run `bp dialogs` and respond explicitly.
- Missing/closed tab or frame: list tabs/frames again and rebuild state.

Never treat an English error substring as evidence that a mutation did not
happen. Embedded hosts have stable error codes and command outcomes; see the
stdio reference for exact recovery semantics.

## Cleanup

Leave user-owned tabs open unless explicitly asked to close them. For temporary
managed work, close the current managed tab or use `bp close --all` when the
task is complete. Run `bp disconnect` only when the user wants Browser Pilot's
managed window and daemon stopped; it is not required after every command.
