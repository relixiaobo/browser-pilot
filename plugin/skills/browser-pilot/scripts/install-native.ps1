[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$')]
  [string]$Repository,

  [string]$AssetDirectory,
  [string]$InstallRoot = $env:BROWSER_PILOT_INSTALL_ROOT,
  [string]$BinDirectory = $env:BROWSER_PILOT_BIN_DIR
)

$ErrorActionPreference = 'Stop'
$UnsupportedPlatformExitCode = 10
$TemporaryDirectory = $null
$StagingDirectory = $null

function Stop-Install {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    [int]$ExitCode = 1
  )

  [Console]::Error.WriteLine("code=$Code")
  [Console]::Error.WriteLine("message=$Message")
  exit $ExitCode
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Test-PathEntry {
  param([Parameter(Mandatory = $true)][string]$Candidate)

  $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  foreach ($entry in ($env:Path -split ';')) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    try {
      $entryPath = [IO.Path]::GetFullPath($entry).TrimEnd('\')
    } catch {
      continue
    }
    if ($entryPath.Equals($candidatePath, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Test-OwnedShim {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $content = [IO.File]::ReadAllText($Path)
  return $content.StartsWith('@rem Browser Pilot managed shim') -and
    $content.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-ShimAvailable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Directory
  )

  foreach ($extension in @('', '.exe', '.bat', '.ps1')) {
    $conflict = Join-Path $Directory "$Name$extension"
    if (Test-Path -LiteralPath $conflict) {
      Stop-Install 'command_conflict' "Refusing to replace an unmanaged command: $conflict"
    }
  }

  $shim = Join-Path $Directory "$Name.cmd"
  if (-not (Test-OwnedShim -Path $shim -Root $Root)) {
    Stop-Install 'command_conflict' "Refusing to replace an unmanaged command: $shim"
  }
}

function Install-Shim {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Directory
  )

  $shim = Join-Path $Directory "$Name.cmd"
  $temporaryShim = Join-Path $Directory ".$Name.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $content = "@rem Browser Pilot managed shim`r`n@echo off`r`n`"$Executable`" %*`r`n"
  [IO.File]::WriteAllText($temporaryShim, $content, [Text.Encoding]::Default)
  Move-Item -LiteralPath $temporaryShim -Destination $shim -Force
}

try {
  $isWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
  $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if (-not $isWindows -or $architecture -ne 'X64') {
    [Console]::Error.WriteLine('code=unsupported_platform')
    [Console]::Error.WriteLine("platform=$([Environment]::OSVersion.Platform)")
    [Console]::Error.WriteLine("architecture=$architecture")
    exit $UnsupportedPlatformExitCode
  }

  if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      Stop-Install 'missing_local_app_data' 'LOCALAPPDATA is required unless -InstallRoot is provided'
    }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'BrowserPilot'
  }

  if ([string]::IsNullOrWhiteSpace($BinDirectory)) {
    $defaultBin = Join-Path $InstallRoot 'bin'
    $localBin = if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
      $null
    } else {
      Join-Path $env:USERPROFILE '.local\bin'
    }
    if ($localBin -and (Test-PathEntry -Candidate $localBin)) {
      $BinDirectory = $localBin
    } else {
      $BinDirectory = $defaultBin
    }
  }

  foreach ($pathValue in @(
    @{ Name = 'Installation root'; Value = $InstallRoot },
    @{ Name = 'Command directory'; Value = $BinDirectory }
  )) {
    if (-not [IO.Path]::IsPathRooted($pathValue.Value)) {
      Stop-Install 'invalid_install_path' "$($pathValue.Name) must be absolute: $($pathValue.Value)"
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($AssetDirectory) -and
      -not [IO.Path]::IsPathRooted($AssetDirectory)) {
    Stop-Install 'invalid_install_path' "Asset directory must be absolute: $AssetDirectory"
  }
  $installRootFull = [IO.Path]::GetFullPath($InstallRoot)
  $binDirectoryFull = [IO.Path]::GetFullPath($BinDirectory)
  if ($installRootFull.TrimEnd('\') -eq [IO.Path]::GetPathRoot($installRootFull).TrimEnd('\')) {
    Stop-Install 'invalid_install_path' 'Installation root cannot be a filesystem root'
  }
  if ($binDirectoryFull.TrimEnd('\') -eq [IO.Path]::GetPathRoot($binDirectoryFull).TrimEnd('\')) {
    Stop-Install 'invalid_install_path' 'Command directory cannot be a filesystem root'
  }
  $InstallRoot = $installRootFull.TrimEnd('\')
  $BinDirectory = $binDirectoryFull.TrimEnd('\')
  if ($InstallRoot.Contains('%')) {
    Stop-Install 'invalid_install_path' 'Windows command shims do not support percent signs in the installation path'
  }
  if (-not [string]::IsNullOrWhiteSpace($AssetDirectory)) {
    $AssetDirectory = [IO.Path]::GetFullPath($AssetDirectory).TrimEnd('\')
  }

  $archiveName = "browser-pilot-$Version-win32-x64.zip"
  $archiveRoot = "browser-pilot-$Version-win32-x64"
  $TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "browser-pilot-install-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $TemporaryDirectory | Out-Null

  if ([string]::IsNullOrWhiteSpace($AssetDirectory)) {
    $archivePath = Join-Path $TemporaryDirectory $archiveName
    $checksumPath = "$archivePath.sha256"
    $releaseUrl = "https://github.com/$Repository/releases/download/v$Version"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archiveName" -OutFile $archivePath
      Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archiveName.sha256" -OutFile $checksumPath
    } catch {
      Stop-Install 'download_failed' "Could not download the native release: $($_.Exception.Message)"
    }
  } else {
    if (-not (Test-Path -LiteralPath $AssetDirectory -PathType Container)) {
      Stop-Install 'asset_directory_missing' "Asset directory does not exist: $AssetDirectory"
    }
    $archivePath = Join-Path $AssetDirectory $archiveName
    $checksumPath = "$archivePath.sha256"
  }

  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    Stop-Install 'archive_missing' "Release archive is missing: $archivePath"
  }
  if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    Stop-Install 'checksum_missing' "Checksum sidecar is missing: $checksumPath"
  }

  $checksumParts = ([IO.File]::ReadAllText($checksumPath).Trim() -split '\s+', 2)
  if ($checksumParts.Count -ne 2 -or $checksumParts[0] -notmatch '^[0-9a-fA-F]{64}$') {
    Stop-Install 'invalid_checksum' "Invalid checksum sidecar: $checksumPath"
  }
  if ($checksumParts[1] -ne $archiveName) {
    Stop-Install 'invalid_checksum' "Checksum sidecar names $($checksumParts[1]) instead of $archiveName"
  }
  $actualChecksum = Get-FileSha256 -Path $archivePath
  if (-not $actualChecksum.Equals($checksumParts[0], [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Install 'checksum_mismatch' "SHA-256 verification failed for $archiveName"
  }

  $extractionDirectory = Join-Path $TemporaryDirectory 'extracted'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $extractionPrefix = [IO.Path]::GetFullPath($extractionDirectory).TrimEnd('\') + '\'
    foreach ($entry in $zipArchive.Entries) {
      $entryName = $entry.FullName.Replace('\', '/')
      if ($entryName -ne $archiveRoot -and -not $entryName.StartsWith("$archiveRoot/")) {
        Stop-Install 'invalid_archive' "Archive entry is outside ${archiveRoot}: $entryName"
      }
      $destination = [IO.Path]::GetFullPath((Join-Path $extractionDirectory $entryName))
      if (-not $destination.StartsWith($extractionPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Install 'invalid_archive' "Archive entry is unsafe: $entryName"
      }
    }
  } finally {
    $zipArchive.Dispose()
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractionDirectory
  $sourceDirectory = Join-Path $extractionDirectory $archiveRoot
  $sourceExecutable = Join-Path $sourceDirectory 'browser-pilot.exe'
  if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container) -or
      -not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
    Stop-Install 'invalid_archive' "Archive does not contain $archiveRoot\browser-pilot.exe"
  }
  $reparsePoint = Get-ChildItem -LiteralPath $sourceDirectory -Recurse -Force |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
    Select-Object -First 1
  if ($reparsePoint) {
    Stop-Install 'invalid_archive' "Archive contains an unexpected reparse point: $($reparsePoint.FullName)"
  }

  $versionsDirectory = Join-Path $InstallRoot 'versions'
  $targetDirectory = Join-Path $versionsDirectory "$Version-win32-x64"
  New-Item -ItemType Directory -Path $versionsDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $BinDirectory -Force | Out-Null
  Assert-ShimAvailable -Name 'bp' -Root $InstallRoot -Directory $BinDirectory
  Assert-ShimAvailable -Name 'browser-pilot' -Root $InstallRoot -Directory $BinDirectory

  if (Test-Path -LiteralPath $targetDirectory) {
    $targetExecutable = Join-Path $targetDirectory 'browser-pilot.exe'
    if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container) -or
        -not (Test-Path -LiteralPath $targetExecutable -PathType Leaf)) {
      Stop-Install 'install_conflict' "Existing version path is not a valid installation: $targetDirectory"
    }
  } else {
    $StagingDirectory = Join-Path $versionsDirectory ".install-$Version-win32-x64-$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $sourceDirectory -Destination $StagingDirectory -Recurse
    Move-Item -LiteralPath $StagingDirectory -Destination $targetDirectory
    $StagingDirectory = $null
    $targetExecutable = Join-Path $targetDirectory 'browser-pilot.exe'
  }

  Install-Shim -Name 'bp' -Executable $targetExecutable -Root $InstallRoot -Directory $BinDirectory
  Install-Shim -Name 'browser-pilot' -Executable $targetExecutable -Root $InstallRoot -Directory $BinDirectory

  $pathReady = (Test-PathEntry -Candidate $BinDirectory).ToString().ToLowerInvariant()
  [Console]::Out.WriteLine('ok=true')
  [Console]::Out.WriteLine('channel=native')
  [Console]::Out.WriteLine("version=$Version")
  [Console]::Out.WriteLine("command=$targetExecutable")
  [Console]::Out.WriteLine("bin_directory=$BinDirectory")
  [Console]::Out.WriteLine("path_ready=$pathReady")
} catch {
  Stop-Install 'install_failed' $_.Exception.Message
} finally {
  if ($StagingDirectory -and (Test-Path -LiteralPath $StagingDirectory)) {
    Remove-Item -LiteralPath $StagingDirectory -Recurse -Force
  }
  if ($TemporaryDirectory -and (Test-Path -LiteralPath $TemporaryDirectory)) {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
  }
}
