# Browser Pilot Platform Specification

Status: **Authoritative, approved for implementation**  
Baseline: `0c5661ccb133b2c9feda15732892f66ce947f232`  
Last updated: 2026-07-25

This document is the source of truth for turning Browser Pilot from a
single-agent CLI with global state into a user-level browser control runtime
that any local Agent can install or embed. The two execution plans in
`docs/plans/` derive from this specification.

## Purpose and Reader

This specification is for Browser Pilot maintainers, Agent-product integrators,
security reviewers, and test authors. It defines observable behavior and
compatibility boundaries before implementation. Internal component names near
the end are implementation boundaries required to preserve those behaviors;
they are not third-party APIs.

## Evidence and Assumptions

Evidence from the baseline repository:

- The npm package currently publishes CLI binaries but no library exports.
- High-level actions, output formatting, file writes, and process exits are
  combined in `src/cli.ts`.
- `src/state.ts` persists one active target, CDP session, and frame context.
- `src/snapshot.ts` persists one target's refs in a global file.
- `src/daemon.ts` exposes arbitrary CDP and keeps auth, network, dialog, and
  popup state globally.
- Existing fixtures prove the current browser operations are worth preserving.

Evidence from the browser-use comparison is recorded in
`docs/plans/browser-capability-evolution.md` at the pinned research commit.

Assumptions used by this specification:

- Supported Agent runtimes can spawn a local child process and read protected
  local Artifact files.
- Browser Pilot and embedded Agents execute under the same OS user account.
- Chrome continues to require an explicit user action to enable or authorize
  remote debugging.
- An Agent product can map its own active lifecycle to Workspace and Lease
  without Broker knowledge of that product's domain nouns.

## Decision Summary

- **DEC-1:** Browser Pilot is an Agent-neutral, per-OS-user Browser Broker. It
  is not a Tenon component and does not model conversations, runs, tasks, or
  workers.
- **DEC-2:** Root Chrome DevTools Protocol (CDP) is the only browser connector.
  Browser extensions are never required or supported.
- **DEC-3:** The public product surface is one official CLI executable. It
  supports human one-shot commands and a persistent `bridge --stdio` machine
  mode. Native SDK and MCP surfaces are out of scope.
- **DEC-4:** Existing one-shot `bp` commands remain a first-class integration
  path. Embedded products bundle the same executable and use the stdio bridge.
- **DEC-5:** The production machine interface exposes controlled browser tools,
  not arbitrary CDP forwarding. Raw CDP is internal. JavaScript evaluation is
  an explicit developer capability.
- **DEC-6:** Invoking Browser Pilot grants the Agent full control of all
  eligible current and future tabs in the selected BrowserInstance. Browser
  Pilot does not implement task-intent approval, selected-tab grants, or
  per-action confirmation. An Agent host may remove operations when launching
  the Broker, and owns any higher-level approval UX it wants.
- **DEC-7:** Browser profile state is shared because controlled targets run in
  the user's browser profile. Target assignments, commands, refs, rules, and
  artifacts are isolated by Broker objects.

## Objective, Constraints, and Selected Target

- **OBJ-1:** Any local Agent that can execute a process must be able to control
  the user's real browser reliably, while preserving the user's profiles,
  logins, cookies, and installed extensions.
- **OBJ-2:** Multiple unrelated Agent products must be able to use Browser Pilot
  concurrently without overwriting each other's target, frame, ref, auth, or
  network state.
- **OBJ-3:** Agents that already install and call `bp` themselves must continue
  to work after the platform migration.
- **Minimum acceptable outcome:** The compatibility requirements in this spec
  all pass. A partial SDK, Tenon-only adapter, or globally shared target state
  does not count.
- **Clean-slate answer:** A signed, self-contained executable with a local
  Broker, versioned stdio protocol, complete browser control, strong runtime
  isolation, and a conformance kit.
- **Selected brownfield target:** Evolve the current TypeScript/npm CLI into
  that architecture without replacing proven CDP capabilities or breaking the
  current command workflow.

### Constraints

- **CON-1 hard:** No browser extension may be used.
- **CON-2 hard:** All eligible ordinary Chrome tabs in the selected
  BrowserInstance are visible and controllable. DevTools, unsupported internal
  pages, and Browser Pilot's own internal targets remain excluded.
- **CON-3 hard:** Browser Pilot must not depend on Agent-specific lifecycle
  concepts or model-provider APIs.
- **CON-4 hard:** Production clients cannot invoke arbitrary root CDP methods.
- **CON-5 hard:** Sensitive browser data and media must not be emitted to logs
  or world-readable files.
- **CON-6 legacy:** Existing `bp` commands, JSON output, npm installation, and
  the current Agent skill must remain usable during migration.
- **CON-7 platform:** Without an extension, root CDP exposes the browser to any
  process that can independently reach its debugging endpoint. Broker
  isolation protects Broker clients from each other; it is not an OS sandbox.
- **CON-8 scope:** The universal integration target is local Agents that can
  spawn a process and access local files. Hosted Agents without a local
  execution bridge are not supported by CLI-only distribution.

### Rejected Alternatives

- **OPT-1 MCP as the canonical interface:** Rejected because it creates a
  second public product surface and runtime dependency. An Agent adapter may
  translate the stdio bridge to MCP outside Browser Pilot.
- **OPT-2 Native SDKs:** Rejected because every language binding would create a
  versioned compatibility obligation. The executable protocol is the SDK.
- **OPT-3 One-shot CLI only:** Rejected because it cannot efficiently deliver
  events, cancellation, leases, or repeated tool calls to an embedded Agent.
- **OPT-4 Agent-specific embedding:** Rejected because Tenon and OpenClaw are
  clients and conformance fixtures, not Broker domain concepts.

### Revisit Triggers

Reconsider MCP or a remote protocol only if Browser Pilot must support Agents
that cannot spawn a local process. Reconsider SDKs only if the stdio protocol
cannot provide required performance or type safety after measured use.

## Preserved and Changed Behavior

### Preserved

- Agent-managed installation via npm and direct `bp` invocation.
- Chrome remote-debugging discovery and connection.
- A distinct visible Pilot window using the user's browser profile.
- AX snapshots and numbered refs.
- Navigation, click, type, keyboard, upload, tabs, frames, dialogs, HTTP auth,
  screenshots, PDF, cookies, and network tooling.
- Human-readable terminal output and JSON output for scripts.
- The existing skill and Playwright fixture coverage.

### Changed

- CLI handlers become presentation adapters over reusable Broker services.
- Global active target/session/frame state becomes isolated Workspace and Lease
  state.
- The single refs file becomes observation-scoped Broker state.
- The daemon's arbitrary `/cdp` endpoint becomes private implementation wiring.
- Dialogs become explicit events and decisions; they are not auto-accepted.
- Popup adoption requires a verified owned opener chain.
- Existing user tabs and newly opened tabs are included automatically in the
  Workspace inventory; invoking the tool is the authorization boundary.
- Auth, network rules, request journals, and artifacts are scoped and cleaned up
  by the owning Workspace or Lease.
- Screenshots and PDFs become mode-restricted, owner-scoped Artifact results
  with quotas and expiry. The human CLI may export an Artifact to a
  caller-selected path.

## Product Model

### ClientPrincipal

A stable identity for an installed Agent product or direct CLI user. It owns
Workspaces and their transient resources. It is used for correlation and
isolation, not as proof that an Agent's semantic decision is correct. A
Principal is not a conversation or task.

### ClientConnection

One live `bridge --stdio` process connection. It is authenticated by the local
Broker and associated with exactly one ClientPrincipal after initialization.

### BrowserInstance

One running, discoverable Chromium-family browser process identified by a
process-stable identity, product, profile path, debugging endpoint, and
connection generation.

### BrowserWorkspace

A logical browser working set owned by one ClientPrincipal. It owns one or more
ManagedTabSets and transient scoped state. Workspaces live in Broker memory by
default and are recreated after Broker restart; Agent adapters map their own
active lifecycle to this object.

### ManagedTabSet

The logical collection of Broker-created tabs used for isolated Agent work. It
is normally backed by a dedicated visible Pilot window because Browser Pilot
does not use extension-only native tab-group APIs. New task navigation and
owned popups stay in this set by default. Workspace cleanup may close this set,
but never user-owned tabs outside it.

### ControlLease

A time-bounded command session in a Workspace. It carries negotiated
capabilities, heartbeat expiry, and explicit target control assignments. Agent
adapters map their own active work lifecycle to this object.

### BrowserControlPolicy

An optional launch-time reduction of Browser Pilot operations configured by
the Agent host, for example disabling `network.modify` or `tabs.close`. The
default policy allows every supported operation. This is tool exposure, not a
Browser Pilot approval lifecycle, and it cannot be expanded through a tool call
inside the running bridge.

### ControlledTarget

A target addressable by a Workspace. Its origin is `managed`, `managed_popup`,
or `user_tab`, and it records an optional ManagedTabSet. A user tab retains user
ownership: releasing a Workspace removes Broker mappings without closing the
tab. Every result identifies its Workspace, Lease, opaque controlled-target ID,
URL, origin, and browser connection generation. Raw CDP target IDs are not a
public identifier.

### Observation

An immutable, bounded view of a ControlledTarget at a point in time. Public element
handles are `observationId + ref`. Observations are never shared between
Workspaces.

### AgentHint

A bounded, discriminated browser-state signal attached to an Observation or
event. A hint has a stable `code`, `source`, `confidence`, and
`recommendedAction`, plus code-specific public data. Hints report browser
evidence and a useful next inspection strategy; they never approve an action,
assert that the task succeeded, or replace fresh Observation and event state.

### Command

A requested operation with a unique command ID, idempotency key, deadline,
capability requirement, and target assignment. Each target serializes its
commands through one actor.

### Artifact

A Broker-managed binary result such as a screenshot, preview, PDF, or download.
Artifacts have metadata, sensitivity, ownership, size limits, retention state,
and expiry.

### BrowserEvent

A typed, ordered event in a bounded per-Workspace journal. Events can be pushed
over stdio and replayed with a cursor. Every event carries the browser connection
generation of its source. Ordinary events from a retired generation are dropped;
Command terminal state and explicit reconnect cleanup remain replayable with
their historical generation.

## Public Executable Surface

The official distribution exposes one executable under both `browser-pilot`
and the compatible `bp` alias.

```text
browser-pilot
  broker serve
  bridge --stdio
  tool list
  tool call
  artifact export|release
  browsers|connect|disconnect|open|snapshot|click|type|keyboard|press
  read|eval|upload|screenshot|pdf|cookies|frame|auth|tabs|tab|close|net
```

Three distribution modes are equivalent:

1. User or Agent global installation.
2. Project-local installation and `npx browser-pilot` invocation.
3. Product-bundled official executable launched by an Agent adapter.

Embedded products must not import `src/*`, depend on daemon socket details, or
parse human-readable output.

The npm distribution contains bundled JavaScript entry points for the CLI,
Broker, and managed-target janitor and requires Node 18 or newer. The native
distribution is one Node SEA executable containing the runtime and JavaScript
dependencies. It re-executes itself with reserved private role arguments for
Broker and janitor processes; it neither downloads a runtime nor falls back to
system Node. Both layouts derive executable installation identity from the
public entry point, so private child roles do not create false version
boundaries.

Native artifacts are built and verified on their target OS and architecture.
Each archive includes an actual-state signature descriptor, file sizes and
SHA-256 hashes, runtime/dependency licenses, and an archive checksum. macOS uses
Developer ID signing with hardened runtime and explicit JIT entitlements when
credentials exist, otherwise ad-hoc signing. Windows uses Authenticode when a
certificate exists, otherwise records unsigned state. Linux records unsigned
state. Build or release automation must fail on incomplete credentials and
must never describe an artifact as signed when signing did not run.

### Broker Locator and Startup

The executable, not an embedding Host, resolves the per-user Broker endpoint.
On Unix it uses an owner-only domain socket and falls back to a deterministic
short owner-specific runtime directory when the state path would exceed
portable socket limits. On Windows it uses a named pipe derived from the OS
user identity. Persistent state defaults to the Browser Pilot user directory
(`%LOCALAPPDATA%\\Browser Pilot` on Windows). An explicit absolute
`BROWSER_PILOT_HOME` is the cross-platform installation-level isolation
override. It is never selected automatically.

State/runtime directories are mode `0700` and regular metadata files are mode
`0600` where POSIX modes apply. The socket is mode `0600`; Windows relies on the
creating user's process-token DACL for its local named pipe. Symlinked final
directories and metadata, foreign ownership, unexpected file types, and
overly-permissive metadata are rejected.

The versioned locator records PID, endpoint/transport, start time, Broker
process identity, service version, executable installation identity/path, and
the supported protocol range. A separate owner-only `broker-versions.json`
keeps only the current and immediately previous executable metadata for
diagnosis and explicit rollback; it does not preserve an executable or any
browser, target, Workspace, Lease, ref, credential, rule, or command state. An
atomic owner-recorded startup lock surrounds discovery and daemon launch. Every
contender health-checks before and after the lock; therefore exactly one
process starts the Broker and all others reuse it.
A lock whose owner is dead can be reclaimed; a live owner is never displaced
merely because startup is slow. Before browser authorization begins, the daemon
writes an owner-only `starting` process record. If the launcher exits or times
out, later contenders wait for that same PID and reuse its endpoint after it
becomes ready; they never create a second Chrome authorization request. A dead
locator/socket is removed without signaling its recorded PID. If a ready PID is
alive but its endpoint is unresponsive, Browser Pilot returns structured
restart remediation and never silently kills or replaces the process.

## Primary Flows

### FLOW-1 Agent-managed one-shot use

An Agent installs Browser Pilot globally or in its project, runs `bp connect`
or a browser command, and the CLI starts or reuses the compatible per-user
Broker. The compatibility Workspace and Lease select controlled targets.
Existing and future eligible user tabs are available immediately. The command
returns the existing JSON shape during migration. Failures include a stable
machine code in addition to compatible human guidance. One-shot processes use
a fixed daemon-internal Connection, idempotently keyed Workspace, and renewable
Lease with a maximum five-minute TTL. Normal process exit leaves that transient
daemon-memory state available to the next command; expiry invalidates refs and
releases target control. No target, frame, session, Observation, ref, auth, or
network mapping is persisted to disk. `bp disconnect` explicitly releases the
compatibility Workspace and closes only its managed targets. It stops the
daemon only when called by the matching executable installation and no live
embedded Connection remains; otherwise it returns `protocol_incompatible` or
`broker_in_use` without replacing or terminating the Broker. JavaScript dialogs
remain pending and are handled explicitly with `bp dialogs` and `bp dialog`;
Workspace isolation prevents access to other clients' dialogs.

### FLOW-2 Product-embedded use

An Agent product bundles or resolves the official executable and starts
`browser-pilot bridge --stdio`. It initializes, negotiates protocol and
capabilities, creates or resumes a Workspace, acquires a Lease, discovers tools,
and maps those tools into its own runtime. It calls tools, consumes ordered
events, converts Artifact files into native media content, heartbeats while
active, then releases the Lease. A process crash is recovered by Lease expiry.

### FLOW-3 Browser disconnect and recovery

The Broker emits connection loss, stops dispatching target commands, and marks
commands whose effects are uncertain as `unknown_outcome`. After reconnect it
creates a new browser connection generation, invalidates old CDP sessions,
ControlledTarget mappings, frames, and Observations, and emits structured recovery
state. The daemon rediscovers only the originally selected browser profile; it
does not silently switch to another running browser. Consumers rebuild inventory
with `browser.tabs.list`. Browser Pilot never replays a mutating command
automatically.

### FLOW-4 Concurrent clients

Two unrelated Principals create separate Workspaces and Pilot targets. Their
actions may execute concurrently on different target actors. Any attempt to use
the other Principal's target, ref, rule, Artifact, or Workspace fails closed.
Releasing or crashing one client does not close or mutate the other's targets.

### FLOW-5 Existing and future user tabs

When a Host exposes Browser Pilot to an Agent, that invocation authorizes the
Agent to use the selected BrowserInstance. `tabs.list` immediately returns the
Workspace's ManagedTabSets plus all eligible user tabs, tagged by origin. Tabs
opened later appear on the next inventory refresh. The Agent may switch to and
operate any listed tab, including a form the user opened before invoking it.

Browser Pilot does not ask the Agent to request access and does not display a
grant UI. If a product needs confirmation or restricted tool exposure, the
Agent host implements that policy before launching the bridge or maps it to a
launch-time BrowserControlPolicy. Releasing a Lease or Workspace removes
transient mappings and rules but leaves user tabs open. Closing a user tab
always requires an explicit target-specific command; bulk cleanup applies only
to ManagedTabSets.

## Machine Protocol

`bridge --stdio` uses JSON-RPC 2.0 over newline-delimited UTF-8 JSON. Each line
contains one complete message. Stdout is protocol-only. Logs go to stderr and
must redact secrets. The bridge terminates on malformed framing after returning
a protocol error when possible.

Required methods:

```text
initialize
tools/list
tools/call
workspaces/create|get|release
leases/create|heartbeat|release
commands/cancel|get
events/poll
artifacts/import|get|export|retain|release
shutdown
```

Asynchronous events use best-effort `events/event` JSON-RPC notifications.
Polling with a cursor is the authoritative recovery path after reconnect,
notification loss, or backpressure. Notifications and responses may interleave.

### Initialization

The client sends its product identity, instance identity, supported protocol
range, requested capabilities, launch mode, and optional protocol 1.1 transport
limits. The response includes:

- service and executable versions;
- selected protocol version;
- supported and granted capabilities;
- Broker process identity and connection ID;
- browser discovery and authorization state;
- transport and result size limits.

Initialization must fail with a structured incompatibility error when no
protocol overlap exists. A newer executable must not silently replace an
incompatible Broker that has live clients.

Protocol 1.0 clients use the service transport ceilings. Protocol 1.1 clients
may declare maximum message and result byte sizes; the Broker selects the lower
client/service value per Connection. Initialization itself uses fixed bootstrap
ceilings, and pipelined messages after initialize are not parsed until the
selected limits take effect. Artifact and journal capacities remain service
resource limits. Pending ordinary and out-of-band control calls have separate
bounds so overload cannot create an unbounded Promise queue or prevent dialog
and cancellation control from overtaking a blocked action.

### Tool Contract

`tools/list` is the canonical machine-readable manifest. Every tool declares:

- stable name and description;
- JSON input schema;
- output schema and possible Artifact kinds;
- required capabilities;
- whether it may mutate browser state;
- cancellation and idempotency semantics;
- sensitivity classification.

The tool-level `sensitivity.input` and `sensitivity.output` arrays declare every
classification that may occur in that direction. Content-bearing input and
output schema nodes use `x-browser-pilot-sensitivity` to identify the specific
fields an adapter must taint when it maps values into model text, image, or file
content. The manifest validator rejects unknown, duplicate, or field-level
classifications missing from the tool-level declaration. Schema annotations do
not change the call or result value shape.

`tools/call` returns `{ command, result?, error? }`; each manifest output schema
describes the inner `result`. Callers may provide an opaque Command ID,
idempotency key, and relative deadline. `commands/get` and `commands/cancel`
accept a Command ID plus its Workspace ID when applicable. They authorize by
ClientPrincipal ownership so a replacement Connection can inspect known state
without inheriting the original Lease.

Action results include bounded typed evidence where Browser Pilot can observe
an effect. Ref clicks combine local control state and composed focus changes
with Broker-owned navigation, normalized document, dialog, and attributable
popup signals. `verified` means at least one supported effect was observed,
`mismatch` means an observable control did not reach its expected state, and
`unavailable` means dispatch completed without conclusive evidence. Evidence is
not a claim that the Agent's higher-level business goal succeeded.
Input evidence is discriminated as `type` or `keyboard`; press evidence uses the
focused backend node plus bounded control-state signatures and Broker-owned
signals. Upload evidence reads the selected file count and compares its browser
filename without returning the local source path.

Observation-producing tools also return `hints`. Observation-derived codes
cover explicit autocomplete surfaces, modal overlays, explicit filter controls,
and authentication surface transitions; action results may add a repeated
observable no-progress hint. Hint refs are numbered refs from that Observation
only. Page collection returns counts and refs, never page text, input values,
passwords, selectors, raw nodes, or CDP identifiers for this classification.
Blocked main-document responses and download lifecycle hints are event-derived.

`hints` is an additive schema field under protocol 1.0 and 1.1. The built-in
Browser tool implementation always returns the array, including an empty array;
the manifest leaves the field optional so compatible older executors remain
valid. Existing clients already ignore unknown response fields. No new
capability is negotiated because hints expose no operation and contain only
bounded derivatives of browser data already authorized by `observation.read`
or `event.read`.

Composite input actions pin the ControlledTarget, CDP session, selected frame,
loader, Document identity, and browser connection generation for the lifetime
of the action. After focus is established, `type` and `keyboard` also pin the
deep composed active element. Browser Pilot checks this identity before every
remaining semantic step, including select-all, deletion, each keyboard
character, and optional submit. A change before the first browser mutation is
a retryable `action_not_verified`; a change after any step was dispatched is
`unknown_outcome` with bounded `action`, `step`, `reason`, `dispatchedSteps`,
and `remainingStepsStopped` context. No remaining step is sent to the changed
page and the command is never replayed automatically.

The initial controlled tool families are browser discovery/status, Workspace
and Lease lifecycle, open/observe/read, click/type/keyboard/press,
capture/upload, tabs/frames, dialogs, auth/cookies, network, events, and
Artifacts. Raw CDP is never listed. `eval` requires `developer.eval`.

## Access and Isolation Rules

- **BR-1:** A public command can address a ControlledTarget only through its
  Workspace and a valid ControlLease.
- **BR-2:** Managed targets enter a Workspace through Broker creation and a
  verified managed-popup opener chain. Eligible user tabs enter through target
  inventory. Public commands use opaque ControlledTarget IDs; Agent-supplied
  raw CDP identifiers are never accepted as public handles.
- **BR-3:** Closing or releasing a Workspace may close its ManagedTabSets, but
  must not close user tabs merely because they were visible or controlled. It
  affects only its own mappings, rules, credentials, journals, and Artifacts.
- **BR-4:** Network and auth configuration is not global. Precedence and cleanup
  are deterministic within the owning Workspace.
- **BR-5:** Each physical browser target serializes state-changing commands.
  Reads that depend on document state join that same actor even when separate
  Workspaces address the target through different opaque ControlledTarget IDs.
- **BR-6:** A physical target has at most one controlling Lease at a time.
  Multiple Workspaces may inventory it under different opaque IDs, but a
  conflicting acquisition reports `target_busy` and never silently steals
  control. The controlling Lease may call `browser.tabs.release` with its own
  opaque target ID. The Broker retires its target session and scoped state
  before a different Lease can acquire control with that Lease's own opaque ID.
  No handoff call accepts a foreign Lease or target ID.
- **BR-7:** The Pilot window visibly identifies the controlling client without
  injecting mutable content into the page DOM.
- **BR-21:** Invoking the CLI or bridge is the browser-control authorization
  boundary. Browser Pilot does not infer task intent, ask for per-tab grants,
  or perform per-action confirmation.
- **BR-22:** The default BrowserControlPolicy permits all supported operations.
  A Host may remove operations at launch; a running Agent cannot expand that
  fixed policy through the browser tool protocol.
- **BR-23:** Every Workspace can inventory the same eligible user tab under a
  distinct opaque ID. The single controlling-Lease rule in **BR-6** resolves
  concurrent mutation.
- **BR-24:** Releasing a Lease or Workspace removes its user-target mappings and
  invalidates their Observations without closing those tabs.
- **BR-25:** Eligible popups created from user tabs appear as ordinary user tabs.
  Managed popup inheritance remains restricted to a complete verified opener
  chain rooted in the same ManagedTabSet.
- **BR-26:** `tabs.list` returns eligible current and future tabs, tagging each
  with origin and ManagedTabSet membership. Browser Pilot internal targets,
  DevTools, and unsupported browser-internal targets remain excluded.
- **BR-27:** Bulk cleanup and `close --all` default to the ManagedTabSet. No
  bulk operation closes user tabs outside it. Each user tab requires an
  explicit target-specific close command.

## Command Reliability

Mutating commands follow this runtime state model:

```text
accepted -> dispatched -> completed
                    \-> unknown_outcome
accepted -> cancelled
accepted -> expired
```

- **BR-8:** Every command has a caller-provided or Broker-generated idempotency
  key scoped to Principal and Workspace.
- **BR-9:** A duplicate completed command returns its recorded result. A
  duplicate dispatched command returns its status and is not dispatched again.
- **BR-10:** If the Broker loses certainty after dispatch, it reports
  `unknown_outcome`. Mutating commands are never automatically replayed.
- **BR-11:** Cancellation before dispatch prevents execution. Cancellation
  after dispatch is best-effort and must not claim rollback.
- **BR-12:** Browser disconnect and reconnect change the BrowserInstance
  connection generation and invalidate sessions and observations. The generation
  advances on successful restoration, not merely on a retry attempt.

Commands capture that generation when accepted. The Broker verifies it again
before browser dispatch and after the executor returns. A queued stale command
never reaches the browser. If a mutating command was already dispatched when the
generation changed, its terminal state is `unknown_outcome`; a stale read fails
with retryable `browser_disconnected` rather than returning old data.

The dispatch transition occurs immediately before the first browser mutation,
after argument, ref, target, and continuity preflight. Composite-action guards
preserve their structured interruption context when the terminal state is
`unknown_outcome`; callers must obtain fresh target/frame/Observation state
before deciding what remains to be done.

Normal bridge calls preserve dispatch order. `commands/get`, `commands/cancel`,
and dialog list/respond calls may bypass a pending `tools/call`; JSON-RPC clients
therefore correlate responses by ID rather than relying on response order. The
dialog exception prevents a paused browser command from blocking the explicit
response needed to release its JavaScript dialog.

Workspaces, Leases, target mappings, refs, command status, idempotency records,
and bounded event journals live in Broker memory by default. Broker restart
invalidates them; clients initialize again, list tabs again, and observe again.
Only installation identity, browser preference, Broker locator/version data,
and explicit user configuration may persist. DOM snapshots, refs, cookies,
passwords, network bodies, and transient control state never persist.

Broker-created targets cross one additional private ownership boundary. A
janitor child process is the sole owner of the root CDP WebSocket and proxies
all daemon CDP requests, results, and events over private IPC. The same process
creates and tracks only managed targets plus popup descendants with a verified
managed opener chain. Its parent pipe is the liveness signal: daemon EOF,
including `SIGKILL`, causes bounded descendant-first target cleanup. User
targets are never adopted merely because they share a browser window. Browser
disconnect clears that transient ownership before a new connection generation
is exposed. No janitor method or raw target ID is part of the CLI or stdio
protocol, and no ownership record is written to disk.

## Observation and Ref Semantics

Observation v1 has these required public fields: `workspaceId`, `leaseId`,
`targetId`, `url`, `observationId`, `title`, `elements`, `truncated`, and
`truncationReasons`. Each element contains only `ref`, `role`, `name`, and the
optional `value` and `checked` fields. Built-in Observation-producing tools
also return `hints`; action tools additionally return discriminated `evidence`.
The latter two fields remain optional in the schema so older compatible
executors stay valid. Raw nodes, selectors, bounds, CDP identifiers, and the
internal identity below never appear in an Observation result.

The frozen v1 limits are 50 elements by default and 10,000 at most; 4,096
string code units for title and element name; 16,384 for URL; 65,536 for one
element value; 1,000,000 across collected Observation text; AX depth 128; and
2 MiB of UTF-8 serialized Observation data. Broker storage retains at most
2,048 Observations for five minutes each. Hitting any collection limit sets
`truncated: true` and includes one or more canonical reasons in deterministic
order: `element_limit`, `text_limit`, `depth_limit`, `byte_limit`.

The public identity of an element is:

```text
workspaceId + observationId + ref
```

Internal resolution includes at least:

```text
browserProcessIdentity
browserConnectionGeneration
targetId
CDPSessionId
frameId
loaderId
backendNodeId
documentGeneration
```

The Broker stores process, connection, target, Lease, CDP session, frame,
loader, and Document generation on the Observation; each ref adds its backend
node identity. Resolution verifies all of them before live-node revalidation.
Same-context failures expose one of these stable invalidation reasons when
known: `navigation`, `loader_replaced`, `document_replaced`, `frame_changed`,
`frame_detached`, `session_replaced`, `target_detached`,
`browser_reconnected`, `target_ineligible`, `target_closed`,
`control_released`, or `expired`.
Ownership mismatches remain an undifferentiated `stale_ref` so they do not
disclose another Workspace's state.

Adding `document_replaced` as an optional `stale_ref.context.reason` value is
additive under protocol 1.0 and 1.1: clients branch on the stable error code,
handle known reasons when useful, and treat unknown reasons as a request to
rebuild current Observation state. It adds no operation or capability.

- **BR-13:** Cross-Workspace, cross-target, cross-observation, and expired refs
  return `stale_ref`; they never fall back to another target.
- **BR-14:** Navigation, loader or Document replacement, target detach, frame
  detach, CDP session replacement, and browser reconnect hard-invalidate
  affected refs.
- **BR-15:** Same-document DOM changes require live node revalidation. They do
  not force blanket invalidation when the node remains resolvable and valid.
- **BR-16:** Observations are immutable and bounded by element count, text size,
  depth, and byte limits, with explicit truncation metadata.
- **BR-28:** Agent hints are advisory, deterministic, bounded, and based only on
  browser-verifiable signals. They never contain field values, credentials,
  private file paths, raw CDP identities, or framework-specific prompt state.

## Events

The event taxonomy includes navigation, document changed, target attached,
target detached, control acquired/released, popup, dialog, download, connection
lost, connection restored, network request, network response, command status,
observation invalidated, Lease expiry, and watchdog signals for stalled
navigation, selected-frame detach, unhandled dialogs, and repeated observable
no-progress actions.

Relevant event payloads carry the same `hints` representation: main-document
403/429 responses use `access_blocked`; downloads use `download` with the public
Artifact ID only after completion; and the threshold no-progress event uses
`repeated_action`. Subresource failures do not produce a page-blocked hint.

Every event contains an event ID, monotonic Workspace sequence, timestamp,
Workspace ID, relevant Lease and target IDs, type, payload version, and
sensitivity. `workspaces/create|get` returns an explicit current `eventCursor`.
Consumers poll from their last fully processed cursor; a poll returns ordered
events, `nextCursor`, and `hasMore`. The Broker may compact old events and must
return `cursor_expired` with retained cursor bounds rather than silently skip
them. A consumer that loses its cursor rebuilds tab and Observation state, then
uses `workspaces/get` to establish a new baseline.

JavaScript dialogs enter explicit pending state and emit opened/closed events.
They remain paused until the user or an Agent issues `browser.dialogs.respond`;
Browser Pilot never auto-accepts them.

Watchdogs report browser state; they do not make task decisions. A navigation
that never becomes interactive emits `watchdog.navigation_stalled` and leaves
the dispatched command as `unknown_outcome`. Detaching the selected frame emits
`watchdog.frame_detached`, clears the frame selection, and invalidates its
Observation. A dialog still pending after the bounded threshold emits one
`watchdog.dialog_unhandled` event but remains pending. Three consecutive actions
with browser-observable mismatch or no effect emit one `watchdog.no_progress`
event per streak, scoped by Lease and target. Unobservable coordinate/canvas
actions do not increment the streak. Navigation, frame changes, verified
progress, session replacement, Lease release, and Workspace cleanup reset the
applicable transient state.

Watchdog payloads contain only bounded recovery metadata and opaque public IDs;
they never contain typed values, passwords, refs, raw CDP target/session/frame
IDs, or dialog prompt responses. Consumers inspect fresh browser state before
deciding whether to continue, retry, or ask the user.

## Artifacts

Artifact descriptors contain an opaque ID, kind, MIME type, byte size, original
filename or dimensions when applicable, sensitivity, creation time, expiry, and
optional preview relationship. They do not expose internal storage paths as the
primary identity.

- **BR-17:** Broker storage directories are mode `0700`; files are mode `0600`
  on platforms that support POSIX permissions.
- **BR-18:** Artifacts have per-item, per-Workspace, and global capacity limits,
  TTL cleanup, retain/release, and explicit export to a client-owned path.
- **BR-19:** Binary bytes are not written as base64 to the stdio stream. The
  local adapter reads an authorized Artifact or asks the CLI to export it, then
  converts it to the Agent runtime's image/file content type.
- **BR-20:** Large or full-page screenshots return a model-sized preview plus
  an optional original Artifact.

An adapter authorizes a local upload by calling `artifacts/import` with an
absolute path, Workspace, and active Lease. The Broker copies the file into
protected storage as a `user_file` / `upload_input` Artifact while preserving
its basename. `browser.upload` accepts only that Artifact kind and never treats
a screenshot, PDF, download, or arbitrary Broker-internal path as upload
authorization.

Downloads are event-produced Artifacts rather than a separate path-returning
tool. The implementation must configure download behavior on the controlled
target session only, stage bytes in a mode-`0700` per-session directory, keep
the CDP download GUID and staging path private, and ingest a completed file as a
Workspace-owned `download` Artifact before publishing the completed `download`
event. Lease/session/Workspace release removes partial staging files; failed,
cancelled, oversized, or detached downloads publish bounded metadata without a
local path. Browser-wide `Browser.setDownloadBehavior` on the user's default
context is forbidden because it would redirect downloads from unrelated user
tabs. If target-session isolation is unavailable in a Chrome version, Browser
Pilot reports download capture as unavailable and does not fall back globally.
The implementation applies per-download, per-Workspace staging, and global
staging bounds. An oversized or over-capacity download is cancelled by its
private GUID without changing download behavior for the browser's default
context. Stale staging directories from a prior Broker process are removed before
the first new download session is configured.

## Browser Discovery and Setup

Discovery returns every supported local browser candidate with product,
channel, profile, process state, remote-debugging state, authorization state,
and structured remediation. It does not silently select the first filesystem
match when several viable instances exist.

The client may select an instance explicitly or use a deterministic persisted
preference. Setup that requires Chrome UI remains a user-visible action. Browser
Pilot cannot bypass Chrome authorization and must not simulate consent.

Browser Pilot does not add an access-approval page. Products that want an
approval UX own it in the Agent host before exposing the tool. Browser Pilot
still excludes its own setup/status pages and other internal targets from
Agent inventory; the same-user CDP limitation in **CON-7** remains.

## Security and Sensitive Data

- Password inputs, cookies, auth credentials, network bodies, uploads,
  downloads, page captures, and selected page text carry sensitivity metadata.
- Tool schemas mark selected text and page/element values as `browser_data`,
  with `credential` added where a field may carry a password, cookie, header,
  request body, response body, prompt response, or arbitrary eval value.
- Artifact descriptors and BrowserEvents carry runtime sensitivity because
  their classification depends on the produced object or event. Their runtime
  value takes precedence over a tool's possible schema classifications.
- Secrets are accepted through protected stdin or structured machine input, not
  command-line arguments in recommended workflows.
- Audit records store metadata and hashes where possible, not secret values.
- Public errors do not include cookies, credentials, network bodies, DOM dumps,
  or raw CDP payloads.
- The Broker socket/pipe, configuration, and Artifact storage are restricted to
  the OS user.
- Browser Pilot documents that another same-user process may bypass it and use
  Chrome's debugging endpoint directly.

## Stable Error Model

Errors contain a stable code, human message, retryability, affected object IDs,
and optional structured remediation. Required codes include:

```text
protocol_incompatible   not_initialized       capability_denied
browser_not_found       browser_not_authorized browser_disconnected
broker_in_use
workspace_not_found     lease_expired          target_not_owned
target_busy             stale_ref               command_cancelled
action_not_verified     command_expired         unknown_outcome
artifact_not_found
artifact_expired        cursor_expired         result_too_large
invalid_argument        internal_error
```

Human CLI output may add prose. Machine clients branch only on codes and typed
fields, never on message text.

## Compatibility and Versioning

- Protocol versions are independent of executable versions.
- Compatible embedded clients reuse the running Broker even when their host or
  bundled executable versions differ. The one-shot compatibility CLI requires
  the running Broker's exact executable version because its external JSON
  contract is versioned separately from the bridge protocol.
- An incompatible executable never replaces a live Broker. A host either uses
  a compatible executable or deliberately supplies a distinct
  `BROWSER_PILOT_HOME`; Browser Pilot never creates a hidden version namespace.
- Broker shutdown is compare-and-stop: it requires the current Broker process
  identity and matching executable installation identity, and refuses while
  any embedded Connection remains live.
- Additive tool and field changes use capability negotiation and schema
  evolution. Breaking semantics require a protocol-major change.
- Unknown response fields are ignored; unknown request fields are rejected only
  when they change safety or semantics.
- Optional advisory output such as `hints` does not require a protocol-minor
  version or capability when it adds no operation and only derives bounded data
  already covered by an existing granted capability.
- The current CLI JSON shapes remain supported until a documented major CLI
  release and migration period.
- A conformance suite validates any embedded adapter against the same executable
  used by direct CLI users.

## Functional Requirements and Acceptance

- **FR-1 Universal installation:** An Agent can install Browser Pilot globally
  or locally and use existing one-shot commands.
  - **AC-1:** Existing documented CLI workflows and fixture tests pass after
    Broker migration without requiring an SDK, MCP server, or extension.
- **FR-2 Embedded integration:** A product can bundle the official executable,
  initialize `bridge --stdio`, discover tools, execute them, receive events,
  and release resources.
  - **AC-2:** A reference adapter integrates using only executable invocation,
    the published protocol, and Artifact files; it imports no Browser Pilot
    source module.
- **FR-3 Multi-client isolation:** Concurrent clients have isolated control and
  transient state.
  - **AC-3:** Two clients can operate separate Pilot windows concurrently, and
    refs, active targets, frames, auth, rules, and close operations cannot cross
    Workspace boundaries.
- **FR-4 User-browser control:** An Agent can list and control all eligible
  current and future tabs in the selected BrowserInstance, including tabs the
  user opened before invoking it.
  - **AC-4:** No access-request or grant step is required. Inventory combines
    ManagedTabSets and user tabs behind Workspace-scoped opaque IDs. A Host may
    remove operations at launch. Concurrent control reports `target_busy`,
    release leaves user tabs open, and bulk cleanup closes only managed tabs.
- **FR-5 Crash behavior:** Client and Broker failures have deterministic
  outcomes.
  - **AC-5:** Expired Leases are reclaimed; commands lost after dispatch report
    `unknown_outcome`; reconnect invalidates prior observations.
- **FR-6 Media delivery:** Agent products can deliver Browser Pilot screenshots
  to multimodal models.
  - **AC-6:** Capture returns a protected Artifact and preview metadata; a
    reference adapter converts it to native image content without base64 on
    stdout.
- **FR-7 Version safety:** User-installed and product-bundled clients coexist.
  - **AC-7:** Compatible clients reuse the Broker; incompatible clients receive
    `protocol_incompatible` or use a deliberately isolated Broker without
    terminating live clients.
- **FR-8 Browser reliability:** Browser capability improvements do not alter the
  public lifecycle and isolation contract.
  - **AC-8:** Observation and action conformance tests pass against the public
    tool interface, including frame, navigation, stale-ref, obstruction, and
    input readback cases.

## Non-Functional Requirements

- **NFR-1:** No protocol message or normal tool result exceeds negotiated size
  limits; truncation is explicit.
- **NFR-2:** Broker restart invalidates transient Workspaces, Leases, target
  assignments, refs, and commands. Clients rebuild state explicitly without
  guessing or replaying mutations.
- **NFR-3:** Every command and security-sensitive lifecycle transition emits an
  auditable event without storing secret payloads.
- **NFR-4:** Target command ordering is deterministic under concurrent clients.
- **NFR-5:** Resource cleanup is idempotent and bounded after normal release,
  client crash, browser exit, and Broker restart.

## Non-Goals

- Hosting browsers in the cloud or providing captcha-solving infrastructure.
- Controlling Firefox or WebKit in the current architecture.
- Providing OS-level isolation between processes owned by the same user.
- Defining whether an Agent's requested browser action matches user intent;
  Agent hosts own semantic approval and confirmation policy.
- Modeling an Agent's conversation, run, task, worker, or model provider.
- Replacing URL Preview features inside embedding products.
- Making Browser Pilot an MCP server or publishing language SDKs.

## Verification Strategy

1. Protocol unit tests validate framing, negotiation, errors, schemas,
   idempotency, cancellation, and cursor behavior.
2. Broker integration tests create concurrent fake clients and assert complete
   tab inventory, target assignment, Lease cleanup, crash recovery, and version
   coexistence.
3. Existing Playwright fixtures remain regression tests for human CLI behavior.
4. Capability tests cover DOM/AX fusion, frames/OOPIF, stale refs, obstruction,
   action verification, input readback, and document changes.
5. Adapter conformance tests run against a language-neutral reference adapter
   and at least two example Agent runtimes. No example-specific behavior enters
   Broker production code.
6. Browser-control tests prove that all eligible existing and future tabs are
   included without grants, launch-time denied operations fail before CDP
   dispatch, opaque IDs cannot cross Workspaces, and bulk cleanup never closes
   user tabs.
7. Distribution tests pack and install the npm package through global and local
   layouts, launch local npx and product-owned absolute paths, and exercise
   version output, bridge initialization, private Broker startup, and cleanup.
   Native verification additionally checks manifest hashes, signature state,
   private child roles, and archive checksums on each target platform.

## Implementation Boundary

The target internal boundary is:

```text
CLI formatter -----------\
stdio bridge -------------+--> BrowserPilotService --> Broker domain actors
conformance harness ------/          |                 --> CDP connector
                                      +--> Artifact/Event stores
```

`BrowserPilotService` is an internal architectural boundary, not a promised
Native SDK. CLI and bridge code may depend on it. Third-party products may not.
