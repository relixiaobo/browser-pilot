# Integrating Browser Pilot in an Agent Host

Use one command path in any shell-capable Agent host:

```text
Agent -> Browser Pilot skill -> host shell/command runner -> bp CLI -> Chrome
```

Do not create Browser Pilot-specific native tools, an SDK wrapper, an MCP
server, a persistent protocol adapter, or Agent-specific browser runtime.

## Provide the Executable

Choose one provisioning mode without changing the skill workflow:

- **Managed skill:** install only the complete skill directory. The Agent runs
  the mandatory preflight in `SKILL.md` and installs the exact tested native
  CLI through its ordinary shell and approval flow when supported. npm is the
  fallback for platforms without a native release. The host does not need
  Browser Pilot-specific code or a bundled executable.
- **Pre-provisioned CLI:** place a compatible native executable or a pinned
  `browser-pilot-cli` installation on `PATH`. The npm form requires Node.js 22
  or newer. Native releases support Apple Silicon macOS, x64 Linux, and x64
  Windows; Intel Mac is unsupported.

The managed installer verifies the native archive checksum before extraction,
keeps the complete versioned release directory, and refuses to overwrite an
unmanaged command entry. For a pre-provisioned native executable, verify the
release index and checksums before packaging. For either mode, the Agent still
runs `bp --version` and refuses an incompatible CLI. Do not teach it a
host-specific executable path.

For a remotely managed skill installation, select the repository subdirectory
`plugin/skills/browser-pilot` and track the `skill-stable` branch. That branch
advances only after its exact tested CLI version and GitHub Release are public.
Do not track the development branch, where compatibility metadata can refer to
an unpublished CLI version.

Resolve the same command in both modes:

```bash
command -v bp
bp --version
```

The skill and all browser workflows remain identical in both modes.

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
under the host's normal task-file policy. While the variable is set, Browser
Pilot rejects output paths outside that directory. It returns absolute file
paths for captures, PDFs, downloads, and saved network bodies. Let the Agent use
its existing file/image capability to consume them.

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

In managed-skill mode, let the mandatory preflight reconcile skill and CLI
updates. The preflight accepts any installed version in the declared range but
installs the exact tested version when installation is needed; it never follows
a mutable `latest` target. In pre-provisioned mode, pin a version accepted by
the skill's declared range and update the executable when that range advances.

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
