# Embedded Stdio Decision Guide

Read this reference only when implementing or operating an Agent host that
embeds Browser Pilot. The public integration surface is the versioned
`browser-pilot bridge --stdio` executable protocol. Do not import `src/*`, add a
Native SDK dependency, require MCP, or add a browser extension.

For complete envelopes and schemas, use the installed package's
`docs/integration/stdio-bridge.md` and discover the runtime surface through
`tools/list`. This reference defines the Agent decision rules.

## Lifecycle

1. Launch the exact bundled, project-local, or explicitly selected global
   executable directly, without a shell.
2. Send `initialize` first. Negotiate protocol/capabilities and retain the
   returned connection and browser state. Branch on `error.data.code`, never
   English messages.
3. Create a Workspace and retain its initial event cursor.
4. Create a Lease, heartbeat it before expiry, and use that Lease for tool and
   Artifact operations.
5. Call `tools/list`; register only returned tools and preserve every schema,
   including `x-browser-pilot-sensitivity` annotations.
6. List tabs before adopting current browser context. Inventory contains
   managed tabs and eligible user tabs; one physical target is controlled by at
   most one Lease.
7. On shutdown, release the Lease and Workspace, then send `shutdown`. EOF also
   releases Connection-owned Leases, but explicit cleanup is preferable.

Maintain Workspace, Lease, target, frame, Observation, Command, Artifact, and
event cursor identities as opaque values. Never derive or reuse a raw CDP ID.

## Action Decisions

Every Observation-producing action returns a new Observation. Replace previous
refs immediately. Use `observationId + ref` together; neither is a durable
selector.

Interpret `evidence.status` as follows:

| Status | Meaning | Next step |
| --- | --- | --- |
| `verified` | A supported browser-level effect was observed. | Inspect the returned Observation/content for task success. |
| `mismatch` | An observable control did not reach its expected state. | Do not report success; inspect state and change strategy. |
| `unavailable` | Dispatch completed, but no supported effect proved the result. | Inspect current state; retry only when it is clearly safe. |

Evidence never proves a higher-level outcome such as successful payment,
submission, publication, or upload processing. For exact text entry, request
`verification: "require_exact"`; password evidence contains lengths and a
sensitive flag, never the password.

## Hint Decisions

Hints are advisory browser evidence. They neither authorize an action nor prove
success. Ignore unknown hint codes and unknown response fields.

| Hint | Required interpretation |
| --- | --- |
| `autocomplete` | Observe after typing, then choose a returned suggestion ref. |
| `modal_overlay` | Resolve the overlay first when blocking; use only refs from this Observation. |
| `filter_controls` | Review the referenced refinement controls before broad scraping/navigation. |
| `authentication_surface` | Inspect whether the session entered, remains on, or left authentication UI. |
| `access_blocked` | For main-document 403/429, avoid repeating the same navigation. |
| `download` | Wait on `started`; inspect the Artifact on `completed`; inspect bounded failure state otherwise. |
| `repeated_action` | Stop the same action loop, refresh state, and change strategy. |

Do not synthesize hints from framework names or English page text. Follow only
the structured hint and current browser state.

## Error Recovery

| Stable code/state | Recovery |
| --- | --- |
| `stale_ref` | Create a fresh Observation and choose a new ref. Never fall back to another target. |
| `action_not_verified` | Inspect fresh tab/frame/Observation state. Retry only after correcting the stated condition. |
| `unknown_outcome` | Query `commands/get`, inspect current browser state, and never automatically replay the mutation. |
| `browser_disconnected` | Wait for `connection.restored`, relist tabs, reselect target/frame, and re-observe. Old target/frame/ref IDs are invalid. |
| `target_busy` | Another Lease controls the physical target. Choose another tab or wait for release; do not steal control. |
| `target_not_owned` | Rebuild inventory in the owning Workspace; do not substitute a raw target ID. |
| `lease_expired` | Create a new Lease, reacquire target control, and rebuild transient state. |
| `cursor_expired` | Rebuild tab and Observation state, then obtain a new cursor baseline with `workspaces/get`. |
| `artifact_expired` / `artifact_not_found` | Recreate the capture or reacquire the result when safe; never guess an internal path. |
| `result_too_large` | Lower requested limits or retrieve bounded content/Artifacts; do not increase limits without a host reason. |
| `capability_denied` | Respect the host's launch-time operation removal. Do not route around it with another tool. |
| `protocol_incompatible` | Stop integration startup and follow structured remediation. Do not guess a compatible schema. |

The `retryable` flag means a later call may be valid; it does not mean the same
mutating call is safe to repeat. Reuse a caller-supplied Command ID or
idempotency key only for the identical logical call.

## Events and Recovery State

Treat `events/event` notifications as low-latency hints only. Retain the last
fully processed cursor in host session state while that Workspace exists and
recover through `events/poll`. Notifications may interleave with responses or
be dropped under backpressure. A cursor is not browser state to restore after a
Broker restart.

React to these state transitions:

- `observation.invalidated`, navigation, or document change: discard old refs
  and observe again before acting.
- `target.detached`: remove the target from host state and list tabs again.
- `watchdog.frame_detached`: clear selected frame, list frames, and observe.
- `dialog` / `watchdog.dialog_unhandled`: list pending dialogs and expose an
  explicit accept/dismiss action; never auto-accept.
- `watchdog.navigation_stalled`: the navigation outcome is unknown; inspect the
  tab before deciding whether to navigate again.
- `watchdog.no_progress`: stop repeating the same action and change strategy.
- `connection.lost`: pause browser mutations. After `connection.restored`,
  rebuild all target/frame/Observation mappings.
- `download`: wait for a terminal state and use only the completed Artifact.

Process events in sequence order and advance the cursor only after downstream
state has accepted each event.

## Artifacts and Native Model Content

`browser.capture` and `browser.pdf` return descriptors rather than base64 or
internal paths. Large screenshots normally return a model-sized preview; ask
for the original only when the task needs it.

- Use `artifacts/get` to read a protected local path while the Workspace and
  Lease are active.
- Use `artifacts/export` with an absolute host-owned path for durable local
  access. Export does not overwrite by default.
- Convert screenshot preview bytes into the Agent runtime's native image
  content. Convert PDFs/downloads into its native file content when supported.
- Use `artifacts/retain` only when the default TTL is insufficient, and release
  Artifacts after consumption.
- For upload, call `artifacts/import` on an absolute host-authorized path, then
  pass the returned `upload_input` Artifact ID to `browser.upload`.

Propagate each Artifact/Event runtime `sensitivity`. For ordinary tool values,
propagate field-level `x-browser-pilot-sensitivity` from the manifest into any
derived model text, image, or file content. Do not infer classification from
field names, and do not remove taint when transforming content.

## Non-Negotiable Boundaries

- Expose no raw CDP forwarding. Offer `browser.eval` only when the host grants
  `developer.eval`.
- Do not implement a second approval model inside Browser Pilot. The host may
  remove operations at launch or apply its own task approval UX.
- Do not persist refs, browser target mappings, cookies, credentials, network
  bodies, or Command state across Broker restart.
- Releasing a Workspace may clean up managed tabs but must leave user tabs
  open. Closing a user tab is always an explicit targeted action.
