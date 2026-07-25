# Reference Agent Adapters

These adapters demonstrate complete consumer-side integration with the public
`browser-pilot bridge --stdio` protocol. They are examples, not a published
Native SDK, and are excluded from the npm package. Browser Pilot production code
contains no Tenon or OpenClaw lifecycle concepts.

Both adapters use the same black-box process owner in
`shared/browser-pilot-process.mjs`. It provides:

- direct absolute-path launch without a shell;
- protocol/capability negotiation and runtime tool discovery;
- Workspace/Lease creation, heartbeat, event cursors, and bounded cleanup;
- explicit target context with no hidden active-tab state;
- stable Command IDs and idempotency keys derived from host tool-call IDs;
- best-effort command cancellation without replaying mutations;
- screenshot conversion to native `{ type: "image", data, mimeType }` content;
- PDF and other file Artifact export into an absolute host-owned scratch path;
- Artifact release after conversion/export and structured sensitivity details.
- explicit 1 MiB model-text truncation while retaining the bounded full result
  in host details for UI/log storage.

## Tenon mapping

`tenon/browser-pilot-adapter.mjs` maps one Tenon Thread to a Browser Pilot
Workspace and one active Turn to a renewable Lease. It projects every discovered
Browser Pilot operation as an individual Pi-style Agent tool. Target-scoped
tools require `controlTargetId`; the adapter never persists an active target or
ref. End the Turn to release its Lease, release the Thread to close only its
managed tabs, and close the adapter during app shutdown.

Tenon should bundle a pinned native executable under Electron `extraResources`
and resolve its absolute path from `process.resourcesPath` in packaged builds.
Development may use an explicit environment override to a locally built
executable. The executable, installation identity, and protocol version are
Browser Pilot concerns; Tenon must not inspect Broker locator files.

## OpenClaw mapping

`openclaw/browser-pilot-adapter.mjs` maps one OpenClaw agent session to a
Workspace and one Agent run to a Lease. It exposes one dispatcher tool because
OpenClaw plugin registration is synchronous while Browser Pilot tool discovery
is asynchronous. The dispatcher operation enum and description come from the
runtime manifest after the plugin service has started. Register the adapter as
a plugin-owned service, create the tool from the active run context, release the
run and session through the matching hooks, and stop the service on shutdown.

OpenClaw already has an unrelated browser plugin with optional extension paths.
A Browser Pilot integration should be a separate external plugin and must not
modify or import that plugin. This preserves Browser Pilot's no-extension
contract and avoids changing OpenClaw core defaults.

## Minimal process setup

```js
import { BrowserPilotProcessAdapter } from './shared/browser-pilot-process.mjs';

const connection = await BrowserPilotProcessAdapter.connect({
  executable: '/absolute/product-owned/path/browser-pilot',
  client: {
    id: 'com.example.agent',
    name: 'Example Agent',
    version: '1.0.0',
    instanceId: 'stable-installation-id',
  },
});
```

Pass `/absolute/product-owned/scratch/browser-pilot` as `artifactDirectory` to
the Tenon or OpenClaw host adapter, where host-native file references are also
formatted.

Use a stable installation-scoped `client.instanceId`, but keep Workspace, Lease,
target, Observation, ref, Command, Artifact, and cursor IDs only in memory.
Adapters should pause browser mutations on `connection.lost`, rebuild target and
Observation mappings after `connection.restored`, and use `pollEvents` when
notifications are dropped. Process every returned event before calling
`acknowledgeEvents(nextCursor)`; polling again without acknowledgement safely
replays from the last processed cursor. After `cursor_expired`, rebuild tabs and
Observations before calling `resetEventCursor` for a new baseline.

The only identity intended to survive product restarts is the host's normal,
installation-scoped `client.instanceId`. It identifies the embedding product to
the live per-user Broker; it is not browser task state. Browser Pilot lifecycle
IDs and event cursors remain transient and are rebuilt after a Broker restart.
