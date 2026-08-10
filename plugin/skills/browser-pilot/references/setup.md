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

## Upgrading while the service is running

Installing a newer executable does not upgrade a running service. The service is
a separate process started by, and owned by, the executable that launched it, so
`bp --version` can report the new version while `bp status` still reports the
old one under `service.version`. Browser work keeps using the old service until
it stops.

`bp disconnect` stops a service **only when its own executable owns it**: the
requesting executable's version and identity must match the service's. A newly
installed executable therefore cannot stop the service its predecessor started,
and reports success after releasing state without stopping anything. That is
deliberate — one installation must not terminate another's service.

Disconnect first, with the executable that matches `service.version`:

1. Read `service.version` from `bp status`.
2. Run `disconnect` using that version's executable, not the one on `PATH`.
   A native installation keeps every version it has installed, so the previous
   one is still present. Directories are named `<version>-<platform>-<arch>`,
   as in `0.7.1-darwin-arm64`:

   ```text
   POSIX:   ${XDG_DATA_HOME:-~/.local/share}/browser-pilot/versions/<version>-<platform>-<arch>/browser-pilot disconnect
   Windows: %LOCALAPPDATA%\BrowserPilot\versions\<version>-<platform>-<arch>\browser-pilot.exe disconnect
   ```

   An npm installation has one copy rather than per-version directories, so the
   matching executable exists only until the package is upgraded; disconnect
   before upgrading it.

3. Install the new version, then run `bp status` and confirm `service.version`
   matches `bp --version` after the next connect.

Do not terminate the service process to work around a refused disconnect. The
refusal is the ownership check doing its job, and signalling the process bypasses
it.

## Provenance and platforms

Do not assume the Agent host installs Browser Pilot. A compatible executable
already on `PATH` may be used regardless of whether a user, the Agent, or the
host provided it.

Native releases cover Apple Silicon macOS, x64 Linux, and x64 Windows. Intel
Mac has no native release and requires the npm distribution with Node.js 22 or
newer.
