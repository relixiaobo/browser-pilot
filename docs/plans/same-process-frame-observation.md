# Same-Process Frame Observation and Selector Routing

Status: **Design — not started**
Baseline: `v0.6.2` @ `a4032bf`
Source of truth: `docs/architecture/browser-pilot-platform-spec.md`

## Goal

Make controls inside same-process iframes observable and actionable, and make
selector-based commands resolve inside the frame the Agent selected. These are
the two limitations `SKILL.md` currently instructs Agents to work around, and
the only known product gaps carried forward from the v0.6.0 plan and the
superseded v0.6.1 backlog.

Out of scope: cross-origin out-of-process frames (OOPIF). They are separate CDP
targets and never appear in this target's capture. `SKILL.md` already directs
Agents to navigate to the frame URL directly, and that guidance stays.

## Current behavior

### A. DOM supplementation consumes one document — confirmed

`DOMSnapshot.captureSnapshot` returns every same-process document in a single
response, and `parseDomSnapshot` already parses all of them and links each
iframe node to its child document through `contentDocumentFrameId`
(`src/dom-snapshot.ts:287`).

The data is therefore already captured and already linked. The loss happens at
exactly one line, where observation narrows the set to a single document:

```ts
// src/snapshot.ts:213
const domDocument = parseDomSnapshot(rawDomSnapshot).document(context.frameId);
```

`document(frameId)` falls back to `documents[0]` when no frame is selected, so
DOM-only controls — clickable elements the accessibility tree does not surface
on its own — inside a same-process iframe are never walked.

This is pinned by `test.todo('same-process iframe DOM-only controls appear in
top-frame snapshots')` in `tests/observation-contract.test.mjs:167`.

### B. Selector routing to a selected subframe — needs reproduction first

`SKILL.md` and `references/commands.md` state that after `bp frame <index>`,
selector-based commands may resolve against the top frame. **The plumbing that
would prevent this already exists:**

- `FrameService.selectById` calls `Page.createIsolatedWorld` for the selected
  frame and returns its `executionContextId` (`src/services/frame-service.ts:205`).
- `BrowserToolService` forwards that context into observation and actions
  (`src/services/browser-tool-service.ts:981`).
- `ActionService` sets `params.contextId` on `Runtime.evaluate`
  (`src/services/action-service.ts:906`), and selectors resolve through injected
  `document.querySelector` (`src/page-scripts.ts:513`), which binds to the
  isolated world's document.

So the documented limitation may be stale, or may survive only on call sites
that bypass `ActionService`. **The first deliverable is a reproduction, not a
fix.** Writing the fix against a limitation that no longer reproduces would add
untested code and leave the real gap — wherever it is — in place.

## Delivery Order

### F0. Establish what actually reproduces

- [ ] **F0.1** Extend the fixture catalog with a same-origin iframe whose
  interactive control is DOM-only, one whose control is exposed through the
  accessibility tree, and one nested two frames deep.
- [ ] **F0.2** For each public command that accepts a selector, record whether
  it resolves inside a selected subframe today. Produce a table of command →
  reproduces / does not reproduce.
- [ ] **F0.3** Rewrite the `SKILL.md` and `references/commands.md` limitation
  text to match F0.2. If a documented limitation does not reproduce, removing
  the workaround guidance is itself a shipped correction.

Gate: F1 and F2 are scoped by F0.2. Do not implement against the current
documentation wording.

### F1. Observe the same-process document set

- [ ] **F1.1** Walk the documents reachable from the selected frame's document
  through `contentDocumentFrameId`, instead of a single document. The reachable
  set, not every captured document — a selected subframe must not observe its
  parent.
- [ ] **F1.2** Carry the owning `frameId` on every emitted element so an action
  can be routed to the frame that owns the node.
- [ ] **F1.3** Transform child-document layout bounds into page coordinates by
  offsetting through the owning iframe element's bounds. Required for
  `bp click --xy`, occlusion checks, and annotated screenshots; a child document's
  bounds are otherwise relative to its own viewport and would silently point at
  the wrong pixels.
- [ ] **F1.4** Keep the document-set walk inside the existing work budget and
  emit the established truncation reasons. A frame-heavy page must degrade the
  way a large page already does, not by exceeding limits.

### F2. Route actions to the owning frame

- [ ] **F2.1** For a ref whose owning frame is not the selected frame, resolve
  that frame's isolated world before dispatching, reusing `FrameService`'s
  existing per-frame world rather than adding a second mechanism.
- [ ] **F2.2** Confirm ref invalidation still fires per frame. Ref identity
  already binds frame and loader (Workstream B0.3), so a subframe navigating
  must invalidate only its own refs.
- [ ] **F2.3** Fix whatever F0.2 shows is genuinely routing to the top frame.

### F3. Close the contract

- [ ] **F3.1** Convert `test.todo` at `tests/observation-contract.test.mjs:167`
  and the subframe-selector todo into asserting tests.
- [ ] **F3.2** Verify an OOPIF still degrades as documented rather than
  silently producing a partial snapshot.
- [ ] **F3.3** Record the observation-recall change against the quantitative
  baselines from B0.4.

## Risks

- **Wrong-pixel actions.** F1.3 is the highest-risk item: an untransformed
  child bound produces a click at plausible but wrong page coordinates, which
  looks like a successful dispatch. Any element whose bounds cross a frame
  boundary needs a test with a non-zero iframe offset, not a fixture where the
  iframe happens to sit at the origin.
- **Budget inflation.** Frame-heavy pages multiply node counts. F1.4 must be
  designed with F1.1, not retrofitted.
- **Scope creep into OOPIF.** Same-process support may read like partial OOPIF
  support. The public limitation text must keep them distinct.

## Acceptance

- Both pinned `test.todo` tests assert.
- A DOM-only control inside a same-origin iframe appears in `bp snapshot` and is
  clickable through its ref, with a verified post-action state change.
- A control inside an iframe at a non-zero page offset is clicked at the correct
  page coordinates.
- Selector commands resolve inside the selected subframe for every command F0.2
  found to be affected.
- OOPIF behavior and its documented guidance are unchanged.
- Skill limitation text matches measured behavior.
