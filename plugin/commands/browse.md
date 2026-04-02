---
name: browse
description: Browse a website using browser-pilot CLI
user-invocable: true
---

Use the `bp` CLI tool to browse $ARGUMENTS.

Steps:
1. Check if bp is connected: run `bp snapshot`. If it fails, run `bp connect` first.
2. Run `bp open "$ARGUMENTS"` to navigate to the URL.
3. Read the snapshot output to understand the page structure.
4. Follow up with `bp click`, `bp type`, `bp eval` as needed based on the user's goal.

If the user provided a URL, open it directly. If they described a task (e.g., "search Google for X"), navigate to the appropriate site and complete the task.

Always read the `[ref]` numbers from the snapshot before interacting with elements.
