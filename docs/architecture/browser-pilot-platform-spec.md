# Browser Pilot Platform Specification

Status: active architecture for the next release line.

## 1. Product Definition

Browser Pilot gives a local AI Agent controlled access to the user's eligible
Chromium tabs through a command-line interface. It reuses the user's live
profiles, logins, cookies, and extensions without a browser extension.

The product is not an Agent runtime. It does not decide user intent, add
per-action approvals, own the model conversation, or expose a second native
tool protocol.

## 2. Architectural Decision

There is one public Agent integration path:

```text
Agent
  -> Browser Pilot skill
  -> host's existing shell/command runner
  -> short-lived bp CLI process
  -> shared per-user Browser Pilot Broker
  -> supervised CDP connection
  -> Chrome
```

Browser Pilot does not publish or support:

- a browser extension;
- an MCP server;
- a language-specific Native SDK;
- Browser Pilot-specific native Agent tools;
- a public JSON-RPC or stdio adapter;
- imports from `src/*`;
- direct consumer access to Broker sockets or locator files.

This decision applies equally to Agent-managed installs and products that
pre-provision Browser Pilot. Both install the same skill and inject stable
environment. The CLI is either installed by the skill's mandatory preflight or
already available on the Agent command environment's `PATH`.

## 3. Public Contract

The supported public contract consists of:

1. The `bp` and `browser-pilot` executable names.
2. Command syntax and `--help` output.
3. JSON success and failure results.
4. Stable machine error codes.
5. Local file results and their metadata.
6. Environment variables documented in this repository.
7. Skill files and their declared CLI compatibility range.
8. Versioned native archives, npm package, checksums, and release index.

Internal Broker methods, schemas, IDs, sockets, files, CDP sessions, and
process roles are not public APIs. They may evolve without creating a second
integration surface as long as the CLI contract remains compatible.

## 4. Host Integration Contract

A shell-capable Agent host needs only:

- a normal local command execution tool;
- the complete Browser Pilot skill;
- permission for the Agent to install the skill's exact npm CLI through the
  normal shell approval flow, or a compatible `bp` executable already on
  `PATH`;
- a stable `BROWSER_PILOT_CLIENT_KEY` per independent Agent;
- an absolute task-owned `BROWSER_PILOT_OUTPUT_DIR` when file results are used;
- ordinary access to returned task files.

The host must not map every Browser Pilot command into a native tool. The skill
provides progressive disclosure, and CLI help provides exact runtime command
discovery.

Managed skill installations must track `plugin/skills/browser-pilot` from the
`skill-stable` branch, which advances only after the matching npm package and
GitHub Release are public. Pre-provisioned installations should pin a CLI
version inside the skill's declared compatible range.

## 5. Browser Scope and Authorization

Browser Pilot exposes all eligible page tabs on the authorized browser
endpoint:

- managed tabs created by Browser Pilot;
- eligible popup descendants of managed tabs;
- eligible tabs opened by the user in every live profile.

Browser-internal pages, extension-owned targets, and targets that cannot be
controlled safely are excluded.

Chrome tab-group membership does not affect tab eligibility. Browser Pilot can
control an eligible tab in an expanded or collapsed group but, without an
extension, cannot inspect, create, rename, move, collapse, or delete groups.

Browser Pilot itself does not ask for task-intent approval. The authorization
boundaries are:

1. The user enables Chrome remote debugging.
2. Chrome presents its own connection authorization dialog when required.
3. The Agent host decides whether the Agent may invoke local commands.

A host may restrict operations through its own policy. Browser Pilot's default
surface remains complete and does not implement an approval state machine.

## 6. Browser Discovery and Connection

Discovery returns structured candidates with:

- stable browser ID;
- product and channel;
- user-data root;
- process state;
- remote-debugging state;
- authorization state;
- aggregate setup state;
- structured remediation.

Discovery is passive. It must not open a TCP or WebSocket connection and must
not display Chrome's Allow dialog.

Only an explicit browser connection command requests authorization. Concurrent
clients share one in-flight connection attempt. A failed or dropped connection
is never retried by a periodic timer. The next explicit command may request
reconnection.

One supervised browser-level CDP WebSocket is shared per endpoint. It must not
be multiplied per CLI process, Agent, profile, or tab.

## 7. Profiles

One browser endpoint may expose multiple live Chrome profile contexts. Browser
Pilot must:

- inventory contexts passively from live target state;
- return representative eligible tabs;
- use connection-generation-scoped opaque profile IDs;
- route new managed tabs only after an unambiguous selection;
- preserve access to existing eligible tabs regardless of profile selection;
- invalidate profile IDs on browser reconnect.

Account-aware identity is an explicit visible operation. Browser Pilot may
open one temporary `chrome://version` page in each unidentified context, match
the exact profile path to bounded Local State metadata, then close the page.
It must not infer account identity from profile directory order or names.

If identity is unavailable or ambiguous, the result uses a neutral label and
representative tabs. The Agent must not silently select the first profile.

## 8. Agent State Model

The public concept is an Agent namespace selected by
`BROWSER_PILOT_CLIENT_KEY` or `--client-key`.

Internally, the Broker maintains a principal, logical workspace, renewable
control lease, target mappings, selected profile/tab/frame, observations,
auth/network configuration, downloads, artifacts, commands, and bounded event
journal. These internal records are not exposed as a host protocol.

Requirements:

- The same stable key resumes one Agent's state across CLI processes.
- Different keys cannot inspect or mutate one another's state.
- A key must not be generated per command.
- State lives in Broker memory, not global refs or active-tab files.
- Browser reconnect invalidates all old browser-generation-scoped addresses.
- Expiry and explicit disconnect reclaim transient state and managed targets.
- User-opened tabs remain open during cleanup.

Compatible CLI versions may establish separate internal client sessions while
sharing the same Agent principal and keyed state. Compatibility is determined
by protocol negotiation, not executable path equality.

## 9. Target Model and Concurrency

Every Agent receives opaque controlled-target addresses. Raw CDP target IDs and
session IDs are internal.

The inventory records origin as:

- `managed`;
- `managed_popup`;
- `user_tab`.

Requirements:

- The same physical user tab may appear in several Agent inventories.
- At most one Agent may control a physical tab at a time.
- A busy target returns stable `target_busy`; another Agent cannot steal it.
- Commands for the same physical target execute serially.
- Commands for independent targets may run concurrently.
- Explicit release removes the controlling session before another Agent can
  acquire the target.
- A tab becoming ineligible invalidates its mapping without closing the tab.
- Bulk close operates only on managed tabs.
- Explicit close may close a selected user tab.

Managed popup adoption requires a complete owned opener chain. Browser Pilot
must fail closed when popup ownership cannot be proven.

## 10. Observation and Refs

An observation fuses bounded accessibility semantics with DOM layout and state.
It includes:

- numbered interactive refs;
- role, accessible name, bounded value, and checked state;
- visibility, enabled/editable state, and geometry;
- open Shadow DOM;
- selected frame context;
- readable text and page geometry where requested;
- truncation metadata.

Each ref is scoped internally by Agent state, browser generation, target, CDP
session, frame, document/loader identity, observation generation, and backing
node identity.

Refs become stale after navigation, document replacement, semantic mutation,
target detach, frame change, reconnect, state release, or a newer invalidating
observation. A stale ref returns `stale_ref`; it must never be silently rebound
to another element.

Observation output is bounded by element count, field sizes, tree depth, text
length, and serialized byte budget. Truncation is explicit.

## 11. Actions and Verification

Browser Pilot supports semantic click, type, press, keyboard input, upload,
scroll, and dropdown selection, plus coordinate input for visual surfaces.

Before dispatch, an element action must validate:

- current ref identity;
- target and frame continuity;
- enabled/editable state;
- live geometry;
- hit point and obstruction;
- browser connection generation.

After dispatch, Browser Pilot returns fresh page state and typed evidence. It
checks applicable effects such as:

- focus changes;
- checked/selected/pressed/expanded state;
- input or contenteditable value length and exact readback;
- navigation or document replacement;
- dialog or popup creation;
- upload file count and filename;
- scroll position;
- dropdown selection.

A mismatch returns a typed verification result or stable error. Sensitive
input evidence records only bounded metadata and never echoes password content.

If the page changes during a compound action, remaining steps are cancelled.
For example, type-with-submit must not press Enter after the input document is
replaced.

## 12. Page Representations

The Agent can choose the smallest representation needed:

- snapshot for semantic controls;
- readable text for articles, lists, and results;
- targeted text search for a phrase and nearby context;
- bounded DOM metadata for selectors and attributes;
- page and scroll geometry for long documents;
- annotated screenshots for visual position and overlap;
- JavaScript evaluation only as an escape hatch.

This adaptive model incorporates the strongest relevant browser-use ideas
without adopting browser-use's Agent runtime or Python API.

## 13. Async Operations and Command Recovery

The CLI provides browser-visible waits for URL, text, selector, dialog,
download, and popup conditions. Waiting uses a caller-defined deadline and
bounded polling interval. Timeout returns stable `wait_timeout` and does not
assert anything about an underlying mutation.

Every browser command has an internal command record with status:

- `accepted`;
- `dispatched`;
- `completed`;
- `unknown_outcome`;
- `cancelled`;
- `expired`.

The CLI exposes bounded command list, lookup, and cancellation commands.
`--request-id` supplies stable intended-call identity. The Broker derives
deterministic command and idempotency keys so a lost CLI result can be recovered
without redispatching the same intended call.

Cancellation is deterministic before dispatch and best effort after dispatch.
A connection loss or cancellation after mutation dispatch produces
`unknown_outcome` unless success or failure is known. The Agent must inspect
current browser state before retrying.

CLI `SIGINT` and `SIGTERM` request cancellation for the active command but do
not claim rollback.

## 14. Dialogs, Auth, Cookies, and Network

Dialogs are scoped to owning Agent state and remain pending until explicitly
accepted or dismissed. Browser Pilot never chooses a dialog response.

HTTP authentication credentials and network rules are scoped to the Agent
namespace. Credential values are not retained outside the active configuration
needed by Chrome.

Cookie reads are scoped to the current URL or explicit domain.

Network support includes bounded request journals, detail/body reads, blocking,
mocking, header overrides, rule listing/removal, and clearing. Sensitive fields
carry internal sensitivity metadata and bounded output.

## 15. Files and Media

CLI file-producing commands return:

- absolute local path;
- MIME type;
- byte size;
- width and height for images when available;
- command-specific metadata such as annotation count.

When `BROWSER_PILOT_OUTPUT_DIR` is set, it is an enforced output boundary:

- relative filenames resolve inside that absolute directory;
- absolute filenames are accepted only when they remain inside it;
- `..` and existing symbolic-link escapes are rejected before browser or
  network work starts;
- generated default filenames are written inside it.

When the variable is unset, explicit filenames resolve normally and generated
defaults use the current working directory for backward compatibility.

The Broker stores media and downloads in private bounded temporary storage,
then exports them to a caller-authorized absolute path. Binary bytes are never
written into normal CLI JSON.

Uploads copy a caller-authorized source into private storage and release it
after browser assignment. Downloads copy Chrome's completed file. Browser Pilot
never moves, truncates, deletes, or cancels the user's original file.

Storage has per-item, per-Agent, and global quotas plus expiry. Paths are not
derived from external IDs, symbolic-link escapes are rejected, and file modes
are private.

## 16. Downloads

Download tracking is attached only to controlled sessions and browser
connection generation. Completed browser events are attributed to the owning
Agent before copying.

Requirements:

- downloads from unrelated or unowned tabs are ignored;
- duplicate browser GUID ownership fails closed;
- quota failure affects only the Browser Pilot copy;
- releasing Agent state stops tracking but does not cancel Chrome's download;
- reconnect configures browser-level download events once per generation;
- completed downloads can be listed and exported later by the same Agent key.

## 17. Error Contract

Non-TTY CLI failures emit one JSON object with:

- `ok: false`;
- stable `code`;
- human-readable `error`;
- `retryable`;
- optional bounded `context`;
- optional `remediation`;
- optional recovery `hint`.

Consumers branch on `code`, never English text. Stable codes cover input,
authorization, browser lifecycle, profile routing, target contention, stale
state, verification, waiting, cancellation, uncertainty, quota, and internal
failure.

`retryable: true` means a later call may be valid. It never means the same
mutation is safe to replay.

## 18. Process and Shutdown Model

The public CLI is short-lived. The per-user Broker and managed-target
connection supervisor are private background roles.

Startup uses a private lock and locator. Simultaneous CLIs create exactly one
Broker. A live but unresponsive Broker is never silently replaced.

The supervisor is the sole owner of Browser Pilot-created target identities.
After Broker crash or abrupt exit, it closes only managed targets and eligible
managed popup descendants. It never persists target IDs to disk and never
closes user-opened tabs.

`bp disconnect` first releases the current Agent namespace. It may stop the
whole Broker only when:

1. no active Agent state remains;
2. the Broker process identity has not changed;
3. the invoking executable version and content/path identity match the
   installation that started the Broker.

A compatible CLI from another installation succeeds in releasing its state but
leaves the Broker running.

## 19. Distribution

Supported distributions are:

- managed Agent skill with an exact npm CLI preflight;
- global npm install;
- local npm install or `npx --no-install`;
- product-bundled npm package with pinned Node runtime;
- self-contained native executable.

Native targets are Apple Silicon macOS, x64 Linux, and x64 Windows. Intel Mac
is intentionally unsupported.

Every release includes:

- versioned native archives;
- archive checksum sidecars;
- per-file checksums and licenses inside native archives;
- an Agent skill/plugin archive and checksum;
- a release index binding CLI version, protocol range, skill compatibility
  range, tested version, supported platforms, asset sizes, and hashes.

CLI, skill, plugin manifests, compatibility metadata, and checksums must be
released from one synchronized root version. After publication succeeds, the
release commit advances the non-force-updated `skill-stable` branch.

## 20. Security and Privacy Invariants

- No browser extension is used or required.
- Broker runtime directories and files are private to the OS user.
- Public results never expose raw CDP target/session/node IDs.
- Cross-Agent object access fails closed.
- User tabs are not closed by release, crash cleanup, or bulk close.
- Browser authorization is never requested by discovery or timers.
- Output is bounded and carries truncation metadata.
- Password and credential values are not echoed in verification evidence.
- File operations reject unsafe paths and symbolic-link escapes.
- Raw CDP is not a public Agent interface.

### 20.1 Local Broker Endpoint Threat Model

The Broker endpoint is local to one OS account. On Unix, a mode-0600 socket
inside a mode-0700 directory prevents access by other OS users. On Windows,
the named pipe relies on the platform's default DACL; the resulting limitation
and the selected hardening strategy are recorded separately below.

Endpoint authentication is in scope for:

- cross-user access, in addition to the Unix filesystem boundary;
- same-user sandboxed processes that can reach the local transport but cannot
  read the Browser Pilot state directory;
- accidental or confused-deputy calls from same-user software that has no
  reason to control the Broker;
- session impersonation based only on guessing a predictable client session
  identifier.

A malicious process running as the same OS user with access to the Browser
Pilot state directory is out of scope. Such a process can read any shared
secret stored there. The endpoint token is therefore not a defense against
same-user malware. Defending that case would require per-client credentials
issued through user interaction or an OS- or host-provided isolation boundary.

### 20.2 Windows Named-Pipe Access Control

Windows retains the named-pipe transport and its default DACL. A shared-secret
endpoint token is the primary Windows boundary for processes that can reach the
pipe but cannot read the Browser Pilot state directory. At daemon startup,
Browser Pilot restricts that directory and the locator containing the token to
the current Windows user, local administrators, and the system account. The
default pipe DACL is not treated as an independently verified current-user-only
boundary.

This decision follows these platform constraints:

- Node's `net.Server.listen()` API cannot attach a Windows security descriptor
  to a named pipe. Its `readableAll` and `writableAll` options broaden access
  and cannot express a current-user-SID ACL.
- Applying a pipe ACL directly would require a native addon or helper. The
  standalone distribution is a single Node SEA executable built from bundled
  CommonJS. A helper would add architecture-specific build output, packaging
  and checksum entries, process supervision, and an additional binary to sign
  and verify on each release platform. A native addon would likewise have to
  remain external to the SEA payload and match the embedded Node ABI. That
  cost is disproportionate to the boundary defined in 20.1.
- Loopback TCP would avoid the named-pipe API limitation but would make the
  endpoint reachable through the host network stack by every local account,
  introduce port allocation and firewall behavior, and replace the existing
  stable local-IPC discovery contract. It offers no compensating protection
  once possession of the token remains the authentication boundary.

The Windows directory and locator ACL are defense in depth around token
storage, not a claim to defend against a malicious same-user process that can
already read the state directory.

### 20.3 Broker Endpoint Authentication

Each Broker process generates a new random endpoint token and stores it only in
the private Broker locator. Every endpoint except `GET /health` requires that
token as a Bearer credential. Authentication happens before request parsing or
Broker dispatch, and a rejected request returns a structured error.

The unauthenticated health response is read-only and contains only `ok`,
`brokerProtocol`, `serviceVersion`, `executableVersion`, `executableIdentity`,
`brokerProcessIdentity`, `browser`, and `clients`. Optional fields may be absent,
but no other state is exposed. In particular, the token and browser CDP
WebSocket URL are never health fields.

The CLI derives its stable internal client session identifier as an HMAC of the
client key and executable version, keyed by the endpoint token. A token or
Broker identity change during client initialization discards the entire client
construction, reloads the locator once, recomputes the HMAC, and starts again
from `initialize`. A dispatched tool call is never replayed by this recovery
path.

The authenticated private transport is Broker RPC version 3. Mixed versions
fail closed after discovery through the open health endpoint. A live
incompatible Broker is never replaced automatically; the user must stop it with
the executable that started it, stop its recorded process explicitly, or use a
separate `BROWSER_PILOT_HOME`.

## 21. Acceptance Gates

A release is acceptable only when all of the following hold:

- TypeScript build succeeds.
- All unit and Broker process tests pass.
- Isolated Chrome capability metrics do not regress.
- Local Playwright core, compatibility, and network suites pass.
- npm global, local, and product-bundled distributions pass black-box tests.
- Native self-contained verification passes on release platforms.
- CLI help exposes `--client-key`, `--request-id`, `--timeout`, status, wait,
  command recovery, and file commands.
- No removed persistent adapter command is present.
- Two Agent keys remain isolated while sharing one Broker.
- Compatible CLI installations reuse a Broker.
- A non-owner CLI cannot stop another installation's Broker.
- One physical user tab is never controlled concurrently by two Agents.
- Browser reconnect invalidates old refs and target identities.
- Managed crash cleanup leaves user tabs untouched.
- Screenshot, PDF, download, upload, and saved network results use local files
  with complete metadata.
- `BROWSER_PILOT_OUTPUT_DIR` confines every CLI-created task file when set.

Real-site canaries report drift separately and do not make deterministic release
gates depend on third-party uptime.

## 22. Non-Goals

- General cross-browser automation outside Chromium CDP.
- A remote multi-tenant browser service.
- Browser-extension capabilities such as tab-group management.
- A model provider or Agent orchestration framework.
- Per-action user-intent approval inside Browser Pilot.
- A public SDK, MCP server, or alternate machine protocol.
