# Waiting and Command Recovery

Use these patterns for browser work that outlives one immediate page action or
when the shell transport may time out.

## Wait for Browser-Visible Conditions

Use exactly one condition per call:

```bash
bp --timeout 30000 wait --url "*/complete"
bp --timeout 30000 wait --text "Payment received"
bp --timeout 30000 wait --selector ".result-row"
bp --timeout 30000 wait --dialog
bp --timeout 120000 wait --download
bp --timeout 30000 wait --popup
```

Add `--interval <ms>` only when the default 250 ms polling interval is
inappropriate. `--timeout` is the overall deadline. A `wait_timeout` result
means only that Browser Pilot did not observe the condition before that
deadline.

Prefer `bp wait` to shell `sleep` and ad hoc polling loops. After a successful
wait, inspect the relevant tab, dialog, download list, or page state.

## Give Retriable Calls Stable Identity

When a host or Agent may lose a shell result, assign a request ID before the
first attempt:

```bash
bp --request-id task-42-submit click 7
```

If the shell result is lost, use the same client key and inspect state:

```bash
bp status
bp commands --status accepted,dispatched,completed,unknown_outcome
bp command <command-id>
```

Reuse `task-42-submit` only to recover or retry that same intended click. A new
action must receive a new request ID. Browser Pilot deduplicates a stable
request before redispatch, but page state still must be inspected when an
outcome is uncertain.

## Cancellation

```bash
bp cancel <command-id>
```

Cancellation is deterministic before dispatch and best effort afterward. If
the returned state is `unknown_outcome`, inspect the page before choosing any
next action.

`bp wait` is a CLI-side condition loop, not one long Broker command. Stop that
CLI process with `SIGINT` or `SIGTERM`; it returns `command_cancelled` and
leaves the shared Agent browser state intact. There is no wait command ID to
pass to `bp cancel`.

For a CLI process currently awaiting a Broker command, `SIGINT` and `SIGTERM`
also trigger a best-effort cancellation request for that active command. They
do not prove that browser-side effects were rolled back.
