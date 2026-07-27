# Agent Host Integration Acceptance

Run this gate before promoting a Browser Pilot release or shipping an embedded
Agent integration. It treats Browser Pilot as an external executable and uses
only the versioned `bridge --stdio` protocol through the public reference
adapter pattern. It imports no Browser Pilot production module.

## Isolated release gate

The default command builds the repository executable, starts a temporary
headless Chrome with a temporary default download directory and isolated Broker
home, runs the suite, restarts that Chrome once, and removes every temporary
resource:

```bash
npm run test:host-acceptance
```

Test an exact installed or product-bundled executable by passing its absolute
command prefix after `--`. Do not include `bridge --stdio`; the runner adds it
for each host process:

```bash
node scripts/run-isolated-host-integration-acceptance.mjs \
  --expected-version 0.3.0-rc.6 \
  -- /absolute/path/to/browser-pilot

node scripts/run-isolated-host-integration-acceptance.mjs -- \
  /absolute/path/to/node /absolute/path/to/browser-pilot/dist/cli.js
```

## Controlled user-Chrome acceptance

The direct runner uses the selected executable's ordinary Broker home and may
request Chrome authorization. Confirm Chrome is running with remote debugging
enabled, then invoke it once. Never start a second runner while the first is
waiting for Allow.

If more than one live Profile is discovered, choose explicit one-based indices
for both hosts. The indices are resolved from fresh `browser.profiles.list`
results and passed back to the protocol as opaque Profile IDs:

```bash
node scripts/run-host-integration-acceptance.mjs \
  --expected-version 0.3.0-rc.6 \
  --profile 1 \
  --second-profile 2 \
  --report test-results/host-acceptance-real.json \
  -- /absolute/path/to/browser-pilot
```

The direct run creates one temporary managed page for each host, exercises a
local download, and then releases both Workspaces. It observes one uniquely
identifiable user tab only to prove `target_busy` and explicit handoff. It does
not navigate, edit, or close that user tab. Cleanup must remove only the two
managed pages and preserve the complete initial user-tab inventory.

The runner does not stop or restart a user-owned browser. Disconnect/reconnect
coverage runs only when the isolated wrapper supplies ownership of the Chrome
lifecycle.

## Coverage

The versioned JSON report contains no URLs, titles, opaque IDs, page text,
Artifact paths, or bridge diagnostics. It verifies:

- two independent host Connections, Workspaces, and Leases reuse one Broker;
- one explicit concurrent connect path and protocol 1.2 negotiation;
- explicit Profile routing for both managed Workspaces;
- user-tab exclusivity, `target_busy`, release, and handoff;
- concurrent one-shot CLI use while both embedded hosts remain live;
- screenshot conversion to native image bytes;
- PDF and download export into host-owned absolute paths;
- Chrome's original downloaded file survives Artifact and Workspace cleanup;
- event replay before explicit cursor acknowledgement;
- managed-only Workspace cleanup with the user-tab inventory preserved; and
- isolated `connection.lost` / `connection.restored` recovery with old Profile
  and target identities rejected.

This gate complements the language-neutral stdio conformance runner. The
conformance suite validates one bridge implementation; this suite validates the
multi-host behavior an Agent product actually depends on.
