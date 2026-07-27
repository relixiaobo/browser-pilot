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

## Verify Compatibility

Read the bundled [compatibility.json](compatibility.json). Its
`browserPilotCli` block declares the version tested with this skill and its
supported CLI range. Before the first Browser Pilot operation in a task, check
both command resolution and version:

```bash
command -v bp
bp --version
```

If `bp` is absent, install
`browser-pilot-cli@<browserPilotCli.testedVersion>`. If the resolved version is
outside `browserPilotCli.supportedVersionRange`, stop and use a compatible
release; do not silently drive an incompatible global CLI. A newer version
inside the declared range is valid. Embedded products should still pin the
tested version for reproducible distribution.
macOS native releases support Apple Silicon only, not Intel.

## Select the Interface

- For an Agent with shell access completing a browser task now, use the
  one-shot commands in this file.
- For a product embedding long-lived browser control, read
  [references/embedded-stdio.md](references/embedded-stdio.md). Do not drive the
  NDJSON bridge manually for an ordinary browsing task.
- Read [references/commands.md](references/commands.md) only when a command or
  option is not covered here.

## Prepare

Chrome remote debugging must be enabled at
`chrome://inspect/#remote-debugging`. Connect only when a command returns
`browser_disconnected`:

```bash
bp connect
```

Chrome may require the user to click Allow. Do not claim connection until the
command succeeds. `bp browsers` is passive and never prompts. While one
`bp connect` is waiting for Allow, do not launch another; all clients reuse the
same pending service-side connection.

One successful connection covers all live Chrome Profiles exposed by that
browser endpoint. If `bp connect` reports multiple Profiles, do not connect
again. Run passive `bp profiles` first. If representative tabs do not make the
choice clear, run `bp profiles --identify`; this explicit command briefly opens
and closes one visible `chrome://version` page per unidentified Profile and
returns only identity verified against Chrome's reported Profile path. Select
with the one-based `bp profile <index>`, or ask the user when several verified
accounts still match. Profile selection routes new managed tabs and does not
grant or restrict access to existing tabs.

When this Agent shares the one-shot CLI with other independent Agents, set a
stable Agent-specific `BROWSER_PILOT_CLIENT_KEY` (or global `--client-key`) on
every command. Commands with one key reuse their target, frame, refs, auth, and
network state; different keys are isolated. Do not generate a new key per tool
call. Embedded `bridge --stdio` hosts already receive isolated lifecycle state.

## Operate from Current State

1. Resolve the intended tab.
   - If the user refers to a page already open, run `bp tabs`, identify it by
     URL/title/origin/Profile context, then run `bp tab <index>`.
   - For independent work, prefer `bp open <url> --new` so an unrelated user tab
     is not replaced.
   - If several Profiles are live and the new tab must use a specific one, run
     `bp profiles` and use
     `bp open <url> --new --profile <index|id|label|verified-name|verified-email>`.
   - Use plain `bp open <url>` only when navigating the currently selected tab
     is intended.
2. Inspect the right representation.
   - Run `bp snapshot` for controls and numbered refs.
   - Run `bp read [selector]` for article text, search results, lists, prices,
     and other non-interactive content.
   - Run `bp search <text>` when only the locations and nearby context of a
     specific phrase are needed; this avoids returning the whole page.
   - Run `bp find <selector>` for bounded DOM metadata such as visibility,
     geometry, role, or explicitly requested attributes. It does not create
     actionable refs.
   - Use `bp screenshot --annotate` after a snapshot when visual position,
     overlapping UI, a canvas, or layout matters. The numbered boxes refer to
     that snapshot.
   - If `bp read` reports `truncated`, increase its `--limit`. If an expected
     control is absent from a bounded snapshot, refresh with a larger
     `--limit`; do not infer that omitted content is absent.
3. Act on fresh state.
   - Prefer `bp click <ref>` and `bp type <ref> <text>` over selectors or
     coordinates.
   - Prefer `bp scroll`, `bp dropdown`, and `bp select` over scripting common
     page movement or dropdown behavior with `eval`.
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
   through the dedicated tab, observation, search, scroll, dropdown, capture,
   or action commands.

## Core Commands

```bash
bp tabs                              # all controllable managed and user tabs
bp tab 2                             # select tab index 2
bp profiles                          # passive live Chrome Profile contexts
bp profiles --identify              # verified Profile/account identity
bp profile 1                         # route subsequent managed tabs
bp open "https://example.com" --new  # create an independent managed tab
bp open "https://example.com" --new --profile 1
bp snapshot                          # interactive controls with refs
bp read                              # readable page content
bp read "main" --limit 10000         # bounded region text
bp search "invoice total"            # targeted visible-text matches
bp find "a.result" --attributes href # bounded DOM metadata
bp scroll down                       # move 0.8 viewport; return fresh state
bp scroll --to-text "Payment details" # reveal matching text
bp dropdown 4                        # enumerate dropdown options
bp select 4 "United States"          # select and verify an option
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
- Treat the `page` block returned with snapshots as navigation context: it
  reports viewport/document size, scroll position, remaining pixels, and
  scroll percentages.
- After typing, confirm the displayed/effective value when the task depends on
  exact input. Frameworks may sanitize or reject input.
- For an autocomplete field, type first, inspect the updated snapshot, then
  select the intended suggestion. Do not assume typed text selected an item.
- If a modal or dialog blocks the page, resolve it before interacting with the
  content behind it.
- If a `repeated_action` hint reports either repeated mismatch or
  `stagnant_page`, stop repeating it. Switch representation (`snapshot`,
  `read`, `search`, or annotated screenshot), inspect fresh state, and change
  strategy.
- Treat a main-document 403/429 as an access state. Do not loop the same
  navigation; inspect login state, rate limits, or an alternate user-approved
  path.

## Tabs, Frames, and Dialogs

`bp tabs` includes eligible user tabs as well as Browser Pilot managed tabs.
Selecting a user tab makes it the current controlled tab. `bp close` explicitly
closes the current tab even when it is user-owned; `bp close --all` closes only
managed tabs. Do not close a tab unless the task requires it.

Tab indexes are one-based. In JSON, `selected` means selected for this Agent's
Lease; it does not mean Chrome's foreground tab or operating-system focus.
Browser-internal and extension-owned pages are excluded from ordinary tab and
Profile representative inventory.

Chrome tab groups do not change tab eligibility: Browser Pilot can control an
eligible grouped tab whether its group is expanded or collapsed. Without an
extension it cannot inspect group membership or create, rename, move, collapse,
or delete tab groups, so do not infer group state from the tab inventory.

Tabs may span several live Chrome Profiles under one authorized browser
connection. Existing tabs need no prior Profile selection. `profileContextId`
and `bp profiles` are routing context for new managed work; after Chrome
reconnect, list Profiles and tabs again instead of reusing an old ID.

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
bp snapshot
bp screenshot /absolute/path/annotated.png --annotate 1,3,8
bp pdf /absolute/path/report.pdf --landscape
```

Without a filename, Browser Pilot creates a timestamped file in the current
working directory. Confirm the returned `file` before opening or attaching it.
Annotations support viewport screenshots only and require the latest live
snapshot; omit the ref list to annotate up to the first 200 refs. They are drawn
in an isolated JavaScript world on an off-page canvas and never expose bytes to
page scripts or inject overlay elements into the user's document.

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

Non-TTY failures always return `ok: false`, `error`, stable `code`, and
`retryable`, with optional `context`, `remediation`, and `hint`. Branch on
`code`, never on English text. `retryable: true` means a later call may be
valid; it never makes an uncertain mutation safe to replay automatically.

- `browser_disconnected`: run one `bp connect`, wait for authorization, then
  relist tabs and obtain fresh state. Never start concurrent connection attempts.
- `browser_not_authorized`: follow `remediation`; do not loop `bp connect` or
  claim success before Chrome authorizes the request.
- `profile_selection_required`: run `bp profiles`; select from fresh results or
  ask the user when the intended Profile is ambiguous. Do not reconnect.
- `profile_context_stale` or `profile_context_unavailable`: list Profiles again
  and follow the structured
  remediation. Do not substitute an old ID or silently choose the first entry.
- Profile identity unavailable in a successful Profile result: use its neutral
  label and representative tabs,
  or ask the user. Never infer an account from the Profile directory or retry
  identity without an explicit `--refresh` decision.
- `stale_ref`: run `bp snapshot` and select a ref from that result.
- `target_busy`: another Agent controls that physical tab. Choose another tab
  or wait; never steal control or close the user's tab to force a handoff.
- `action_not_verified` or `unknown_outcome`: inspect current tab state before
  deciding whether any retry is safe.
- `invalid_argument`: correct the reported `context.field` or invocation.
- `internal_error`: preserve the error details and stop blind retries.
- Selector not found in a successful/failed operation: inspect `bp snapshot` or
  `bp read`; correct the selector
  instead of repeating it.
- Pending dialog: run `bp dialogs` and respond explicitly.
- Missing/closed tab or frame: list tabs/frames again and rebuild state.

Never treat an English error substring as evidence that a mutation did not
happen. Embedded hosts additionally expose Command lookup and events; see the
stdio reference for exact recovery semantics.

## Cleanup

Leave user-owned tabs open unless explicitly asked to close them. For temporary
managed work, close the current managed tab or use `bp close --all` when the
task is complete. Run `bp disconnect` only when the user wants Browser Pilot's
managed window and daemon stopped; it is not required after every command.
