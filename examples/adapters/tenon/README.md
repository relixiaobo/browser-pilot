# Tenon Consumer Wiring

The reference adapter is intended to run only in Tenon's Electron main process.
Do not expose the Browser Pilot process, Artifact paths, or protocol directly to
the renderer/preload boundary.

## Packaging

Pin one Browser Pilot version in Tenon's build inputs. For each target platform
and architecture, verify the release archive checksum and `manifest.json`, then
copy the native `browser-pilot` executable plus its license files into a generated
build directory. Add that directory to Electron Builder `extraResources`.

At runtime resolve the packaged executable from `process.resourcesPath`. A
source run may accept one explicit absolute development override. Do not search
`PATH`, run `npx`, download a runtime, or silently fall back to a global install.
This makes the executable version part of the Tenon release and keeps startup
deterministic.

For the native archive, pass the unpacked executable as `executable`; the shared
adapter appends `bridge --stdio`. If Tenon pins the npm layout instead, pass the
complete absolute command explicitly:

```js
const connection = await BrowserPilotProcessAdapter.connect({
  command: [process.execPath, absolutePackagedCliPath, 'bridge', '--stdio'],
  client: {
    id: 'com.linlab.tenon',
    name: 'Tenon',
    version: app.getVersion(),
    instanceId: tenonInstallationId,
  },
  onBrowserEvent: event => browserEvents.publish(event),
});

const browserPilot = new TenonBrowserPilotAdapter(connection, {
  artifactDirectory: absoluteAgentScratchDirectory,
  formatFileReference: path => tenonFileReference(path),
});
```

All values in this snippet come from Tenon's main process. The renderer receives
only Tenon's normal tool/event projections, never the child process or protected
Artifact paths.

## Main-process lifecycle

1. Start one `BrowserPilotProcessAdapter` after Electron app paths and Tenon's
   stable installation identity are available. Use that installation identity
   as `client.instanceId`.
2. Construct `TenonBrowserPilotAdapter` with Tenon's app-owned Agent scratch
   directory as `artifactDirectory` and its canonical local-file reference
   formatter as `formatFileReference`.
3. Before a Turn's tools are frozen, call `beginTurn({ threadId, turnId })`.
   Add `createTools(turn)` to the ToolRuntime catalog for that Turn.
4. Call `endTurn(turnId)` from the same terminal/cancellation path that retires
   other Turn resources. A killed renderer is irrelevant because the main
   process owns the bridge.
5. Call `releaseThread(threadId)` only when Tenon retires that Thread's browser
   work. This releases its Workspace and closes only Browser Pilot-managed tabs;
   user-opened tabs stay open.
6. Call `close()` from Tenon's existing bounded Agent-service shutdown sequence
   before Electron exits.

The adapter returns Pi-compatible text/image content. Screenshot bytes are read
from the protected Artifact, converted to base64 image content, and released.
PDFs and downloads are exported to Tenon's scratch directory and returned using
Tenon's own file-reference syntax. Persist only normal Tenon transcript/tool
records; never persist Browser Pilot Workspace, Lease, target, frame,
Observation, ref, cursor, credential, or network-rule identities.

## Tool configuration

Tool names are projected as `browser_pilot_<canonical_name>`, for example
`browser_pilot_browser_tabs_list`. Add the projected names to Tenon's normal
tool catalog/configuration flow rather than bypassing it with a hidden tool.
Browser Pilot itself grants full browser capability; any Tenon approval or tool
visibility behavior remains a Tenon concern.

Expose `browser.profiles.list` and `browser.profiles.select` like every other
runtime-discovered tool. When a Turn needs a new managed tab and several
Profiles are available without a target anchor, Tenon should render the Profile
summaries as its normal Agent/user choice and send only the returned opaque ID.
Tabs the user already opened remain directly controllable across Profiles.

On `connection.lost`, pause browser mutations for affected Turns. After
`connection.restored`, list tabs again, select the intended opaque target, and
observe again. Never reuse a prior target/frame/Observation/ref mapping. Poll
events through `connection.pollEvents(turn.context)`, finish host processing,
then call `connection.acknowledgeEvents(turn.context, nextCursor)`.
