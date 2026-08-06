# Setup: Resolving and Installing the CLI

Read this only when `bp` is missing, when `bp --version` reports a version
outside `compatibility.json`'s `browserPilotCli.supportedVersionRange`, or when
the user asks how Browser Pilot is installed. A working `bp` inside the
supported range needs nothing from this file.

## Resolve the executable

Check the resolved command with the current shell (`command -v bp` on POSIX or
`Get-Command bp` on PowerShell), then check the version:

```bash
bp --version
```

Continue only when the reported semantic version is inside
`browserPilotCli.supportedVersionRange`, whose lower bound is the required
minimum version.

## Install or repair

1. Read `browserPilotCli.installation`. Use its exact native version and
   repository; never substitute GitHub `latest` or npm `@latest`.
2. Invoke the installer path declared for the current shell, resolved relative
   to `SKILL.md`, through the Agent's normal shell approval flow:

   ```text
   POSIX: sh <posixInstaller> --version <native.version> --repository <native.repository>
   Windows: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <windowsInstaller> -Version <native.version> -Repository <native.repository>
   ```

3. Fall back to npm only when the native installer exits with the exact
   `native.unsupportedPlatformExitCode`. Check `node --version` and
   `npm --version`, require `npmFallback.requiredNodeVersion`, then run the
   exact `npmFallback.installCommand`. Do not fall back after a download,
   checksum, extraction, command-conflict, or filesystem failure.
4. Resolve `bp` again and re-check `bp --version` against the supported range.
   If the installer reports `path_ready=false`, or another command still wins
   on `PATH`, stop and report the returned `bin_directory`; do not edit shell
   startup files or the system `PATH` silently.

## Provenance and platforms

Do not assume the Agent host installs Browser Pilot. A compatible executable
already on `PATH` may be used regardless of whether a user, the Agent, or the
host provided it.

Native releases cover Apple Silicon macOS, x64 Linux, and x64 Windows. Intel
Mac has no native release and requires the npm distribution with Node.js 22 or
newer.
