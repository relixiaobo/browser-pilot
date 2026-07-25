# Browser Capability and Reliability Evolution Plan

Status: **Approved, ready to run in parallel after shared contract A0**  
Source of truth: `docs/architecture/browser-pilot-platform-spec.md`  
Workstream: B

## Goal

Improve Browser Pilot's page understanding, frame correctness, action
reliability, event production, and Agent guidance using validated ideas from
browser-use while preserving Browser Pilot's controlled target model, network
capabilities, real-profile behavior, and CLI workflow.

Research baseline: browser-use commit
`24e96d35a5f94794130a06b0e4b1acdeefc4a23f`.

## Adopt, Adapt, and Reject

Adopt or adapt:

- DOM + AX + DOMSnapshot fusion.
- CDP-session-aware element identity.
- Visible quads and occlusion checks.
- Checkbox/radio post-click verification.
- React/Vue/contenteditable input readback.
- Remaining-action cancellation after page, frame, focus, or document change.
- Typed browser watchdog events.
- Guidance for autocomplete, modals, filters, 403 responses, and loops.

Do not copy:

- Automatic acceptance of confirm or beforeunload dialogs.
- Cloud browser, captcha, or hosted-session architecture.
- A concurrency model that treats the user's Chrome as one globally shared
  Agent browser.
- Agent-framework-specific history, memory, or model prompting internals.

Preserve Browser Pilot advantages:

- Network observe/block/mock/header operations.
- HTTP auth, cookies, PDF, and explicit Pilot windows.
- Concise URL/read/snapshot/eval guidance for direct CLI Agents.

## Delivery Order

### B0. Establish baselines and shared contracts

- [x] **B0.1** Record browser-use ideas to adopt, adapt, and reject.
  - Covers: FR-8, AC-8.
- [x] **B0.2** Build a fixture matrix for AX-only, DOM-only, shadow DOM,
  same-origin iframe, cross-origin/OOPIF, overlays, contenteditable, React
  controlled input, navigation, and document replacement.
  - Covers: AC-8.
  - Complete: a reusable local fixture catalog defines every listed scenario
    with bounded explicit signals and no third-party dependency. Isolated
    system-Chrome tests verify AX-vs-DOM semantics, open Shadow DOM, overlay hit
    testing, rich editing, asynchronous controlled-input rollback, same-origin
    frames, a forced cross-origin OOPIF target, top-level navigation, and same-URL
    Document replacement. The compatibility fixture server exposes the same
    catalog for later public-surface regression tests.
- [x] **B0.3** Freeze Observation v1 public fields, internal node identity,
  invalidation reasons, limits, and truncation metadata with Workstream A.
  - Covers: BR-13 through BR-16, NFR-1.
  - Complete: runtime constants and canonical schemas now define the public
    fields, deterministic truncation reasons, field/aggregate/depth/UTF-8 byte
    limits, TTL, and capacity. Internal resolution binds process, browser
    generation, Workspace, Lease, target, CDP session, frame, loader, Document
    backend identity, and backend node. Same-context `stale_ref` errors expose a
    stable invalidation reason while ownership mismatches remain opaque. Direct
    CLI snapshots now preserve truncation metadata as additive JSON fields.
  - A0 decision: `document_replaced` is an additive optional
    `stale_ref.context.reason` under protocol 1.0 and 1.1. Older clients already
    branch on `stale_ref` and rebuild state; no capability or version change is
    required.
- [ ] **B0.4** Add quantitative baselines: observable target recall, false
  interactable rate, action verification failures, stale-ref detection, and
  output size.
  - Covers: FR-8.

### B1. Build the observation engine

- [x] **B1.1** Collect DOMSnapshot layout and frame metadata alongside AX
  nodes, without exposing raw page dumps to the Agent.
  - Covers: BR-16, CON-5.
  - Complete: every Observation now captures DOMSnapshot documents, shared
    strings, frame/document relationships, backend-node identity, attributes,
    browser clickable state, form state, computed display/visibility/opacity/
    pointer behavior, layout bounds, and paint order in an ephemeral internal
    index. Raw DOMSnapshot data, attributes, selectors, layout, and CDP IDs are
    never returned or persisted.
- [x] **B1.2** Fuse AX semantics, DOM attributes, layout bounds, visibility,
  editability, and form state into normalized observable elements.
  - Covers: AC-8.
  - Complete: AX role/name/value remain authoritative while DOM facts fill
    missing names, values, checked state, autocomplete state, and modal
    ancestry. Visible browser-marked clickable nodes absent from the semantic
    AX surface become bounded DOM-only controls in stable document order.
    Hidden, zero-layout, disabled, readonly, inert, and duplicate candidates
    are excluded. Unit and isolated system-Chrome fixtures cover AX-only,
    DOM-only, hidden/disabled controls, Shadow DOM, contenteditable, and
    controlled-input readback without changing Observation v1 fields.
- [x] **B1.3** Preserve Shadow DOM traversal and add session-aware frame/OOPIF
  traversal with deterministic ordering.
  - Covers: AC-8.
  - Complete: frame discovery now recursively joins same-process frame trees
    with descendant OOPIF targets in stable parent-first order while excluding
    iframe targets owned by other tabs. Observations, refs, actions, reads,
    evaluation, uploads, captures, dialogs, network handling, continuity, and
    invalidation use the selected frame's actual CDP session. Same-process
    pointer coordinates are translated through the live frame-owner content
    box; OOPIF roots remain frame-local. Child sessions are detached and their
    state invalidated on navigation, detach, Lease release, reconnect, and
    target teardown.
- [x] **B1.4** Add explicit element/page/text limits and truncation reasons;
  keep output lean enough for Agent context.
  - Covers: BR-16, NFR-1.
  - Complete: Observation v1 enforces field and aggregate text limits, requested
    and absolute element limits, AX tree depth, and a 2 MiB UTF-8 serialized
    data budget. It emits canonical reasons in deterministic order, stores only
    returned refs, and preserves the metadata through both Broker results and
    additive direct-CLI JSON fields.

### B2. Replace ref storage and resolution

- [ ] **B2.1** Move refs out of `~/.browser-pilot/refs.json` into ephemeral,
  Workspace-scoped Observation records.
  - Covers: FR-3, BR-13.
  - Progress: machine tool calls now use bounded in-memory Observation records
    scoped by Workspace, Lease, target, session, loader, and browser generation.
    Direct compatibility CLI calls retain `FileRefStore` until A2.3 provides
    their compatibility Workspace.
- [ ] **B2.2** Resolve refs using browser generation, target, CDP session,
  frame, loader, backend node, and document generation.
  - Covers: BR-13 through BR-15.
  - Progress: Broker Observations now bind and validate browser process and
    connection generation, Workspace, Lease, target, CDP session, selected
    frame, loader, Document backend identity, and per-ref backend node before
    live-node resolution. The compatibility FileRefStore remains target-scoped
    until B2.1/A2.3 replace it.
- [ ] **B2.3** Hard-invalidate on navigation, loader replacement, frame/session
  detach, target detach, and reconnect, emitting typed reasons.
  - Covers: BR-14, AC-5.
  - Progress: machine Observations now invalidate on every listed lifecycle,
    including browser generation restoration; compatibility CLI refs remain.
- [x] **B2.4** Revalidate live nodes after same-document mutation and return
  `stale_ref` instead of acting on a changed semantic target.
  - Covers: BR-15, AC-8.
  - Complete: ref-based click, type, and upload now resolve the original
    backend node and revalidate its connected state plus the same AX-first,
    DOM-fallback role/name identity used by Observation. Ordinary controls use
    a targeted partial AX query; AX-name fallbacks and DOM-only controls use a
    current DOMSnapshot and retain browser clickability checks. A removed node,
    changed role/name, or lost DOM-only clickability returns the existing
    `stale_ref` without a new protocol reason, browser identity, or semantic
    text in the error. Only that ref fails: the Observation and its unchanged
    refs remain usable. Broker tools and compatibility CLI actions inject the
    same validator.

### B3. Make actions verifiable

- [x] **B3.1** Before pointer actions, verify current bounds, viewport
  intersection, hit-test target, enabled state, and obstruction.
  - Covers: AC-8.
  - Complete: ref clicks now scroll and revalidate connected layout, viewport
    intersection, native/ARIA disabled state, and multiple hit-test points
    across visible client rects. Descendant, associated-label, and shadow-host
    hits are accepted; detached refs return `stale_ref`, while non-interactable
    refs return bounded `action_not_verified` reasons before any pointer event.
    Explicit coordinate clicks remain the low-level escape hatch.
- [x] **B3.2** After click, verify expected checkbox, radio, selection, focus,
  dialog, navigation, popup, or document effects where observable.
  - Covers: AC-8.
  - Complete: click results now contain bounded typed evidence for native and
    ARIA checked, selected, pressed, expanded, and composed focus state. The
    Broker merges loader/URL changes, normalized Observation differences,
    dialog openings, and attributable popup creation without exposing raw CDP
    IDs. Expected checkbox/radio/option state failures report `mismatch`;
    coordinate and otherwise unobservable clicks report `unavailable`.
- [x] **B3.3** Unify input behavior for native fields, controlled React/Vue
  fields, and contenteditable; read back the effective value/content.
  - Covers: AC-8.
  - Complete: text controls, email/number controls, and contenteditable now use
    Chrome's native editing path with trusted, cancelable input semantics;
    date/time/color/range controls use a bounded value path without emitting an
    early `change`. Targets are classified and rejected before dispatch when
    detached, disabled, readonly, inert, or unsupported. Final readback detects
    framework acceptance, synchronous/asynchronous rollback, browser
    sanitization, and editor interception. Password evidence contains lengths
    only, deep open-Shadow-DOM focus is readable, and keyboard clear uses
    Chrome's `SelectAll` editing command.
- [x] **B3.4** Return typed action evidence and failure reasons instead of
  reporting success solely because CDP dispatch completed.
  - Covers: command reliability contract.
  - Complete: click, type, keyboard, press, and upload results use bounded
    discriminated evidence. Press combines focused-backend-node control changes
    with Broker-owned navigation, document, dialog, and popup signals. Upload
    verifies the selected file count and browser filename after dispatch.
    Unsupported effects report `unavailable`; observable wrong states report
    `mismatch`; exact machine input can raise `action_not_verified`. Legacy CLI
    output remains compatible.
- [x] **B3.5** Stop any remaining composite action steps when target, frame,
  focus, loader, or document generation changes unexpectedly.
  - Covers: BR-10 through BR-12, AC-5.
  - Complete: Broker and compatibility CLI actions create the same isolated
    CDP continuity guard. It pins target/session ownership, browser generation,
    selected frame, loader, and Document identity; type/keyboard additionally
    pin deep composed focus. Checks run between clear, delete, per-character
    keyboard input, and submit. Pre-mutation changes return retryable
    `action_not_verified`; partial mutations preserve a structured
    `unknown_outcome`, stop all remaining steps, and are never replayed.

### B4. Produce typed browser events and recovery state

- [x] **B4.1** Normalize CDP events into the BrowserEvent taxonomy for
  navigation, document, target, popup, dialog, download, connection, and
  observation invalidation.
  - Covers: event contract, NFR-3.
  - Complete: navigation, document change, target attach/detach and control,
    managed popup, dialog, Observation invalidation, Command status, and Lease
    expiry, sanitized Workspace network, scoped download, and browser connection
    recovery producers are connected.
- [x] **B4.2** Add watchdogs for browser disconnect, stalled navigation,
  detached frames, unhandled dialogs, and repeated no-progress actions.
  - Covers: FR-5, FR-8.
  - Complete: WebSocket loss emits connection state and starts selected-profile
    rediscovery with bounded backoff. Navigation timeouts return structured
    `unknown_outcome`; selected-frame detach clears frame state; pending dialogs
    emit a bounded reminder without auto-response; and browser-observable action
    evidence drives a Lease/target-scoped no-progress streak. Timers and streaks
    are transient, cleaned up with their owning resources, and never expose raw
    CDP IDs, refs, typed text, or credentials.
- [x] **B4.3** Replace dialog auto-accept with explicit pending state and
  accept/dismiss commands.
  - Covers: DEC-5.
  - Complete: daemon auto-accept is removed; pending Broker dialogs are
    Lease/target scoped and use explicit list/respond tools without target-actor
    deadlock. One-shot CLI calls use an isolated explicit list/respond path.
- [x] **B4.4** Ensure event producers are deterministic under target actor
  serialization and reconnect generations.
  - Covers: NFR-4.
  - Complete: Browser events and Command records carry their source connection
    generation. The Broker fences queued commands before dispatch and completed
    results after execution, retains old-generation Command terminal and
    reconnect cleanup events, and drops delayed ordinary CDP events from retired
    generations. Target inventory refreshes serialize per Workspace and verify
    their generation before applying an awaited snapshot. Tests cover same-target
    ordering, cross-target interleaving, reconnect races, and stale inventory.

### B5. Improve Agent-facing guidance and data handling

- [x] **B5.1** Add structured hints for autocomplete, modal overlays, filters,
  blocked/403 pages, login transitions, downloads, and repeated action loops.
  - Covers: FR-8.
  - Complete: Observation results now contain a bounded discriminated `hints`
    array derived from DOM/AX signals without collecting page text or input
    values. Authentication transitions are scoped to the live target session
    and selected frame. Main-document 403/429, target-session download states,
    and the no-progress threshold publish the same Agent-neutral hint contract
    in events; subresource failures are excluded. Refs, reason text, counts,
    and arrays are bounded, and focused tests cover all hint variants.
  - A0 decision: this is an optional additive output field under protocol 1.0
    and 1.1, with no new capability. It exposes no operation and derives only
    data already covered by `observation.read` or `event.read`; older clients
    ignore unknown response fields and older executors may omit it.
- [x] **B5.2** Mark passwords, cookies, auth, network bodies, uploads,
  downloads, screenshots, and selected page text with sensitivity metadata.
  - Covers: CON-5.
  - Complete: the canonical tool schemas now carry validated
    `x-browser-pilot-sensitivity` annotations on selected page text,
    Observation element values, auth fields, cookie values, network
    headers/bodies, upload Artifact references, prompt text, and eval content.
    Tool-level possible classifications must cover every field annotation.
    Password-capable Observation results declare `credential`; existing
    password action evidence remains value-free and reports only `sensitive`
    plus bounded lengths. Artifacts and events retain their runtime sensitivity.
  - A0 decision: field annotations are additive schema metadata under protocol
    1.0 and 1.1 and do not change argument or result value shapes. No new
    capability is required; older clients ignore the annotation, while updated
    adapters propagate it when constructing model content.
- [x] **B5.3** Return model-sized screenshot previews and original Artifacts
  through Workstream A's Artifact service.
  - Covers: BR-20, AC-6.
  - Complete: large machine captures return a Chrome-scaled preview by default
    and an optional original with an explicit `previewOf` relationship.
- [x] **B5.4** Update the universal skill with decision guidance grounded in
  actual tool errors and state, not framework-specific prompts.
  - Covers: FR-1, FR-8.
  - Complete: the Agent-neutral skill now separates direct one-shot CLI use
    from embedded stdio integration, starts from current tab/page state, uses
    fresh refs, verifies action results, and gives explicit recovery decisions
    for structured evidence, hints, stable errors, events, reconnects, dialogs,
    and Artifacts. Command guidance now reflects all-tab inventory, explicit
    dialog handling, managed-only bulk cleanup, and actual local capture output.
    It names no Agent framework in its runtime decisions and adds no adapter or
    prompt-specific production behavior.

### B6. Reliability and regression gates

- [ ] **B6.1** Add deterministic fixture tests for every B0.2 scenario and
  every invalidation transition.
  - Covers: AC-3, AC-5, AC-8.
- [ ] **B6.2** Add action verification tests for obstruction, checkbox/radio,
  controlled inputs, contenteditable, focus loss, popup, and navigation.
  - Covers: AC-8.
  - Progress: isolated system-Chrome tests cover trusted controlled-input
    events and rollback, canceled `beforeinput`, native email/number selection,
    nested contenteditable replacement/append, blocked fields, special value
    controls, Shadow DOM readback, keyboard clear, press effects, upload
    readback, public loader replacement, and real-Chrome composite focus loss.
- [ ] **B6.3** Add real-site canaries that report drift without making release
  tests depend on third-party availability.
  - Covers: FR-8.
- [ ] **B6.4** Compare metrics against B0.4 and reject changes that increase
  unsafe false-positive interactions or unbounded output.
  - Covers: NFR-1, AC-8.

## Parallel Work Rules

- B1 can proceed while A1 extracts service modules, provided it targets the
  agreed Observation interface rather than Commander handlers.
- B2 must use A2 Workspace target control and may not introduce another
  persistent ref store.
- B3 depends on the per-target ordering boundary from A2.4 but its pure action
  verification logic and fixtures can be developed earlier.
- B4 event producers can run in parallel with A4 transport delivery.
- B5 Artifact work integrates only after A5 defines storage and authorization.
- Any proposed public field or error change returns to A0 contract review and
  receives a version/capability decision before implementation.

## Release Gate

Workstream B is complete only when AC-8 passes through the public tool surface,
all existing CLI/network tests remain green, stale refs fail closed across
targets and frames, action success includes evidence, output is bounded, and no
adopted browser-use behavior weakens Browser Pilot's ManagedTabSet,
Workspace/Lease isolation, target-control, Host policy, or dialog rules.
