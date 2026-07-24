# Stdio Bridge Integration Contract

Status: browser `tools/call`, scoped Observations, target inventory, and
Artifacts implemented; command recovery and events remain release blockers.

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
- the default input limit is 1 MiB per line;
- the default result limit is 4 MiB;
- invalid JSON, invalid UTF-8, invalid envelopes, and oversized input terminate
  that bridge process after an error response with `id: null` when possible;
- output observes stream backpressure;
- EOF releases every Lease owned by that bridge Connection;
- `shutdown` exits only the bridge process, not the shared per-user daemon.

Hosts must not send concurrent writes that interleave bytes. They may pipeline
complete lines and must correlate responses by JSON-RPC ID. `commands/get` and
`commands/cancel` may overtake a pending `tools/call`, so those responses can
arrive earlier; all other calls preserve dispatch order.

## Initialization

`initialize` must be the first successful request on a bridge Connection:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":{"id":"com.example.agent","name":"Example Agent","version":"2.0.0","instanceId":"install:01J..."},"protocol":{"min":{"major":1,"minor":0},"max":{"major":1,"minor":0}},"requestedCapabilities":["browser.control","workspace.manage","observation.read","action.input","artifact.read"],"launchMode":"embedded"}}
```

The response returns the selected protocol, supported and granted
capabilities, executable and service versions, a process-stable Broker
identity, a Connection ID, browser candidates, and negotiated limits. Branch
on structured `error.data.code`; never branch on English error messages.

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
artifacts/get
artifacts/export
artifacts/retain
artifacts/release
shutdown
```

`workspaces/create` accepts an optional `browserId`. Without one, the Broker
uses its ready browser binding. It returns a Workspace and its default logical
ManagedTabSet. Creating a Workspace does not itself create a browser window;
the first managed navigation creates the dedicated browser window.

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
advertised. The current bridge supports discovery, connect, open, tab inventory,
observe/read, core actions, cookies, eval, screenshot, PDF, and Artifact access.
An embedding adapter should not ship against this work-in-progress bridge until
browser reconnect handling, event replay, and the remaining advertised browser
families are complete.
