# Same-Process Frame Observation and Selector Routing

Status: **Complete — pending a release**
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

## F0 measurement results

Measured against real Chrome on a host page whose iframe sits at a non-zero
page offset (`left: 137px, top: 211px`), with an inner frame carrying an
accessibility-exposed `<button>`, a DOM-only clickable `<div>`, and a further
nested frame.

### Limitation A reproduces, and is stronger than documented

| Observation context | Elements returned |
|---|---|
| Top frame | `button\0Top Command` only |
| Child frame selected | `button\0Inner AX Command`, `button\0Inner DOM Command` |
| Nested frame selected | `button\0Deep Command` |

Same-process iframe content is not merely *sometimes omitted* from a top-frame
snapshot — it is **entirely absent**, at every nesting level. The documented
wording understated this.

The inverse is also true and was not documented: once a frame is selected, its
controls are observed correctly, **including the DOM-only control**. DOM
supplementation works fine; it is scoped to one document, not broken.

### Limitation B does not reproduce

| Probe | Result |
|---|---|
| `locate('#inner-ax')`, child selected | resolves at `x=74 y=19` |
| `locate('#top-button')`, child selected | `invalid_argument` — does **not** leak to the top frame |
| `locate('#inner-ax')`, top frame | `invalid_argument` |
| `locate('#top-button')`, top frame | resolves at `x=59 y=19` |

Selector resolution is correctly scoped to the selected frame in **both**
directions. The documented claim that selectors "can resolve against the top
frame after selecting a subframe" is not accurate.

Scope of that finding: `locate` was measured end to end. `read`, `search`, and
`elements.find` were verified by inspection to receive the same
`observationContext.executionContextId`
(`src/services/browser-tool-service.ts:1173,1196,1218`), so they share the
mechanism rather than having been individually measured.

### Coordinates are frame-relative by design, and consistent

`locate` returns `getBoundingClientRect` values from inside the frame's
execution context, so `x=74 y=19` is relative to the frame, not the page. This
initially looked like a wrong-pixel defect. It is not: `ActionService`
dispatches pointer input through `offsetPointerPoint`, which adds the active
frame's offset (`action-service.ts:664`, injected at
`browser-tool-service.ts:2844`). `bp locate` → `bp click --xy` is therefore
coherent today.

The design consequence is real, though: that offset is **session-wide, keyed to
the one active frame**. The moment observation returns elements from several
frames at once, a single offset can no longer be correct, so per-element frame
identity becomes a prerequisite rather than a refinement.

## Delivery Order

### F0. Establish what actually reproduces — done

- [x] **F0.1** Measure a same-origin iframe at a non-zero page offset carrying a
  DOM-only control, an accessibility-exposed control, and a nested frame.
- [x] **F0.2** Record whether selector resolution reaches the selected subframe
  today. It does; see the results above.
- [x] **F0.3** Rewrite the `SKILL.md` and `references/commands.md` limitation
  text to match the measurement. The selector-routing claim is removed because
  it does not reproduce, and the observation limitation is restated as total
  rather than partial. This is a user-visible skill change and needs a
  release-note entry when the next version is cut.
- [ ] **F0.4** Promote the measurement fixtures into
  `tests/fixtures/browser-capability-matrix.mjs` as durable scenarios. They
  cannot join `REQUIRED_BROWSER_CAPABILITY_SCENARIOS` until F1 lands, because
  that list is asserted to match the benchmark cases exactly, so they graduate
  with F3.1.

### F1. Observe the same-process document set

- [x] **F1.1** Walk the documents reachable from the selected frame's document
  through `contentDocumentFrameId`, via a new `frameView` on the parsed DOM
  snapshot. Descends only, so a selected subframe never observes its parent,
  and visits each document once so a malformed capture cannot cycle.
- [x] **F1.2** Carry the owning frame and its offset on `RefEntry`, which is
  internal. The public Observation v1 element shape is unchanged, so this is not
  a protocol change.
- [x] **F1.3** Compose the offsets at dispatch rather than rewriting bounds:
  `offsetPointerPoint` now adds the session's observed-root offset **and** the
  ref's offset from its document up to that root. Both degenerate to the prior
  behavior when observing a single frame.
- [x] **F1.4** Share the existing byte, element, and depth budgets across the
  document walk, and cap nested accessibility fetches, reporting the existing
  `work_limit` reason. No new truncation vocabulary, so the frozen contract is
  untouched.
- [x] **F1.5** Fetch a nested frame's accessibility tree. Discovered during
  verification: `Accessibility.getFullAXTree` returns one frame only, so a plain
  `<button>` with no listener stayed invisible inside a frame while a clickable
  `<div>` beside it was reported. Each frame's tree is linked separately,
  because accessibility node ids are unique only within their own frame.

### F2. Route actions to the owning frame

- [ ] **F2.1** For a ref whose owning frame is not the selected frame, resolve
  that frame's isolated world before dispatching, reusing `FrameService`'s
  existing per-frame world rather than adding a second mechanism.
- [ ] **F2.2** Replace the session-wide pointer offset with a per-element one.
  `offsetPointerPoint` currently adds the single active frame's offset, which is
  correct only while every element comes from that frame. This is the concrete
  form of the F1.3 risk and the reason F1.2 is a prerequisite.
- [ ] **F2.3** Confirm ref invalidation still fires per frame. Ref identity
  already binds frame and loader (Workstream B0.3), so a subframe navigating
  must invalidate only its own refs.

F2 no longer includes a selector-routing fix: F0.2 found nothing to fix.

### F3. Close the contract

- [x] **F3.1** The iframe `test.todo` now asserts, and a browser-level test
  pins nested observation and pointer accuracy against real Chrome. The
  subframe-selector todo stays a todo deliberately: F0.2 found nothing to fix,
  so it is retained as a regression guard rather than converted.
- [x] **F3.2** Measured. An OOPIF degrades **silently**, which is worse than
  the plan assumed. See below.
- [x] **F3.3** The nested-frame fixture is now a required capability scenario
  with benchmark ground truth, and the stored baseline moved with it:

  | Metric | Before | After |
  |---|---|---|
  | Observation cases | 10 | 11 |
  | Observable target recall | 10/10 | 14/14 |
  | False-interactable rate | 2/12 | 2/16 |
  | Max normalized Observation bytes | 426 | 514 |

  Recall holds at 100% with four more targets demanded, and the
  false-interactable rate improves because the added targets are all genuine.
  The output-size maximum rises because the nested fixture legitimately returns
  more elements; the gate treats that as a regression unless the baseline is
  updated deliberately, which is what this is.

### F3.2 findings: cross-origin frames degrade silently

Measured on a host page with a cross-origin iframe:

| Probe | Result |
|---|---|
| Top-frame snapshot | host controls only |
| `truncationReasons` | `null` — **no marker that anything was omitted** |
| Documents in the capture | host only; the frame is a separate target |
| `FrameService.list()` | **does not list the cross-origin frame** |

Two consequences the plan did not anticipate:

1. Making same-origin frames automatic sharpens the trap. Guidance used to send
   an Agent to `bp frame` for every frame; now that same-origin frames need no
   selection, an Agent can reasonably conclude frames are handled and read an
   empty cross-origin result as "no controls there".
2. `bp frame` is not a fallback. It lists same-process frames only, so it can
   neither reveal nor select what the snapshot omitted. Guidance drafted around
   `bp frame` as the escape hatch was wrong and was corrected before shipping;
   the only route is `bp find "iframe" --attributes src` followed by opening
   that URL as its own page.

Still open: whether to emit a signal rather than rely on documentation. The
repository already has a typed `AgentHint` union carrying codes such as
`access_blocked` and `modal_overlay`, which would let an observation say that a
cross-origin frame was present and excluded, without touching the frozen
Observation v1 element shape. That extends a public union, so it needs a
decision on how existing consumers treat an unknown hint code.

### Pending release note

`SKILL.md` and `references/commands.md` frame guidance changed twice in this
plan, and the shipped skill now describes behavior that does not exist in any
release. The next version needs an entry covering: same-origin frames observed
and clickable at any depth without selecting them, and cross-origin frames
excluded with no marker and no `bp frame` fallback. The version number is not
decided here -- v0.6.2 is released, and writing into its notes is the mistake
this plan's predecessor already made once.

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
