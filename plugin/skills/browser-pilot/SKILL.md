---
name: browser-pilot
description: >
  Control the user's eligible Chrome tabs through the `bp` CLI without a browser
  extension. Use for browsing signed-in websites, reading pages, filling forms,
  operating web apps, handling tabs, frames, dialogs, uploads, downloads,
  screenshots, PDFs, cookies, HTTP auth, or network activity. Also use when
  integrating Browser Pilot into a shell-capable Agent host.
---

# Browser Pilot

Use the Agent's existing shell command runner to invoke `bp`. Operate the user's
real Chrome profiles with their current logins, cookies, and extensions. Do not
look for an MCP server, SDK, browser extension, native Browser Pilot tool, or
persistent Browser Pilot client process.

Browser Pilot can control eligible user-opened tabs as well as tabs it creates.
Browser-internal and extension-owned pages are excluded.

## Check and Install the CLI

Browser Pilot requires the `bp` executable. Before the first browser operation
in every task, read [compatibility.json](compatibility.json), then check the
resolved command and version with the current shell (`command -v bp` on POSIX
or `Get-Command bp` on PowerShell), followed by:

```bash
bp --version
```

Continue only when the reported semantic version is inside
`browserPilotCli.supportedVersionRange`, whose lower bound is the required
minimum version. If `bp` is absent or outside that range:

1. Read `browserPilotCli.installation`. Use its exact native version and
   repository; never substitute GitHub `latest` or npm `@latest`.
2. Invoke the installer path declared for the current shell, resolved relative
   to this `SKILL.md`, through the Agent's normal shell approval flow:

   ```text
   POSIX: sh <posixInstaller> --version <native.version> --repository <native.repository>
   Windows: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <windowsInstaller> -Version <native.version> -Repository <native.repository>
   ```

3. Fall back to npm only when the native installer exits with the exact
   `native.unsupportedPlatformExitCode`. Check `node --version` and
   `npm --version`, require `npmFallback.requiredNodeVersion`, then run the
   exact `npmFallback.installCommand`. Do not fall back after a download,
   checksum, extraction, command-conflict, or filesystem failure.
4. Resolve `bp` again and re-check `bp --version` against the supported range.
   If the installer reports `path_ready=false`, or another command still wins
   on `PATH`, stop and report the returned `bin_directory`; do not edit shell
   startup files or the system `PATH` silently.

Do not assume the Agent host installs Browser Pilot. A compatible executable
already on `PATH` may be used regardless of whether a user, the Agent, or the
host provided it. Native macOS releases require Apple Silicon; Intel Mac is
unsupported.

## Connect Deliberately

Before the first browser operation in a task, run `bp status`. It is passive and
does not request Chrome authorization. If it reports a usable session, continue
with `bp tabs`; do not reconnect or mention setup to the user.

If status or a browser command reports `browser_disconnected`, run `bp browsers`
and follow the selected candidate's structured remediation before connecting:

- `start_browser`: ask the user to start that browser.
- `enable_remote_debugging`: give the user
  `chrome://inspect/#remote-debugging` and ask them to enable remote debugging
  in that browser. If the setting is unavailable, Chrome 144 or newer is
  required.
- `restart_remote_debugging`: ask the user to restart that browser and enable
  remote debugging again.
- `connect_browser` or `authorize_remote_debugging`: an explicit connection is
  appropriate.

Do not run `bp connect` while the browser is stopped or remote debugging is
disabled. Wait for the user to complete the requested setup, then run
`bp browsers` again. If several usable browser candidates match and the task
does not identify one, ask the user which browser to control; pass its returned
ID to `bp connect --browser <id>`.

Immediately before invoking `bp connect`, tell the user that Chrome may show an
Allow dialog and ask them to click Allow once if it appears. Send this message
before the shell call: machine-readable CLI output is emitted only when the
command finishes, so the command cannot provide the reminder while it waits.

Run exactly one connect attempt and wait for that process. Do not launch another
attempt while it is pending; all CLI clients share one pending browser
connection. If the call times out, is interrupted, or returns
`browser_not_authorized`, inspect `bp status` and the returned command before
deciding what to do. Never loop `bp connect`.

One connection covers all live Chrome profiles on that endpoint. When several
profiles are open:

1. Run `bp profiles`.
2. Use representative tabs when they identify the intended profile.
3. Run `bp profiles --identify` only when account-aware names are necessary.
   This briefly opens and closes one visible `chrome://version` page for each
   unidentified profile.
4. Select with `bp profile <index>`, or ask the user if several verified
   accounts still match.

Profile selection routes newly created managed tabs. It does not limit access
to existing eligible tabs.

## Preserve Agent State

Reuse one stable `BROWSER_PILOT_CLIENT_KEY` on every Browser Pilot call made by
the same independent Agent. Different Agents must use different keys. Do not
generate a key for every command.

The key preserves that Agent's selected browser profile, tab, frame, current
refs, auth configuration, network rules, downloads, and recent command state
across short-lived CLI processes. The default key is suitable only when one
interactive Agent uses Browser Pilot.

Product integrators must read
[references/embedding.md](references/embedding.md). The Agent still invokes
the resolved `bp` CLI through its ordinary shell tool.

## Operate from Current State

1. Resolve the intended tab.
   - If the user refers to a page already open, run `bp tabs`, identify it by
     title, URL, origin, and profile, then select it with `bp tab <index>`.
   - For independent work, prefer `bp open <url> --new`.
   - Use plain `bp open <url>` only when replacing the selected tab is intended.
2. Inspect the smallest useful representation.
   - Use `bp snapshot` for controls and numbered refs.
   - Use `bp read [selector]` for readable page content.
   - Use `bp search <text>` for a phrase and nearby context.
   - Use `bp find <selector>` for bounded DOM metadata.
   - Use `bp screenshot --annotate` when layout, overlap, canvas content, or
     visual position matters.
3. Act on fresh state.
   - Prefer `bp click <ref>` and `bp type <ref> <text>`.
   - Prefer `bp scroll`, `bp dropdown`, and `bp select` for their dedicated
     behaviors.
   - Treat refs as valid only for the selected tab, frame, and current page
     state. Refresh after navigation, tab/frame changes, or `stale_ref`.
   - Use `bp locate <selector>` plus `bp click --xy x,y` for canvas, maps,
     charts, or controls missing from the snapshot.
4. Verify the result.
   - Inspect returned URL, content, control state, and action evidence.
   - A successful dispatch does not by itself prove a purchase, message,
     upload, or other business outcome succeeded.
   - After a timeout or uncertain mutation, inspect state before any retry.
5. Use `bp eval` only when no dedicated command can perform the operation.

```bash
bp tabs
bp tab 2
bp open "https://example.com" --new
bp snapshot
bp read "main" --limit 10000
bp search "invoice total"
bp click 3
bp type 5 "hello" --clear
bp press Enter
```

Read [references/commands.md](references/commands.md) when an option or command
is not covered here.

## Handle Tabs, Frames, and Dialogs

`bp tabs` includes eligible grouped and ungrouped Chrome tabs even when a tab
group is collapsed. Browser Pilot cannot inspect or manage tab groups without
an extension; group membership does not affect control of an eligible tab.

`bp close` explicitly closes the selected tab, including a user-owned tab.
`bp close --all` closes only Browser Pilot-created tabs. Leave user tabs open
unless the request requires closing them.

Use `bp frame`, `bp frame <index>`, and `bp frame 0` to list, select, and leave
frames. Refresh the snapshot after changing frames.

Known limitations: snapshots can omit controls inside same-process iframes,
and selector-based commands can resolve against the top frame after selecting
a subframe. Prefer fresh semantic refs when they are present. Otherwise use
`bp eval` in the selected frame or a visual coordinate action, verify the
result, and do not assume an empty snapshot proves that the iframe has no
controls.

JavaScript dialogs remain pending until explicitly handled:

```bash
bp dialogs
bp dialog <dialog-id> --accept
bp dialog <dialog-id> --dismiss
```

Choose an action only when it follows from the user's request and page state.

## Handle Files and Visual Results

Set `BROWSER_PILOT_OUTPUT_DIR` to a task-owned absolute directory for durable
results:

```bash
bp screenshot page.png
bp pdf report.pdf
bp downloads
bp download 1 export.bin
```

When `BROWSER_PILOT_OUTPUT_DIR` is set, every capture, PDF, download export, and
saved network body must stay inside it; outside absolute paths and `..` escapes
are rejected. Without it, explicit filenames and then the current working
directory remain available. Read the returned absolute `file` path. When visual
inspection is needed, open that image with the Agent host's existing image/file
viewing capability. Browser Pilot intentionally returns a local path through
CLI JSON rather than embedding binary data in shell output.

Upload only a user- or host-authorized local path. Browser Pilot copies files
for transport and never removes the source or Chrome's original download.

## Wait and Recover

Use `bp wait` instead of shell sleep loops for browser-visible conditions. Use
`bp status`, `bp commands`, `bp command <id>`, stable `--request-id`, and
`bp cancel <id>` when a shell call times out, is interrupted, or loses its
result. Read [references/async.md](references/async.md) for exact patterns.

Machine failures return stable `code` and `retryable` fields. Branch on `code`,
not English text. Never interpret `retryable: true` as permission to repeat an
uncertain mutation. Read [references/recovery.md](references/recovery.md) when a
command fails or state may be stale.

## Protect Sensitive Data

Page content, URLs, cookies, credentials, network bodies, screenshots, and
files may be sensitive. Return or persist only what the task needs. Avoid broad
cookie, body, or JavaScript reads when a narrower command works.

Run `bp disconnect` only when asked to release this Agent's browser state. It is
not routine per-task cleanup and does not stop a shared service still used by
another Agent.
