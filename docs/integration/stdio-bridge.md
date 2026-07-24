# Stdio Bridge Integration Contract

Status: browser `tools/call`, scoped Observations, target inventory, Artifacts,
command recovery, event delivery, browser reconnect, and scoped downloads
implemented.

This document describes the Agent-neutral process boundary. Tenon, OpenClaw,
and other Agent hosts use the same executable and protocol. No consumer imports
Browser Pilot source files, links a Native SDK, installs an extension, or needs
an MCP transport.

## Process Launch

Resolve an exact Browser Pilot executable version from one of these locations:

1. The product's bundled dependency.
2. A project-local npm dependency.
3. A compatible global installation selected explicitly by the host.

Launch it directly, without a shell:

```text
browser-pilot bridge --stdio
```

Create pipes for stdin, stdout, and stderr. Stdout is protocol-only. Treat each
stderr line as a diagnostic and never parse it as protocol data.

## Framing

The transport is JSON-RPC 2.0 over newline-delimited UTF-8 JSON:

- one complete JSON object per line;
- ordinary requests are dispatched in input order;
- request IDs are non-empty strings or safe integers;
- notifications have no response;
- the default input limit is 1 MiB per line and the default result limit is
  4 MiB; protocol 1.1 clients may negotiate lower per-Connection limits;
- invalid JSON, invalid UTF-8, invalid envelopes, and oversized input terminate
  that bridge process after an error response with `id: null` when possible;
- output observes stream backpressure;
- at most 256 ordinary calls and 16 out-of-band control calls are pending per
  bridge process; saturation returns retryable `result_too_large` without
  dispatching the rejected call;
- EOF releases every Lease owned by that bridge Connection;
- `shutdown` exits only the bridge process, not the shared per-user daemon.

Hosts must not send concurrent writes that interleave bytes. They may pipeline
complete lines and must correlate responses by JSON-RPC ID. `commands/get`,
`commands/cancel`, and dialog list/respond calls may overtake a pending
`tools/call`, so those responses can arrive earlier. Dialog control needs this
exception because a browser dialog can pause the command that caused it.

## Initialization

`initialize` must be the first successful request on a bridge Connection:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":{"id":"com.example.agent","name":"Example Agent","version":"2.0.0","instanceId":"install:01J..."},"protocol":{"min":{"major":1,"minor":1},"max":{"major":1,"minor":1}},"requestedCapabilities":["browser.control","workspace.manage","observation.read","action.input","artifact.read","event.read"],"launchMode":"embedded","limits":{"maxMessageBytes":1048576,"maxResultBytes":4194304}}}
```

The response returns the selected protocol, supported and granted
capabilities, executable and service versions, a process-stable Broker
identity, a Connection ID, browser candidates, and negotiated limits. Branch
on structured `error.data.code`; never branch on English error messages.

Protocol 1.0 uses the service limits returned by `initialize`. Protocol 1.1 may
send `limits.maxMessageBytes` and `limits.maxResultBytes`; each must be from
64 KiB through 1 GiB. The selected value is the smaller client/service maximum
and applies only to that bridge Connection. `maxArtifactBytes` and
`eventJournalSize` remain service resource limits, not client preferences.

The initialize request and response use the service's fixed bootstrap limits.
The bridge switches limits only after the successful response has been written,
and waits for that switch before parsing a pipelined next line. Oversized
responses become `result_too_large`; oversized best-effort notifications are
dropped and remain recoverable through `events/poll`.

An already-running daemon from an older executable is not replaced while it
may have live clients. Initialization returns `protocol_incompatible` with a
restart remediation instead.

## Lifecycle Methods

The implemented lifecycle surface is:

```text
initialize
tools/list
tools/call
commands/get
commands/cancel
workspaces/create
workspaces/get
workspaces/release
leases/create
leases/heartbeat
leases/release
events/poll
artifacts/get
artifacts/export
artifacts/import
artifacts/retain
artifacts/release
shutdown
```

`workspaces/create` accepts an optional `browserId`. Without one, the Broker
uses its ready browser binding. It returns a Workspace, its default logical
ManagedTabSet, and an `eventCursor`. `workspaces/get` returns the current cursor
as a recovery baseline. Creating a Workspace does not itself create a browser
window; the first managed navigation creates the dedicated browser window.

`leases/create` accepts a `workspaceId` and optional `ttlMs`. The default Lease
is 30 seconds, with a supported range of 1 second through 5 minutes. Heartbeat
well before `expiresAt`. A Lease belongs to its live Connection and cannot be
continued by a replacement bridge process. A replacement Connection from the
same ClientPrincipal may obtain a new Lease for a still-active Workspace.

Workspace identity belongs to `client.id + client.instanceId` for the lifetime
of the daemon. It is transient and is never restored from disk after Broker
restart. A Workspace released twice returns the same successful release result
while its bounded tombstone remains available.

## Tool Calls

`tools/list` returns only operations implemented by the running Broker and
allowed by negotiated capabilities. Call those tools with one uniform envelope:

```json
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"browser.observe","arguments":{"limit":50},"workspaceId":"workspace:...","leaseId":"lease:...","targetId":"target:...","commandId":"command:...","idempotencyKey":"observe:01J...","deadlineMs":30000}}
```

Connection tools omit Workspace fields. Workspace tools require
`workspaceId + leaseId`; target tools additionally require the opaque
`targetId` returned by `browser.tabs.list` or `browser.open`. Raw CDP target and
session IDs are never public inputs. The Broker validates the negotiated
capability, Lease ownership, tool schema, and target control before dispatch.

Every `tools/call` response is a Command outcome:

```json
{"command":{"id":"command:...","status":"completed","method":"browser.observe","idempotencyKey":"observe:01J...","acceptedAt":1,"deadlineAt":30001,"dispatchedAt":2,"completedAt":20,"mutating":false},"result":{"workspaceId":"workspace:...","leaseId":"lease:...","targetId":"target:...","url":"https://example.com","observationId":"observation:...","title":"Example","elements":[],"truncated":false,"truncationReasons":[]}}
```

The manifest's output schema describes the inner `result`. Clients should pass
a unique `commandId` when they may need cancellation; otherwise the Broker
generates one. `idempotencyKey` is optional, but retries must reuse it or reuse
the same caller-supplied `commandId`. Reusing a key for different arguments is
rejected. A duplicate completed call returns the recorded result; a duplicate
that is still accepted or dispatched returns its current Command without
dispatching again.

`commands/get` and `commands/cancel` accept `commandId` plus `workspaceId` for
Workspace commands. They are authorized by Principal ownership rather than the
original Lease, so a replacement bridge from the same product instance can
inspect a known outcome. Cancellation while accepted prevents browser dispatch.
Cancellation after dispatch is best-effort and sets `cancellationRequested`;
it never claims rollback. A mutating command whose deadline elapses after
browser dispatch becomes `unknown_outcome` and is never automatically replayed.
Known tool failures are stored as a completed Command with a nested JSON-RPC
`error`; the original call also returns that error normally.

Inventory includes every eligible ordinary user tab plus the Workspace's
managed tabs. A physical tab can be controlled by only one Lease at a time.
Releasing a Workspace closes managed tabs but leaves user tabs open.

## Events

Every event is first committed to a bounded per-Workspace journal and then
offered as this best-effort notification:

```json
{"jsonrpc":"2.0","method":"events/event","params":{"event":{"id":"event:...","sequence":7,"timestamp":1,"workspaceId":"workspace:...","leaseId":"lease:...","targetId":"target:...","type":"dialog","payloadVersion":1,"sensitivity":"browser_data","payload":{"dialogId":"dialog:...","state":"opened","type":"confirm","message":"Continue?","url":"https://example.com"}}}}
```

Notifications can interleave with responses and can be dropped under transport
backpressure or a disconnected bridge. Treat them as a low-latency signal, not
as the recovery record. Track the last fully processed cursor and poll:

```json
{"jsonrpc":"2.0","id":20,"method":"events/poll","params":{"workspaceId":"workspace:...","cursor":"cursor:6","limit":100}}
```

The result contains ordered `events`, `nextCursor`, and `hasMore`. Continue until
`hasMore` is false. If the cursor predates the retained journal, the Broker
returns `cursor_expired` with `earliestCursor` and `latestCursor`; rebuild tab
and observation state, then call `workspaces/get` to establish a new baseline.
Never infer delivery from notification arrival alone, and never advance the
stored cursor past an event the host has not processed.

Current producers cover command status, Lease expiry, navigation, document
change, target attach/detach, target control, managed popups, dialogs, downloads,
browser connection loss/restoration, network request/response metadata, and
observation invalidation. Network events never contain credentials, headers,
request/response bodies, or raw CDP IDs; retrieve sensitive detail explicitly
through the scoped network tools.

`connection.lost` keeps the last connection generation and causes later browser
tools to fail with retryable `browser_disconnected`. The daemon repeatedly reads
the originally selected profile's debugging endpoint and does not switch profiles.
`connection.restored` carries a strictly newer generation. Existing Workspaces
and active Leases remain valid, but old target IDs, frame IDs, CDP sessions,
Observations, and refs do not. Poll through the restoration event, call
`browser.tabs.list`, and rebuild target state. Never retry a mutating command whose
recorded status is `unknown_outcome`.

JavaScript dialogs remain pending. Use `browser.dialogs.list`, then call
`browser.dialogs.respond` with the returned `dialogId`, target, and explicit
`accept` or `dismiss` action. Browser Pilot never auto-accepts a dialog.

## Artifacts

`browser.capture` and `browser.pdf` return Artifact descriptors, never base64 or
an internal path. Use `artifacts/get` with the owning active Workspace and Lease
to obtain a protected local path, or `artifacts/export` with an absolute path to
copy the file to client-owned storage. Export does not overwrite by default.

Artifacts expire after 15 minutes by default. `artifacts/retain` extends that
to the retained TTL; `artifacts/release` removes the bytes immediately.
Workspace release and Broker shutdown also remove owned temporary bytes.
Directories use mode `0700` and files use `0600` where POSIX permissions apply.

Large screenshots default to a model-sized preview. Pass
`includeOriginal: true` to receive both the original descriptor and a preview
descriptor whose `previewOf` points to the original. The adapter reads the
selected file and converts it to its Agent runtime's native image/file content.

For upload, first call `artifacts/import` with the owning Workspace, active
Lease, and an absolute client-authorized path:

```json
{"jsonrpc":"2.0","id":30,"method":"artifacts/import","params":{"workspaceId":"workspace:...","leaseId":"lease:...","path":"/absolute/path/resume.pdf","mimeType":"application/pdf"}}
```

The Broker copies the source into protected storage and returns an
`upload_input` Artifact descriptor. Pass only its `artifactId` to
`browser.upload`; optionally identify a file input with
`observationId + ref` or `inputIndex`. Output Artifacts such as screenshots and
downloads are rejected as upload inputs. Workspace cleanup deletes the imported
copy but never deletes the client-owned source file.

Downloads have no path-returning tool. Once a controlled target session is
attached, the Broker configures target-session download capture and emits
`download` events with one of these states:

- `capture_unavailable`: that Chrome version rejected target-session isolation;
- `started`: includes an opaque `downloadId`, bounded URL, and suggested filename;
- `completed`: includes the Workspace-owned `download` Artifact descriptor;
- `failed` or `cancelled`: includes a stable, bounded reason and byte metadata.

The private CDP GUID and staging path never appear in protocol output. On
`completed`, use the descriptor's `id` with `artifacts/get` or `artifacts/export`
exactly as for screenshots and PDFs. Staging directories are separate per CDP
session, use mode `0700`, enforce concurrency and byte quotas, and are removed on
session, Lease, or Workspace release. The session setting is restored to
`default` before an attached session is retired. Browser Pilot never calls browser-wide
`Browser.setDownloadBehavior`; unsupported target-session capture remains
unavailable instead of redirecting unrelated user downloads.

## Cleanup

Normal EOF and `shutdown` release Connection-owned Leases immediately. A killed
bridge is recovered by Lease expiry; stale Connection records and inactive
Workspaces are also reclaimed by bounded daemon sweeps. Releasing a Workspace
will eventually close only its Broker-managed targets. It must never close a
user tab merely because a client disconnected or a Workspace expired.

The current lifecycle runtime uses finite limits for live Connections,
per-Principal Workspaces, per-Connection Leases, and retained terminal records.
It does not persist target mappings, refs, cookies, credentials, network bodies,
or command state.

## Current Release Gate

`tools/list` is generated from the canonical schemas used for argument and
result validation, and production filtering prevents unwired tools from being
advertised. The current bridge supports discovery, connect, open, all-tab
inventory, observe/read, core actions, scoped frames, explicit dialogs, cookies,
auth, network observation/rules, eval, screenshot, PDF, protected upload import,
scoped download Artifacts, Artifact access, command recovery, browser reconnect,
and event replay.
An embedding adapter should not ship against this work-in-progress bridge until
multi-browser discovery, remaining browser capability families, and conformance
coverage meet the release gate.
