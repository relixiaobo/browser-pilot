# Universal Agent Integration Plan

Status: **Approved, in progress**  
Source of truth: `docs/architecture/browser-pilot-platform-spec.md`  
Workstream: A

## Goal

Deliver the executable, Broker, machine protocol, distribution contract, and
conformance assets required for any local Agent to install or embed Browser
Pilot. Tenon and OpenClaw are reference consumers only.

## Scope Guardrails

- Preserve existing one-shot CLI workflows under **FR-1**.
- Expose only the executable protocol under **DEC-3**; do not publish a Native
  SDK or MCP server.
- Do not place Agent-specific lifecycle nouns or payloads in production code.
- Do not improve page understanding in this workstream except where needed to
  preserve the shared Observation contract.
- Coordinate all changes to Observation/ref identity with Workstream B.
- Keep Broker-created ManagedTabSets as the default independent task surface,
  while including every eligible user tab in the same inventory. Never add an
  Agent-callable raw-CDP `adopt(targetId)` shortcut.

## Delivery Order

### A0. Freeze the shared contract

- [x] **A0.1** Publish the platform specification with stable decisions,
  requirements, rules, and acceptance criteria.
  - Covers: DEC-1 through DEC-7, FR-1 through FR-8.
  - Verification: product-spec inspection and contradiction review.
- [x] **A0.2** Encode protocol versions, capabilities, domain identifiers,
  result envelopes, stable errors, and Artifact/Event descriptors as internal
  TypeScript types and runtime validators.
  - Covers: FR-2, FR-5, FR-6, FR-7.
  - Acceptance: incompatible versions and malformed messages fail with stable
    codes; unknown fields follow the compatibility rules.
- [x] **A0.3** Publish the canonical machine-readable tool manifest and schema
  snapshots used by bridge and conformance tests.
  - Covers: FR-2, NFR-1.
  - Acceptance: `tools/list` output is generated from the same definitions used
    to validate `tools/call`.

### A1. Extract the internal service boundary

- [ ] **A1.1** Move browser discovery, target operations, observations,
  actions, capture, network, auth, and cookies out of Commander handlers into
  `BrowserPilotService` modules.
  - Covers: FR-1, FR-2.
  - Acceptance: CLI handlers contain parsing and formatting only; existing CLI
    fixture behavior remains unchanged.
  - Progress: screenshot and PDF operations now use `CaptureService`, which
    returns media bytes and metadata without formatting output or writing files.
  - Progress: snapshot, locate, click, press, and low-level keyboard dispatch
    now use `ObservationService`, `ActionService`, and `InputDispatcher`.
  - Progress: type, keyboard, upload, read, and eval now use `ActionService`,
    `UploadService`, and `PageContentService`; their handlers retain only CLI
    parsing and presentation behavior.
  - Progress: tabs, frames, cookies, auth, and network operations now use
    `TargetService`, `FrameService`, `CookieService`, `AuthService`, and
    `NetworkService`. Browser discovery and open/session lifecycle remain.
- [ ] **A1.2** Replace process exits and console/file side effects below the CLI
  adapter with typed results, stable errors, and Artifact operations.
  - Covers: FR-2, FR-6, NFR-1.
- [ ] **A1.3** Make arbitrary CDP forwarding private and gate page evaluation
  behind `developer.eval` for machine clients.
  - Covers: DEC-5, CON-4, AC-4.

### A2. Build Broker domain isolation

- [x] **A2.1** Implement ClientPrincipal, ClientConnection,
  BrowserWorkspace, ManagedTabSet, ControlLease, BrowserInstance,
  and ControlledTarget registries.
  - Covers: FR-3, FR-4, FR-5.
  - Complete: the daemon owns bounded in-memory Principal, Connection,
    Workspace, default ManagedTabSet, and Lease registries. Principal identity
    survives a bridge reconnect within one daemon lifetime; Connection-owned
    Leases do not.
- [x] **A2.2** Create managed targets only through the control registry and
  validate the complete popup opener chain before adoption.
  - Covers: BR-1, BR-2, AC-4.
  - Progress: legacy CLI popup adoption now requires a complete opener chain
    ending at an already controlled Pilot target. Workspace control registry and
    Broker-only target creation remain.
  - Progress: the Broker inventory foundation now adopts managed popups only
    through a complete live opener chain and refuses to cross a user-tab record.
  - Complete: machine-created targets enter through `BrowserToolService` and
    `MemoryControlledTargetRegistry`; no public machine call accepts a raw CDP
    target ID.
- [ ] **A2.3** Replace global target/frame/session state with Workspace and
  Lease state; provide a compatibility Workspace for one-shot CLI calls.
  - Covers: FR-1, FR-3, AC-1, AC-3.
  - Progress: Broker targets, CDP sessions, active frames, and opaque frame IDs
    are Lease/session scoped. The one-shot compatibility path deliberately keeps
    its existing file-backed state until the compatibility Workspace is added.
- [ ] **A2.4** Serialize commands through a per-target actor and implement
  explicit control transfer.
  - Covers: BR-5, BR-6, NFR-4.
  - Progress: reads and mutations now share the same per-target actor, while
    different targets can proceed concurrently. Lease release provides safe
    reacquisition; an explicit transfer operation remains.
- [x] **A2.5** Scope auth, network rules, request journals, downloads, and
  cleanup to their owner.
  - Covers: BR-3, BR-4, AC-3.
  - Complete: Broker auth, interception rules, and bounded request journals are
    Workspace scoped; request identity includes CDP session identity, sensitive
    events are metadata-only, and legacy daemon handlers ignore Broker sessions.
    Lease replacement preserves Workspace configuration while Workspace release
    clears it. Downloads use target-session CDP configuration, separate protected
    staging directories, bounded concurrency/bytes, Workspace-owned Artifacts,
    and Lease/session/Workspace cleanup without browser-wide fallback.
- [x] **A2.6** Implement the default-unrestricted BrowserControlPolicy and
  optional launch-time Host operation removal.
  - Covers: FLOW-5, BR-21, BR-22, AC-4.
  - Acceptance: no request/grant/approval lifecycle exists; every supported
    operation is available by default; explicitly denied operations fail with
    `capability_denied` before CDP dispatch.
  - Complete: `createBrowserControlPolicy` exposes all eligible user tabs and
    validates optional `deniedOperations` without any Agent-specific policy.
- [x] **A2.7** Build eligible user-tab discovery and internal-target exclusion.
  - Covers: CON-2, FLOW-5, BR-2, BR-25, BR-26, FR-4.
  - Acceptance: current and future ordinary tabs are returned, while managed
    targets, Browser Pilot internal targets, DevTools, unsupported internal
    pages, and non-page targets are excluded.
  - Complete: `CdpBrowserTargetCatalog` implements the CDP catalog boundary.
- [x] **A2.8** Merge ManagedTabSets and all eligible user tabs in
  ControlledTarget resolution, listing, switching, and popup inheritance.
  - Covers: BR-1, BR-2, BR-23 through BR-27.
  - Acceptance: `tabs.list` returns managed and user tabs with
    origin metadata; conflicting control reports `target_busy`; bulk cleanup
    closes only managed tabs; closing a user tab is explicit.
  - Complete: `MemoryControlledTargetRegistry`, `TargetInventoryService`, and
    `CdpBrowserTargetCatalog` now provide opaque per-Workspace target IDs,
    immediate managed/user inventory merging, dynamic new-tab discovery,
    physical-target Lease exclusion across Principals, ineligible-target
    invalidation, managed-popup inheritance, and safe managed-only bulk close.
    `tools/call` now lists, switches to, and explicitly closes both origins;
    Workspace release closes only managed targets. The compatibility CLI
    retains the same all-tab behavior.

### A3. Add bounded runtime lifecycle and command semantics

- [x] **A3.1** Add in-memory Workspace, Lease, target assignment, command,
  idempotency, and bounded journal stores.
  - Covers: FR-5, NFR-2, NFR-5.
  - Complete: Workspace, Lease, target assignment, Command, idempotency, and
    per-Workspace event stores are bounded and live in daemon memory.
- [ ] **A3.2** Implement heartbeat, expiry, release, crash recovery, and
  idempotent cleanup for Workspaces and Leases.
  - Covers: AC-5, NFR-5.
  - Broker restart invalidates transient state; clients initialize, list, and
    observe again. Do not recover stale browser state from disk.
  - Progress: Lease heartbeat/expiry/release, EOF cleanup, idle Connection and
    Workspace reclamation, and idempotent Workspace release are implemented.
    Target, auth, network, frame, Observation, Artifact, and partial download
    cleanup is connected. Browser connection loss now rejects tools, invalidates
    sessions/refs, rediscovers the selected profile, and advances generation on
    restoration. Broker-process crash cleanup of browser-owned targets remains.
- [x] **A3.3** Implement command accepted/dispatched/completed,
  `unknown_outcome`, deadline, cancellation, and duplicate-call behavior.
  - Covers: BR-8 through BR-12, AC-5.
  - Complete: caller or Broker IDs, Workspace-scoped idempotency, bounded
    terminal outcomes, pre-dispatch cancellation, best-effort post-dispatch
    cancellation, deadlines, cached results, and no-replay unknown outcomes are
    enforced through the public bridge.
- [x] **A3.4** Replace dialog auto-acceptance with typed events and explicit
  accept/dismiss commands.
  - Covers: DEC-5, event contract.
  - Complete: dialogs stay pending, emit opened/closed events, and can be listed
    and explicitly accepted or dismissed through out-of-band dialog tools.
    One-shot CLI dialogs use the same explicit policy while remaining unable to
    list or respond to Broker-owned sessions.

### A4. Deliver the stdio bridge

- [x] **A4.1** Implement strict NDJSON framing, JSON-RPC parsing, stdout/stderr
  separation, initialization, and graceful shutdown.
  - Covers: FR-2, NFR-1.
  - Complete: fatal UTF-8 decoding, bounded line assembly, strict JSON-RPC
  envelopes, ordered normal dispatch, command-control bypass, notification
  semantics, stdout-only protocol, EOF cleanup, bridge-only shutdown, and
  structured framing errors are covered by black-box stream tests.
- [x] **A4.2** Implement tool discovery/call, Workspace/Lease lifecycle,
  cancellation, and structured errors.
  - Covers: AC-2, FR-7.
  - Includes direct all-tab inventory and optional Host-configured operation
    removal. There are no browser-access approval methods.
  - Complete: canonical `tools/list`, validated `tools/call`, Workspace/Lease
    lifecycle, all-tab inventory, and production implementation filtering are
    implemented. `commands/get/cancel` can overtake a pending call on the same
    stdio connection and return structured outcomes.
- [x] **A4.3** Implement event notifications plus cursor polling and
  `cursor_expired` recovery.
  - Covers: events contract, NFR-3.
  - Complete: bounded Workspace journals, explicit initial cursors, ordered
    replay, `cursor_expired` bounds, Principal isolation, best-effort stdio
    notifications, and daemon notification long-polling are implemented.
- [x] **A4.4** Add protocol backpressure, negotiated message limits, and
  malformed-client isolation.
  - Covers: NFR-1, NFR-5.
  - Complete: protocol 1.1 negotiates per-Connection message/result ceilings;
    bootstrap and pipelined framing apply them deterministically. Input/output
    backpressure, bounded ordinary/control call queues, oversized-result
    replacement, notification dropping with cursor recovery, and bridge-local
    malformed-client termination prevent one client from exhausting or
    terminating another.

### A5. Deliver secure Artifacts

- [x] **A5.1** Add protected Artifact storage, metadata, quotas, TTL, preview
  relationships, retain/release, and cleanup.
  - Covers: BR-17 through BR-20, FR-6.
- [x] **A5.2** Return screenshot, PDF, and download results as Artifacts while
  keeping explicit CLI export behavior compatible.
  - Covers: AC-1, AC-6.
  - Complete: screenshot and PDF tools return scoped Artifacts; large captures
    produce model-sized previews with optional originals. Session-scoped download
    events ingest completed files as protected `download` Artifacts without
    publishing staging paths or CDP GUIDs.
- [x] **A5.3** Add adapter-facing file authorization and revoke access on
  release or expiry.
  - Covers: CON-5, NFR-5.
  - Complete: import/get/export/retain/release require an owning active Workspace
    and Lease. `artifacts/import` copies an absolute client-authorized path to a
    `user_file` / `upload_input` Artifact, and `browser.upload` accepts only that
    kind. Release, expiry, Workspace cleanup, and Broker shutdown delete Broker
    bytes without deleting the source file.

### A6. Browser discovery and multi-version operation

- [ ] **A6.1** Return structured browser candidates and setup remediation;
  persist only explicit or deterministic selection.
  - Covers: browser discovery contract.
- [ ] **A6.2** Define the per-user Broker locator, socket/pipe permissions,
  startup locking, stale process recovery, and platform-specific paths.
  - Covers: FR-7, CON-5.
- [ ] **A6.3** Implement executable/protocol negotiation, live-client upgrade
  protection, rollback metadata, and deliberate version isolation.
  - Covers: AC-7, NFR-2.
- [ ] **A6.4** Preserve global npm, local npm/npx, and product-bundled launch
  modes. Add signed/self-contained artifacts where each platform permits.
  - Covers: FR-1, FR-2.

### A7. Agent-neutral integration kit

- [ ] **A7.1** Publish the process adapter contract: launch, initialize,
  manifest registration, tool calls, event handling, Artifact conversion, and
  cleanup.
  - Covers: AC-2, AC-6.
- [ ] **A7.2** Build a language-neutral conformance runner that treats the
  executable as a black box.
  - Covers: FR-2 through FR-7.
- [ ] **A7.3** Add Tenon and OpenClaw adapters as separate examples or consumer
  changes. Keep their lifecycle mapping out of Browser Pilot production code.
  - Covers: DEC-1, CON-3.
- [ ] **A7.4** Update the Agent skill to teach direct one-shot use and embedded
  stdio use without assuming a particular Agent runtime.
  - Covers: FR-1, AC-1.

## Cross-Workstream Dependencies

- A0.2 and B0.1 jointly own the Observation/ref public contract.
- A1 exposes internal service interfaces; B1-B4 implement improved behavior
  behind those interfaces.
- A2 target actors provide B3 action ordering and document-change cancellation.
- A4 events depend on B4 event producers but can be tested initially with
  synthetic Broker events.
- A5 Artifact delivery is required before B5 screenshot guidance is complete.

## Release Gate

Workstream A is complete only when AC-1 through AC-7 pass, existing CLI tests
remain green, two concurrent reference clients are isolated, all eligible user
tabs are combined with the Agent's managed tabs without a grant step, bulk
cleanup leaves user tabs open, Host-disabled operations fail before dispatch,
and a client can send a screenshot Artifact to its runtime's native image
content without an SDK or MCP dependency.
