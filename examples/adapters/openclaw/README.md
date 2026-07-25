# OpenClaw Consumer Wiring

Browser Pilot should integrate as a separate external OpenClaw plugin. It must
not modify, import, replace, or silently enable OpenClaw's existing browser
plugin, which has different ownership and optional extension paths.

## Distribution

An external plugin can pin `browser-pilot-cli` as its own runtime dependency and
launch an exact command such as:

```js
command: [process.execPath, absolutePackagedCliPath, 'bridge', '--stdio']
```

Alternatively it can install the verified native archive for the current
platform and use the absolute executable path. Do not search a user's global
`PATH` by default. The plugin installer owns version pinning and rollback;
Browser Pilot owns Broker compatibility negotiation.

## Plugin lifecycle

1. Register a plugin-owned service. Its async `start` creates one
   `BrowserPilotProcessAdapter`; its `stop` calls `close()`.
2. Register one `browser_pilot` tool factory synchronously. The tool's execute
   path waits for the service start promise, then calls `beginRun` with the
   OpenClaw agent ID, session key, and run ID.
3. Build the dispatcher only after Browser Pilot initialization. Its operation
   union is generated from `tools/list`, and Browser Pilot remains the authority
   for each operation's input validation.
4. Release the run Lease from the Agent run terminal hook. Release the session
   Workspace only from the session retirement hook. Do not make gateway/channel
   disconnects own browser cleanup.
5. Use a plugin-owned scratch/output directory for PDF and download export.
   Return screenshots as native image tool content and files through OpenClaw's
   canonical file/media result path.

The dispatcher requires `controlTargetId` for target-scoped operations. It does
not adopt raw CDP IDs and does not keep a hidden active tab. Tool-call IDs become
stable Browser Pilot Command/idempotency identities, so OpenClaw retries cannot
redispatch a completed mutation. `unknown_outcome` must be shown to the Agent as
inspect-before-retry, never as an automatic retry signal.

Browser event notifications are low-latency hints. The plugin should retain the
last fully processed cursor in the live adapter Workspace and recover with
`pollEvents`. Process the complete page before calling `acknowledgeEvents`; do
not persist the cursor across a Browser Pilot Broker restart. If it expires,
rebuild tabs and Observations before calling `resetEventCursor`.
