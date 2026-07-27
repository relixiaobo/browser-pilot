# Browser Pilot Recovery

Read this reference when a command fails, times out, is interrupted, or may
have completed without returning a result.

## Recovery Order

1. Run `bp status` with the same stable client key.
2. Inspect `recovery`, `commands.active`, and `commands.uncertain`.
3. If the failed shell call returned a command ID, run `bp command <id>`.
4. Inspect current tabs and page state before retrying any mutation.
5. Reuse the original `--request-id` only when retrying the same intended call.
   Use a new ID for a new intended action.

`bp commands --status accepted,dispatched,unknown_outcome` lists relevant
recent work. `bp cancel <id>` requests cancellation, but cancellation after
browser dispatch is best effort and may still produce `unknown_outcome`.
When a transport timeout returns `context.commandId`, query that exact command;
do not start a second browser connection or repeat the mutation.

## Stable Error Codes

- `browser_disconnected`: run one `bp connect`, wait for Chrome authorization,
  then list tabs and inspect fresh state.
- `protocol_incompatible`: use a CLI inside the skill's declared compatible
  range. If an older Broker is still live, stop it with the executable that
  started it or use the returned isolation remediation; never replace a live
  process blindly.
- `browser_not_authorized`: follow structured remediation and wait for the
  user. Do not loop connection attempts.
- `profile_selection_required`: list profiles and select one or ask the user.
  Do not reconnect.
- `profile_context_stale` or `profile_context_unavailable`: list profiles again
  and use a fresh selector.
- `stale_ref`: take a new snapshot and choose a ref from it.
- `target_busy`: another Agent controls that physical tab. Wait or choose a
  different tab. Do not close or steal the user's tab.
- `wait_timeout`: the condition was not observed before the deadline. Inspect
  current state; do not assume failure of the underlying browser operation.
- `command_cancelled`: inspect state if the command could already have reached
  the browser.
- `action_not_verified`: dispatch occurred, but expected browser-visible
  evidence did not appear. Inspect instead of repeating blindly.
- `unknown_outcome`: dispatch may have occurred. Never repeat the mutation
  until current state proves that retry is safe.
- `invalid_argument`: correct `context.field` or command syntax.
- `result_too_large`: narrow the query, lower capture scope, or use a file
  result rather than broad output.
- `internal_error`: preserve structured details and stop blind retries.

## State Invalidation

List tabs, profiles, frames, and refs again after browser reconnect, navigation,
document replacement, tab close, frame detach, or an explicit state error.
Indexes and opaque browser identifiers are live inventory values, not durable
bookmarks.

When Profile identity is unavailable, use its neutral label and representative
tabs or ask the user. Never infer an account from a profile directory name.

## Page-Level Recovery

- Resolve a pending dialog before interacting with content behind it.
- Stop after a `repeated_action` hint. Switch to snapshot, text, DOM metadata,
  or an annotated screenshot and change strategy.
- Treat main-document 403 and 429 responses as access state. Check login,
  rate-limit, or another user-approved path instead of repeating navigation.
- If expected content is missing from a bounded result, increase the relevant
  limit or use a narrower representation. Do not infer absence from truncation.
