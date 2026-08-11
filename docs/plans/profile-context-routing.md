# Profile Context Routing Plan

Status: **Complete**
Target: Browser Pilot `v0.4.0`, protocol `1.3`
Source of truth: `docs/architecture/browser-pilot-platform-spec.md`

## Goal

Make one Browser Pilot connection correctly inventory and control ordinary tabs
from every live Chrome Profile context, while ensuring every new managed target
is created in an explicitly resolved Profile context. The design remains
Agent-neutral, extension-free, transient, and compatible with existing
single-Profile CLI workflows.

## Real Chrome Findings

The implementation contract is based on a read-only and transient-target probe
against a user-authorized Chrome endpoint:

- one browser-level CDP endpoint exposed two ordinary Profile contexts and all
  eligible tabs from both contexts;
- ordinary Profile contexts were present on `TargetInfo.browserContextId` but
  absent from `Target.getBrowserContexts`;
- `Target.createTarget({ browserContextId })` was not reliable for ordinary
  Profile contexts and could return `Failed to find browser context`;
- dispatching `Target.createTarget` through a target session did not inherit the
  target's Profile context;
- an isolated-world `window.open` with `userGesture: true` created a target in
  the representative tab's exact Profile context;
- popup window features created a separate normal Chrome window;
- `Target.createTarget` has no `windowId` parameter. Chrome can silently ignore
  that unknown field and create a tab in an existing user window, so retained
  windows must be reused through an owned target and verified by
  `Browser.getWindowForTarget`;
- a temporary `chrome://version` target could map a runtime context to Chrome
  `Local State`, but doing that is user-visible and therefore is not permitted
  during passive Profile discovery.

No production logic may assume behavior contradicted by these findings.

## Model

### BrowserEndpoint

The existing `BrowserInstance` represents one running Chromium browser endpoint:
product/channel, user-data root, CDP endpoint, process identity, connection
generation, and connection state. A Chrome Profile directory is not a separate
BrowserInstance when it shares that endpoint.

### ProfileContext

A `ProfileContext` is one live regular browser context observed on an endpoint.
It has:

- a public `profileContextId`, opaque to clients;
- an internal raw CDP browser-context ID, never exposed;
- the owning BrowserInstance and connection generation;
- a connection-scoped neutral label;
- connection-generation-scoped identity status plus optional verified Profile
  name, account name/email, and Profile directory;
- current total and eligible tab counts;
- one or more bounded representative targets for routing and user recognition.

`profileContextId` is valid only for its browser connection generation. The
Broker retains stale public IDs long enough to return `profile_context_stale`,
but never routes them to a new raw context.

### Workspace Selection

`BrowserWorkspace.selectedProfileContextId` is transient Broker memory. It is
updated by explicit selection and by switching to a target whose context is
known. It is never written as a global default and is cleared logically by
browser reconnect because the old ID becomes stale.

### ManagedTabSet Binding

Each ManagedTabSet is permanently bound to at most one ProfileContext. A
Workspace may own multiple ManagedTabSets, one per Profile context used for
managed work. The first target binds an unbound set; opening managed work in a
different context creates another set. Workspace cleanup closes every managed
set and still leaves user tabs open.

### ControlledTarget Context

Every managed, managed-popup, and user target records a public
`profileContextId`. Popup adoption requires the popup context to equal its
managed ancestor's ManagedTabSet context.

## Protocol 1.2

Protocol 1.2 adds:

- `browser.profiles.list`;
- `browser.profiles.select`;
- optional `profileContextId` input on `browser.open`;
- `profileContextId` on every `browser.tabs.list` target;
- selected Profile context on Workspace results;
- Profile context binding on ManagedTabSet results;
- `profile_selection_required`, `profile_context_stale`, and
  `profile_context_unavailable` stable errors.

`browser.profiles.list` is a Workspace-scoped read-only tool. It returns bounded
Profile summaries and representative eligible tabs. It never opens, navigates,
attaches to, or focuses a target merely to discover a display name.

## Protocol 1.3

Protocol 1.3 adds `browser.profiles.identify` as an explicit, mutating identity
operation. For each requested unidentified Profile it creates a temporary
visible `chrome://version` target in that exact context, reads `#profile_path`,
verifies that path as an immediate child of the connected browser's
`userDataRoot`, reads bounded metadata from Chrome `Local State`, then detaches
and proves the temporary target was closed. Failure to prove cleanup returns
`unknown_outcome`; Browser Pilot never silently leaves an identity page behind.

Results use `identityStatus: unidentified | verified | unavailable` plus
optional `profileName`, `accountName`, `accountEmail`, `profileDirectory`, and a
stable `identityErrorCode`. Identity is cached only for the current browser
connection generation. `refresh: true` explicitly re-probes. No directory
ordering, tab title, or raw context ID is treated as account identity.

Protocol 1.3 also renames browser candidate `profile` to `userDataRoot` and tab
inventory `active` to `selected`. The latter is the Lease's logical target, not
Chrome foreground focus. Protocol 1.2 clients retain their legacy fields.

`browser.profiles.select` accepts only a public `profileContextId`. Human CLI
selectors such as one-based index, neutral label, or verified Profile/account
name or email are resolved
client-side from a fresh list. The machine protocol never accepts an ambiguous
free-form selector. Selecting a Profile clears the Lease's logical selected-target
anchor without releasing control or changing Chrome focus, so the next new
managed target uses that explicit Workspace selection.

## Selection Algorithm

When `browser.open` needs a new target, resolve exactly one Profile context in
this order:

1. an explicit, current-generation `profileContextId`;
2. the current Lease's selected target context;
3. the Workspace's current, valid selection;
4. the only currently available Profile context;
5. otherwise fail with `profile_selection_required` before browser dispatch.

Listing or controlling an existing target never requires prior Profile
selection. Supplying `profileContextId` while navigating an existing target is
valid only when it equals that target's context; Browser Pilot never moves a
physical target between Profiles.

`profile_selection_required` contains only bounded Profile summaries. It is a
normal structured result for an Agent host to turn into a user question. Direct
CLI JSON mode exits without reading interactive stdin.

## Managed Target Creation

Creation is serialized by Workspace/Profile context and remains owned by the
managed-target janitor:

1. If the Workspace retains a live managed window, resolve an owned page target
   whose `Browser.getWindowForTarget` result equals that window ID. Re-adopt it
   after a reconnect, open a uniquely marked sibling tab from an isolated world,
   and verify both the Profile context and exact window ID.
2. For the first target, try browser-level creation with `newWindow: true` and
   the raw browser-context ID. Verification is mandatory because Chrome support
   varies by regular Profile context.
3. If Chrome rejects or misroutes that call, attach to a bounded representative
   page target in the selected context, create an isolated world, and call
   `window.open(<unique blank marker>, <unique window name>, <fixed popup window
   features>)` with a debugger user gesture.
4. Identify exactly one new page target by the pre-dispatch target set, unique
   URL marker, and Profile context. Prove ownership through either the expected
   opener ID or exact readback of the per-command random `window.name`; Chrome
   may normalize the reported opener across regular Profile tabs. Ambiguous or
   unverified targets are closed and the operation fails.
5. Explicitly adopt the verified target into the janitor before registering it
   publicly, so Broker crash cleanup still closes it.
6. Read and retain its window ID, bind the ManagedTabSet, register the opaque
   target and owned raw target ID, then navigate through the normal target actor.

The fallback does not execute page-defined JavaScript, inject DOM content, read
page data, or navigate the representative user tab. It may cause ordinary
focus/blur effects inherent to Chrome opening a new window. Failure after any
possible target creation returns `unknown_outcome` unless the Broker proves all
candidate targets were closed.

## Compatibility

- Protocol 1.0/1.1 clients continue to list and control existing tabs.
- In a single available context, their existing `browser.open` behavior remains
  automatic.
- In multiple contexts, a selected target remains an unambiguous anchor.
- With multiple contexts and no anchor, older clients receive a structured
  failure and Browser Pilot never silently chooses the first context.
- New Profile fields on existing results are additive; raw CDP IDs remain
  private.
- The current CLI negotiates protocol 1.3, while the Broker continues to accept
  1.0 through 1.2.

## Delivery

- [x] P0: probe ordinary multi-Profile Chrome behavior.
- [x] P1: freeze model, protocol, selection, and creation rules.
- [x] P2: implement Profile context registry, target propagation, Workspace
  selection, multiple ManagedTabSets, and janitor adoption.
- [x] P3: implement `bp profiles`, `bp profile`, and `bp open --profile`.
- [x] P4: update CLI integration guidance, skill, and release docs.
- [x] P5: add protocol, dual-Profile, concurrency, reconnect, cleanup, and
  compatibility tests.
- [x] P6: run real Chrome acceptance and publish `v0.3.0-rc.2`.

## Acceptance

- [x] All eligible user tabs across live Profile contexts appear in one inventory.
- [x] Existing user tabs can be controlled without selecting a Profile first.
- [x] No multi-context open silently selects a first Profile.
- [x] Explicit, selected-target, Workspace, and single-context resolution follow the
  specified order.
- [x] Every managed target and popup matches its ManagedTabSet Profile context.
- [x] Two Workspaces may select different contexts and create targets concurrently
  without cross-routing.
- [x] Reconnect invalidates old Profile IDs, target mappings, frames, and refs.
- [x] Passive listing creates no target and never focuses or navigates a user tab.
- [x] Explicit identity verifies Profile paths, returns structured account-aware
  fields, cleans temporary targets, caches only within one connection
  generation, and never guesses unavailable metadata.
- [x] Janitor EOF/SIGKILL cleanup closes fallback-created managed windows but never
  user tabs.
- [x] Protocol 1.1 clients retain existing-tab control and cannot open ambiguously.
- [x] Single-Profile CLI and fixture behavior remains compatible.
