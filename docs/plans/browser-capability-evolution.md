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
- [ ] **B0.2** Build a fixture matrix for AX-only, DOM-only, shadow DOM,
  same-origin iframe, cross-origin/OOPIF, overlays, contenteditable, React
  controlled input, navigation, and document replacement.
  - Covers: AC-8.
- [ ] **B0.3** Freeze Observation v1 public fields, internal node identity,
  invalidation reasons, limits, and truncation metadata with Workstream A.
  - Covers: BR-13 through BR-16, NFR-1.
- [ ] **B0.4** Add quantitative baselines: observable target recall, false
  interactable rate, action verification failures, stale-ref detection, and
  output size.
  - Covers: FR-8.

### B1. Build the observation engine

- [ ] **B1.1** Collect DOMSnapshot layout and frame metadata alongside AX
  nodes, without exposing raw page dumps to the Agent.
  - Covers: BR-16, CON-5.
- [ ] **B1.2** Fuse AX semantics, DOM attributes, layout bounds, visibility,
  editability, and form state into normalized observable elements.
  - Covers: AC-8.
- [ ] **B1.3** Preserve Shadow DOM traversal and add session-aware frame/OOPIF
  traversal with deterministic ordering.
  - Covers: AC-8.
- [ ] **B1.4** Add explicit element/page/text limits and truncation reasons;
  keep output lean enough for Agent context.
  - Covers: BR-16, NFR-1.

### B2. Replace ref storage and resolution

- [ ] **B2.1** Move refs out of `~/.browser-pilot/refs.json` into ephemeral,
  Workspace-scoped Observation records.
  - Covers: FR-3, BR-13.
  - Progress: snapshot resolution now depends on an injectable `RefStore`;
    direct CLI use retains `FileRefStore`, while isolated service tests use
    `MemoryRefStore`. Workspace and Observation scoping remains to be added.
- [ ] **B2.2** Resolve refs using browser generation, target, CDP session,
  frame, loader, backend node, and document generation.
  - Covers: BR-13 through BR-15.
- [ ] **B2.3** Hard-invalidate on navigation, loader replacement, frame/session
  detach, target detach, and reconnect, emitting typed reasons.
  - Covers: BR-14, AC-5.
- [ ] **B2.4** Revalidate live nodes after same-document mutation and return
  `stale_ref` instead of acting on a changed semantic target.
  - Covers: BR-15, AC-8.

### B3. Make actions verifiable

- [ ] **B3.1** Before pointer actions, verify current bounds, viewport
  intersection, hit-test target, enabled state, and obstruction.
  - Covers: AC-8.
- [ ] **B3.2** After click, verify expected checkbox, radio, selection, focus,
  dialog, navigation, popup, or document effects where observable.
  - Covers: AC-8.
- [ ] **B3.3** Unify input behavior for native fields, controlled React/Vue
  fields, and contenteditable; read back the effective value/content.
  - Covers: AC-8.
  - Progress: native input and contenteditable actions now read state before
    and after input. Evidence contains only kind, sensitivity, status, and
    lengths; password values are never returned. Framework fixtures remain.
- [ ] **B3.4** Return typed action evidence and failure reasons instead of
  reporting success solely because CDP dispatch completed.
  - Covers: command reliability contract.
  - Progress: input actions return `verified`, `mismatch`, or `unavailable`
    evidence. Machine callers can require exact verification and receive
    `action_not_verified`; the legacy CLI output remains compatible.
- [ ] **B3.5** Stop any remaining composite action steps when target, frame,
  focus, loader, or document generation changes unexpectedly.
  - Covers: BR-10 through BR-12, AC-5.

### B4. Produce typed browser events and recovery state

- [ ] **B4.1** Normalize CDP events into the BrowserEvent taxonomy for
  navigation, document, target, popup, dialog, download, connection, and
  observation invalidation.
  - Covers: event contract, NFR-3.
- [ ] **B4.2** Add watchdogs for browser disconnect, stalled navigation,
  detached frames, unhandled dialogs, and repeated no-progress actions.
  - Covers: FR-5, FR-8.
- [ ] **B4.3** Replace dialog auto-accept with explicit pending state and
  accept/dismiss commands.
  - Covers: DEC-5.
- [ ] **B4.4** Ensure event producers are deterministic under target actor
  serialization and reconnect generations.
  - Covers: NFR-4.

### B5. Improve Agent-facing guidance and data handling

- [ ] **B5.1** Add structured hints for autocomplete, modal overlays, filters,
  blocked/403 pages, login transitions, downloads, and repeated action loops.
  - Covers: FR-8.
- [ ] **B5.2** Mark passwords, cookies, auth, network bodies, uploads,
  downloads, screenshots, and selected page text with sensitivity metadata.
  - Covers: CON-5.
- [ ] **B5.3** Return model-sized screenshot previews and original Artifacts
  through Workstream A's Artifact service.
  - Covers: BR-20, AC-6.
- [ ] **B5.4** Update the universal skill with decision guidance grounded in
  actual tool errors and state, not framework-specific prompts.
  - Covers: FR-1, FR-8.

### B6. Reliability and regression gates

- [ ] **B6.1** Add deterministic fixture tests for every B0.2 scenario and
  every invalidation transition.
  - Covers: AC-3, AC-5, AC-8.
- [ ] **B6.2** Add action verification tests for obstruction, checkbox/radio,
  controlled inputs, contenteditable, focus loss, popup, and navigation.
  - Covers: AC-8.
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
