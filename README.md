# Browser Pilot

Give an AI Agent control of the user's real Chrome browser, including existing
logins, cookies, profiles, and extensions. No browser extension is required.

```bash
npm install -g browser-pilot-cli@latest
bp --version
```

Native releases support Apple Silicon macOS, x64 Linux, and x64 Windows. Intel
Mac is not supported.

## Agent Setup

### 1. Enable Chrome remote debugging

Open `chrome://inspect/#remote-debugging` in Chrome 144 or newer and enable
remote debugging. Browser Pilot does not use command-line debugging flags or a
Chrome extension.

Inspect installed browsers without requesting authorization:

```bash
bp browsers
```

Follow the returned remediation first. Start the selected browser or enable
remote debugging when requested. Browser Pilot does not connect automatically.

When the browser is ready and browser work is needed, tell the user to watch
for Chrome's Allow dialog, then connect once:

```bash
bp connect --browser <browser-id>
```

Chrome may display one Allow dialog for the browser connection. Browser
discovery and background-service startup are passive. Concurrent clients share
one pending connection request, so they do not create an authorization loop.
Machine-readable `bp connect` output is emitted after the attempt finishes, so
an Agent must show the Allow reminder before invoking the command. A timeout or
`browser_not_authorized` result must be inspected; it is not a reason to loop
connection attempts.

### 2. Install the Agent skill

Claude Code:

```text
/plugin marketplace add https://github.com/relixiaobo/browser-pilot.git
/plugin install browser-pilot@browser-pilot-marketplace
```

Codex, Cursor, or VS Code Copilot:

```bash
npx skills add relixiaobo/browser-pilot --skill browser-pilot
```

OpenClaw or another Agent Skills-compatible host:

```bash
cp -r plugin/skills/browser-pilot ~/.agents/skills/
```

### 3. Ask for the browser task

- "Fill in the form I already opened."
- "Check my GitHub notifications."
- "Download the latest invoice and summarize it."
- "Open this report in a new tab and save it as PDF."

The Agent uses its existing shell tool to run `bp`. Browser Pilot does not add
native Agent tools, an MCP server, an SDK, or a persistent client protocol.

## Public Interface

Browser Pilot has one Agent integration surface:

```text
Agent -> Browser Pilot skill -> existing shell/command runner
      -> bp CLI -> shared background service -> Chrome
```

The skill provides progressive disclosure and browser-specific operating
guidance. The CLI provides stable JSON, errors, state, files, waiting, and
recovery. The background service is private implementation detail shared by all
compatible CLI installations for the current OS user.

This same path supports both installation modes:

- An Agent installs `browser-pilot-cli` itself.
- A product bundles a pinned CLI and places its directory on the Agent command
  environment's `PATH`.

Tenon, OpenClaw, Codex, and other shell-capable Agents need no Browser
Pilot-specific runtime integration. See
[the embedding reference](plugin/skills/browser-pilot/references/embedding.md).

## Browser Scope

`bp tabs` exposes all eligible page tabs on the authorized browser endpoint:

- Browser Pilot-created managed tabs;
- eligible popups from managed tabs;
- eligible tabs the user opened in any live Chrome profile.

The Agent can therefore fill a form or inspect a page the user already opened.
Browser-internal and extension-owned pages are excluded. Existing Chrome tab
groups do not limit tab control, whether expanded or collapsed, but Browser
Pilot cannot inspect or manage tab groups without an extension.

Browser Pilot does not implement task-intent permission prompts. Invoking the
tool gives the Agent the full eligible browser capability surface. An Agent
host may apply its own policy or approval UX, but that is outside the Browser
Pilot contract.

User-opened tabs remain open when Agent state is released. `bp close --all`
closes only Browser Pilot-created tabs. `bp close` explicitly closes the
selected tab, including a user tab.

## Chrome Profiles

One authorized browser connection can expose several live Chrome profiles.

```bash
bp profiles
bp profiles --identify
bp profile 2
bp open https://example.com --new --profile 2
```

`bp profiles` is passive and includes representative tabs. Use
`--identify` only when account-aware identity is needed; it briefly opens and
closes a visible `chrome://version` page per unidentified profile and accepts
identity only after exact profile-path verification. Browser Pilot reports
verified profile/account names rather than forcing the Agent to speak in
ambiguous "Profile 1" labels.

Profile selection controls where new managed tabs are created. It does not
grant or restrict access to existing eligible tabs.

## Multi-Agent State

Every independent Agent must use one stable key across all short-lived CLI
processes:

```bash
export BROWSER_PILOT_CLIENT_KEY=product.install.agent-01
bp tabs
bp snapshot
```

Or pass `--client-key` before the command. The key preserves the Agent's
selected profile, tab, frame, refs, auth, network rules, downloads, and command
history. Different keys are isolated and cannot overwrite one another.

Browser Pilot keeps this state in background-service memory, not global
`state.json` or `refs.json` files. `bp disconnect` releases only the current
key. It stops the service only when no other Agent is using it and the invoking
executable owns that service process.

Compatible global, local, and product-bundled CLIs reuse the same per-user
service through protocol negotiation. Executable identity is required only for
stopping the whole service. Use a distinct absolute `BROWSER_PILOT_HOME` only
for a deliberately incompatible isolated installation.

## Core Workflow

```bash
bp tabs                              # find existing user or managed tabs
bp tab 2                             # select by current one-based index
bp open https://example.com --new    # create independent managed work
bp snapshot                          # get controls with numbered refs
bp read main --limit 10000           # get bounded readable content
bp search "invoice total"            # find text with nearby context
bp click 3                           # act on a fresh ref
bp type 5 "hello" --clear            # replace input and verify readback
bp press Enter                       # press a key and return fresh state
```

Action commands return fresh page state and typed browser-visible evidence.
Refs belong to the current tab, frame, and page state. Refresh them after
navigation, document changes, tab/frame switches, reconnect, or `stale_ref`.

Use dedicated page primitives before JavaScript:

```bash
bp find ".result" --attributes href
bp scroll --to-text "Payment details"
bp dropdown 4
bp select 4 "United States"
bp screenshot page.png --annotate 1,3,8
```

`bp eval` remains an escape hatch when no dedicated command represents the
operation.

## Async Work and Recovery

Wait for browser-visible state instead of using shell sleeps:

```bash
bp --timeout 30000 wait --url "*/complete"
bp --timeout 30000 wait --text "Payment received"
bp --timeout 30000 wait --selector ".result"
bp --timeout 30000 wait --dialog
bp --timeout 120000 wait --download
bp --timeout 30000 wait --popup
```

Inspect service and command state after a timeout, interrupted shell call, or
lost result:

```bash
bp status
bp commands --status accepted,dispatched,unknown_outcome
bp command <command-id>
bp cancel <command-id>
```

Attach a stable request identity before the first attempt when the caller may
need to recover the same intended operation:

```bash
bp --request-id task-42-submit click 7
```

Reuse that ID only for recovery of the same intended call. Use a new ID for a
new action. Browser Pilot deduplicates stable requests and attempts
cancellation on CLI `SIGINT`/`SIGTERM`, but a dispatched mutation can still
have an `unknown_outcome`. Inspect the current page before retrying.

Machine errors always include stable `code` and `retryable` fields. Branch on
`code`, not English text.

## Files, Screenshots, PDFs, and Downloads

Use explicit task-owned paths or set a default directory:

```bash
export BROWSER_PILOT_OUTPUT_DIR=/absolute/task/output
bp screenshot
bp screenshot full.png --full
bp pdf report.pdf --landscape
bp downloads
bp download 1 invoice.pdf
bp net show 12 --save response.json
```

File results return an absolute `file` path, MIME type, byte size, and image
dimensions when available. An Agent can open that path with its normal image or
file-reading capability. CLI output remains bounded JSON and never embeds large
binary payloads.

Browser Pilot copies uploads and completed downloads into protected temporary
storage while processing them. It never removes the source upload or Chrome's
original download.

## Command Groups

| Area | Commands |
|------|----------|
| Setup and state | `browsers`, `connect`, `status`, `disconnect` |
| Profiles and tabs | `profiles`, `profile`, `tabs`, `tab`, `open`, `close` |
| Observation | `snapshot`, `read`, `search`, `find`, `locate` |
| Interaction | `click`, `type`, `keyboard`, `press`, `scroll`, `dropdown`, `select`, `eval` |
| Async and recovery | `wait`, `commands`, `command`, `cancel` |
| Page context | `frame`, `dialogs`, `dialog` |
| Files and media | `upload`, `downloads`, `download`, `screenshot`, `pdf` |
| Browser data | `cookies`, `auth`, `net` |

Run `bp --help` or `bp <command> --help` for exact options.

## How It Works

```text
short-lived bp CLI processes
          |
          | private local HTTP/Unix socket
          v
per-user Browser Pilot service
          |
          | one supervised CDP WebSocket per browser endpoint
          v
Chrome profiles and eligible tabs
```

The service serializes actions per physical tab while allowing independent
tabs to progress concurrently. Each Agent receives isolated logical state and
opaque tab/ref addresses. The same physical user tab can be controlled by only
one Agent at a time.

An internal connection supervisor owns Browser Pilot-created tabs so it can
clean them up after a service crash without touching user-opened tabs. Browser
disconnect invalidates old tab, frame, and ref identities before reconnect.

See:

- [Current architecture](docs/architecture/browser-pilot-platform-spec.md)
- [Universal Agent integration plan](docs/plans/universal-agent-integration.md)
- [Browser capability evolution](docs/plans/browser-capability-evolution.md)
- [Chrome profile routing](docs/plans/profile-context-routing.md)

## Comparison

| | Browser Pilot | browser-use | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|---|
| Agent interface | Skill + CLI | Python library/Agent runtime | MCP tools | MCP tools |
| User's signed-in Chrome | Yes | Yes | Usually isolated browser | Depends on launch mode |
| Browser extension | No | No | No | No |
| Eligible user tabs | Yes | Browser-session dependent | Browser-session dependent | Yes |
| Progressive Agent guidance | Skill references | Library/Agent prompts | Tool descriptions | Tool descriptions |
| Action verification | Typed evidence + fresh state | State/history checks | Fresh snapshots | Manual inspection |
| Async recovery | Wait + command status + request IDs | Agent/controller lifecycle | Host/MCP lifecycle | Host/MCP lifecycle |
| Local media results | Paths + metadata | Library objects/paths | MCP image/resource results | MCP results |
| Network interception | Observe, block, mock, headers | Limited by controller | Supported | Supported |

Browser Pilot adopts several strong browser-use ideas without adopting its
Python Agent runtime: adaptive DOM/accessibility observation, fresh state after
actions, input readback, obstruction checks, stale-state invalidation,
watchdogs, and bounded outputs. The Agent interface remains the CLI.

## Product Embedding

Bundle the native CLI or `browser-pilot-cli` plus a pinned Node runtime. Verify
the versioned release index and checksums. Put the bundled command directory on
the Agent's `PATH`, install the complete skill, and inject:

```text
BROWSER_PILOT_CLIENT_KEY=<stable logical Agent identity>
BROWSER_PILOT_OUTPUT_DIR=<absolute task-owned directory>
```

Do not map every CLI command into a native tool. The Agent already has a shell
tool, the skill controls context growth, and `bp --help` provides runtime
discovery. Agent-managed and product-bundled installations therefore exercise
the exact same implementation and guidance.

Each release ships a plugin archive, native archives, checksums, and a release
index binding the CLI version, compatible skill range, protocol range, and
supported assets. No `darwin-x64` artifact is produced.

## Testing

```bash
npm run test:unit          # TypeScript build and all Node tests
npm test                   # unit tests plus local Playwright gates
npm run test:capabilities # isolated-Chrome quantitative capability gate
npm run test:distribution # packed global/local/bundled CLI verification
npm run test:canary       # non-blocking real-site drift report
npm run test:canary:strict
```

Automated browser tests use isolated temporary Chrome profiles and Broker homes.
They never attach to the user's Chrome unless a maintainer explicitly opts into
a controlled manual test.

Build and verify a native artifact with an SEA-capable Node runtime:

```bash
BROWSER_PILOT_SEA_NODE=/absolute/path/to/node npm run build:standalone
npm run verify:standalone
npm run package:standalone
npm run release:prune -- --dry-run # preview local artifact retention
npm run release:prune              # retain the two newest version groups
```

Agent evaluations are maintainer-only and use a separate Caliper checkout:

```bash
CALIPER_ROOT=/absolute/path/to/caliper npm run test:agent:dry
```

The root `package.json` version is the release source of truth. The npm version
lifecycle synchronizes the lockfile, plugin manifests, skill compatibility
range, and marketplace entry:

```bash
npm version "$BROWSER_PILOT_RELEASE_VERSION" --no-git-tag-version
npm run release:check-version
```

## Requirements

- Chrome 144+, Edge, Brave, or another supported Chromium browser
- Node.js 22 or newer for the npm distribution
- Remote debugging enabled at `chrome://inspect/#remote-debugging`
- Apple Silicon macOS, x64 Linux, or x64 Windows for native releases

## License

MIT
