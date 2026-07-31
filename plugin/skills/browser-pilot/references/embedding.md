# Embedding Browser Pilot in an Agent Product

Use one integration model for Tenon, OpenClaw, Codex, Claude Code, and any other
shell-capable Agent host:

```text
Agent -> Browser Pilot skill -> host shell/command runner -> bp CLI -> Chrome
```

Do not create Browser Pilot-specific native tools, an SDK wrapper, an MCP
server, a persistent protocol adapter, or Agent-specific browser runtime.

## Bundle the Executable

Choose one release form and pin it in the product build:

- Bundle the native executable on Apple Silicon macOS, x64 Linux, or x64
  Windows.
- Or bundle `browser-pilot-cli` with a pinned Node.js 22 or newer runtime and
  invoke its `dist/cli.js` entry.

Verify the release index and checksums before packaging. Intel Mac is not
supported. Do not download or replace Browser Pilot during an Agent task.

Place the bundled command's directory first on the Agent command environment's
`PATH`, so both self-installed and product-bundled setups resolve the same
command:

```bash
command -v bp
bp --version
```

The skill and all browser workflows remain identical in both installation
modes. Do not teach the Agent a product-specific executable path.

## Inject Stable Environment

Set these variables in the Agent's command environment:

```text
BROWSER_PILOT_CLIENT_KEY=<stable product-installation and Agent identity>
BROWSER_PILOT_OUTPUT_DIR=<absolute task-owned output directory>
```

The client key must be:

- stable across all CLI calls and short-lived Agent processes that belong to
  one logical Agent;
- distinct between independent Agents that may run concurrently;
- free of secrets and unnecessary personal data;
- unchanged during retry recovery.

Create the output directory before the Agent starts and keep its lifecycle
under the host's normal task-file policy. Browser Pilot returns absolute file
paths for captures, PDFs, downloads, and saved network bodies. Let the Agent
use its existing file/image capability to consume them.

Do not set one static `BROWSER_PILOT_REQUEST_ID` for an entire task. Request IDs
identify one intended CLI operation. Let the Agent or command runner attach a
unique stable ID per operation when retry recovery is needed.

## Expose the Skill

Install or bundle the complete `browser-pilot` skill directory, including
`compatibility.json`, `agents/openai.yaml`, and `references/`. Let the Agent
discover it through the host's standard skill mechanism.

The host needs only:

- a normal command execution tool capable of invoking local executables;
- the Browser Pilot skill;
- the environment above;
- access to task-owned result files.

Do not map CLI commands into dozens of native Agent tools. The skill provides
progressive disclosure, while `bp --help` and `bp <command> --help` provide
runtime discovery without permanently consuming model context.

## Startup and Updates

Do not launch a long-lived Browser Pilot client process. The first relevant CLI
call starts or reuses the per-user background service. `bp connect` is the only
normal command that requests Chrome authorization.

At product startup, checking `bp --version` is sufficient. Run `bp status` only
when browser state is relevant; it may establish the Agent's logical state in
the already running service.

Pin the CLI version tested by the product release. The skill accepts the
declared compatible range, so a user-installed compatible CLI can still work.
On product upgrades, update the executable, skill, compatibility metadata, and
release checksums together.

Compatible installations reuse one per-user service through protocol
negotiation. A product-bundled CLI may release its own Agent state but cannot
stop a service started by another executable installation. Incompatible builds
must use a deliberately separate absolute `BROWSER_PILOT_HOME`; this is an
exception for migration or testing, not the default integration.

## Host Responsibilities

Browser Pilot exposes its full eligible browser control surface to the Agent.
It does not ask for per-action intent approval. Any product policy, approval UX,
or shell restriction belongs to the Agent host and must not change Browser
Pilot's CLI contract.

Keep user-opened tabs alive when an Agent ends. Use `bp close --all` only for
Browser Pilot-created tabs, and use `bp disconnect` only when intentionally
releasing that Agent's browser state.
