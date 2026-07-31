# Universal Agent CLI Integration Plan

Status: implemented and published through v0.5.1. This plan is retained as the
historical design record for the CLI-only architecture.

## Goal

Allow any shell-capable Agent to control the user's eligible Chrome tabs by
installing the Browser Pilot skill and invoking the same `bp` CLI, whether the
CLI was installed by the Agent or bundled by an Agent product.

```text
Agent -> skill -> existing shell tool -> bp CLI -> shared Broker -> Chrome
```

The integration must not require an extension, MCP, Native SDK, native Browser
Pilot tools, a persistent adapter, or Agent-specific runtime code.

## Decisions

- [x] Keep one public Agent interface: skill plus CLI.
- [x] Keep the Broker and CDP transport private.
- [x] Use stable `BROWSER_PILOT_CLIENT_KEY` values for independent Agents.
- [x] Preserve logical Agent state across short-lived CLI calls.
- [x] Expose all eligible managed and user-opened tabs.
- [x] Keep user tabs open during release and crash cleanup.
- [x] Leave task-intent permission policy to the Agent host.
- [x] Support product bundling by putting a pinned CLI on the Agent `PATH`.
- [x] Support Apple Silicon macOS, x64 Linux, and x64 Windows only.

## Workstream A: CLI Contract

- [x] Provide stable JSON success and error results.
- [x] Add stable error codes to parser, input, service, and browser failures.
- [x] Make `--client-key` discoverable in top-level help.
- [x] Add `bp status` with service, browser, selected state, command state, and
  structured recovery.
- [x] Add bounded `bp commands`, `bp command`, and `bp cancel` commands.
- [x] Add global `--request-id` and deterministic idempotent recovery.
- [x] Add global `--timeout` and best-effort cancellation on process signals.
- [x] Add browser-visible `bp wait` conditions.
- [x] Add download list/export commands.
- [x] Add `BROWSER_PILOT_OUTPUT_DIR` and structured file metadata.
- [x] Keep `bp --help` as the canonical runtime command inventory.

## Workstream B: Shared State and Concurrency

- [x] Replace global active-tab/ref files with Broker-owned keyed state.
- [x] Isolate selected profile, target, frame, refs, auth, network rules,
  downloads, and commands by Agent key.
- [x] Serialize commands per physical tab and allow independent tabs to run in
  parallel.
- [x] Enforce one controlling Agent per physical user tab.
- [x] Return stable `target_busy` rather than stealing control.
- [x] Reclaim expired state and managed targets.
- [x] Preserve user tabs on Agent release and crash cleanup.
- [x] Invalidate browser-generation-scoped state after reconnect.

## Workstream C: Cross-Installation Broker Reuse

- [x] Negotiate compatibility by protocol rather than executable path.
- [x] Allow compatible global and product-bundled CLIs to share one Broker.
- [x] Keep one stable Agent principal across compatible CLI versions.
- [x] Use separate internal client sessions when compatible versions differ.
- [x] Let `bp disconnect` release the invoking Agent's namespace from any
  compatible installation.
- [x] Require exact executable identity only for whole-Broker shutdown.
- [x] Refuse incompatible protocol clients without replacing the live Broker.
- [x] Support explicit incompatible isolation through `BROWSER_PILOT_HOME`.

## Workstream D: Product Embedding

- [x] Document one generic integration for Tenon, OpenClaw, and other Agents.
- [x] Require the complete skill and a normal command runner.
- [x] Require a pinned native CLI or npm CLI plus pinned Node runtime.
- [x] Put the bundled CLI directory on the Agent command environment's `PATH`.
- [x] Inject a stable client key per logical Agent.
- [x] Inject a task-owned absolute output directory.
- [x] Return files by absolute path for the host's existing image/file tools.
- [x] Avoid command-to-native-tool mapping and permanent tool-schema context.
- [x] Keep Agent-managed and bundled installs on the same behavior path.

## Workstream E: Skill and Documentation

- [x] Keep the main skill focused on the browser operating loop.
- [x] Split command, recovery, async, and embedding details into on-demand
  references.
- [x] Remove internal state IDs and transport concepts from Agent guidance.
- [x] Document all eligible user tabs and explicit user-tab close behavior.
- [x] Document Chrome profile identity and routing.
- [x] Document tab-group control limitations without limiting grouped tabs.
- [x] Document local screenshot, PDF, download, and network-body results.
- [x] Document stable request recovery and uncertain mutation rules.

## Workstream F: Distribution

- [x] Keep CLI, plugin, skill compatibility, and marketplace versions synced
  from the root package version.
- [x] Publish a release index binding CLI, skill range, protocol, platforms,
  checksums, and tested version.
- [x] Exclude Intel Mac assets.
- [x] Verify global, local, and product-bundled npm use.
- [x] Verify native archives do not need system Node.
- [x] Bump the next release version and produce local release artifacts.
- [x] Publish the npm package, plugin archive, native archives, checksums, and
  release index.

## Acceptance Criteria

- [x] An Agent can install Browser Pilot itself and follow the skill.
- [x] A product can bundle Browser Pilot without adding native browser tools.
- [x] Two Agent products can share one Broker with isolated state.
- [x] A compatible bundled CLI can use a Broker started by a global CLI.
- [x] A compatible non-owner CLI can disconnect cleanly without stopping that
  Broker.
- [x] Every eligible user-opened tab can be selected and controlled.
- [x] The same physical tab cannot be controlled by two Agents concurrently.
- [x] Browser authorization is requested only by explicit connection.
- [x] Stable request IDs prevent duplicate dispatch during recovery.
- [x] Screenshots, PDFs, downloads, and saved bodies are available as local
  files with structured metadata.
- [x] Removed persistent adapter commands are absent from CLI help and release
  packages.
- [x] Full unit, Playwright, distribution, standalone, and controlled real
  Chrome release gates pass for the new version.
