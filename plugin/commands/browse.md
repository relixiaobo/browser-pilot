---
name: browse
description: Browse a website using browser-pilot CLI
user-invocable: true
---

Use the `bp` CLI tool to browse $ARGUMENTS.

Steps:
1. Read `skills/browser-pilot/compatibility.json`, run `bp --version`, and use
   the CLI when it satisfies `browserPilotCli.supportedVersionRange`. Otherwise
   stop and resolve a compatible executable.
2. Check `bp tabs` first when the request may refer to a page the user already
   opened. Select it with `bp tab <index>`.
3. If a new URL is needed, run `bp open "$ARGUMENTS" --new` unless replacing the
   current tab is clearly intended. Run one `bp connect` only after a
   `browser_disconnected` error.
4. Use `bp snapshot` for controls and `bp read` for page content.
5. Use fresh refs with `bp click` or `bp type`, then verify the returned state.
   Use `bp eval` only when semantic commands cannot perform the operation.

If the user provided a URL, open it directly. If they described a task (e.g., "search Google for X"), navigate to the appropriate site and complete the task.

Never reuse refs after navigation or a tab/frame change. Do not blindly retry a
mutation after an uncertain failure. Dialogs require an explicit `bp dialogs`
and `bp dialog ... --accept|--dismiss` decision.
