# Stdio Conformance Suite

The stdio conformance suite verifies an embedded Browser Pilot executable as a
black box. It launches the exact command supplied by the integrator, exchanges
only newline-delimited JSON-RPC 2.0 over stdin/stdout, and imports no Browser
Pilot source or protocol modules.

Build and test the repository executable:

```bash
npm run build
node scripts/run-stdio-conformance.mjs
```

An installed package also exposes the same runner as
`browser-pilot-conformance`.

Test an executable or product-bundled adapter with its exact arguments. The
command after `--` is passed directly to the operating system without a shell:

```bash
node scripts/run-stdio-conformance.mjs -- \
  /absolute/path/to/browser-pilot bridge --stdio
```

Use `--report <path>` to write the same JSON report printed to stdout, and
`--timeout-ms <value>` to change the per-operation timeout. A passed suite exits
with status 0, a conformance failure exits with status 1, and invalid runner
arguments exit with status 2.

The suite creates one transient Workspace, one renewable Lease, and one managed
`about:blank` target. It does not enumerate or control user tabs. It validates:

- initialization and capability negotiation;
- tool manifest discovery;
- Workspace, Lease, and heartbeat lifecycle;
- managed target creation and inventory;
- a bounded Observation;
- screenshot creation, protected Artifact access, and release;
- event cursor polling;
- explicit target, Lease, Workspace, and bridge cleanup.

Failures trigger best-effort cleanup of only the resources created by the
suite. The versioned report contains check outcomes, counts, timings, version
metadata, and a bounded error summary. It intentionally omits opaque resource
IDs, Artifact paths, browser content, and bridge stderr text.

The repository tests exercise the runner against an independent fake stdio
executable, so normal unit tests do not connect to Chrome. Running the suite
against the real executable requires a ready supported browser and may start or
reuse the per-user Browser Pilot daemon.
