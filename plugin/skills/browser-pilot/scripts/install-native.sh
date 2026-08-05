#!/bin/sh

set -eu
set -f

UNSUPPORTED_PLATFORM_EXIT_CODE=10

version=''
repository=''
asset_directory=''
install_root=${BROWSER_PILOT_INSTALL_ROOT:-}
bin_directory=${BROWSER_PILOT_BIN_DIR:-}
temporary_directory=''
staging_directory=''
temporary_link=''

usage() {
  printf '%s\n' \
    'Usage: sh install-native.sh --version <version> --repository <owner/repo>' \
    '       [--asset-directory <path>] [--install-root <path>] [--bin-dir <path>]'
}

fail() {
  code=$1
  shift
  printf 'code=%s\nmessage=%s\n' "$code" "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$temporary_link" ] && { [ -e "$temporary_link" ] || [ -L "$temporary_link" ]; }; then
    rm -f -- "$temporary_link"
  fi
  if [ -n "$staging_directory" ] && [ -d "$staging_directory" ]; then
    rm -rf -- "$staging_directory"
  fi
  if [ -n "$temporary_directory" ] && [ -d "$temporary_directory" ]; then
    rm -rf -- "$temporary_directory"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      version=$2
      shift 2
      ;;
    --repository)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      repository=$2
      shift 2
      ;;
    --asset-directory)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      asset_directory=$2
      shift 2
      ;;
    --install-root)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      install_root=$2
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      bin_directory=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail invalid_argument "Unknown argument: $1"
      ;;
  esac
done

[ -n "$version" ] || { usage >&2; fail invalid_argument '--version is required'; }
[ -n "$repository" ] || { usage >&2; fail invalid_argument '--repository is required'; }
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
  fail invalid_version "Invalid release version: $version"
printf '%s\n' "$repository" | grep -Eq '^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$' ||
  fail invalid_repository "Invalid GitHub repository: $repository"

system_name=$(uname -s 2>/dev/null || true)
machine_name=$(uname -m 2>/dev/null || true)
platform=''
architecture=''
archive_extension=''

case "$system_name" in
  Darwin)
    if [ "$machine_name" = 'arm64' ]; then
      platform='darwin'
      architecture='arm64'
      archive_extension='zip'
    elif [ "$machine_name" = 'x86_64' ] &&
      [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = '1' ]; then
      platform='darwin'
      architecture='arm64'
      archive_extension='zip'
    fi
    ;;
  Linux)
    case "$machine_name" in
      x86_64|amd64)
        platform='linux'
        architecture='x64'
        archive_extension='tar.gz'
        ;;
    esac
    ;;
esac

if [ -z "$platform" ]; then
  printf 'code=unsupported_platform\nplatform=%s\narchitecture=%s\n' \
    "$system_name" "$machine_name" >&2
  exit "$UNSUPPORTED_PLATFORM_EXIT_CODE"
fi

if [ -z "$install_root" ]; then
  [ -n "${HOME:-}" ] || fail missing_home 'HOME is required unless --install-root is provided'
  install_root=${XDG_DATA_HOME:-"$HOME/.local/share"}/browser-pilot
fi

path_contains() {
  candidate=$1
  case ":${PATH:-}:" in
    *":$candidate:"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "$bin_directory" ]; then
  [ -n "${HOME:-}" ] || fail missing_home 'HOME is required unless --bin-dir is provided'
  if path_contains "$HOME/.local/bin"; then
    bin_directory=$HOME/.local/bin
  elif path_contains "$HOME/bin"; then
    bin_directory=$HOME/bin
  else
    bin_directory=$HOME/.local/bin
  fi
fi

case "$install_root" in
  /*) ;;
  *) fail invalid_install_path "Installation root must be absolute: $install_root" ;;
esac
[ "$install_root" != '/' ] || fail invalid_install_path 'Installation root cannot be the filesystem root'
case "$bin_directory" in
  /*) ;;
  *) fail invalid_install_path "Command directory must be absolute: $bin_directory" ;;
esac
[ "$bin_directory" != '/' ] || fail invalid_install_path 'Command directory cannot be the filesystem root'
if [ -n "$asset_directory" ]; then
  case "$asset_directory" in
    /*) ;;
    *) fail invalid_install_path "Asset directory must be absolute: $asset_directory" ;;
  esac
fi

archive_name="browser-pilot-$version-$platform-$architecture.$archive_extension"
archive_root="browser-pilot-$version-$platform-$architecture"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/browser-pilot-install.XXXXXX") ||
  fail temporary_directory_failed 'Could not create a temporary directory'

if [ -n "$asset_directory" ]; then
  [ -d "$asset_directory" ] || fail asset_directory_missing "Asset directory does not exist: $asset_directory"
  archive_path=$asset_directory/$archive_name
  checksum_path=$asset_directory/$archive_name.sha256
else
  archive_path=$temporary_directory/$archive_name
  checksum_path=$temporary_directory/$archive_name.sha256
  release_url="https://github.com/$repository/releases/download/v$version"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --output "$archive_path" "$release_url/$archive_name" ||
      fail download_failed "Could not download $archive_name"
    curl -fsSL --retry 2 --output "$checksum_path" "$release_url/$archive_name.sha256" ||
      fail download_failed "Could not download $archive_name.sha256"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$archive_path" "$release_url/$archive_name" ||
      fail download_failed "Could not download $archive_name"
    wget -q -O "$checksum_path" "$release_url/$archive_name.sha256" ||
      fail download_failed "Could not download $archive_name.sha256"
  else
    fail downloader_missing 'curl or wget is required to download the native release'
  fi
fi

[ -f "$archive_path" ] || fail archive_missing "Release archive is missing: $archive_path"
[ -f "$checksum_path" ] || fail checksum_missing "Checksum sidecar is missing: $checksum_path"

checksum_line=$(sed -n '1p' "$checksum_path")
set -- $checksum_line
[ "$#" -eq 2 ] || fail invalid_checksum "Invalid checksum sidecar: $checksum_path"
expected_checksum=$1
checksum_file_name=$2
printf '%s\n' "$expected_checksum" | grep -Eq '^[0-9a-fA-F]{64}$' ||
  fail invalid_checksum "Invalid SHA-256 value in $checksum_path"
[ "$checksum_file_name" = "$archive_name" ] ||
  fail invalid_checksum "Checksum sidecar names $checksum_file_name instead of $archive_name"

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum=$(sha256sum "$archive_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum=$(shasum -a 256 "$archive_path" | awk '{print $1}')
else
  fail checksum_tool_missing 'sha256sum or shasum is required to verify the native release'
fi

[ "$actual_checksum" = "$expected_checksum" ] ||
  fail checksum_mismatch "SHA-256 verification failed for $archive_name"

archive_listing=$temporary_directory/archive-list.txt
case "$archive_extension" in
  zip)
    command -v unzip >/dev/null 2>&1 || fail extractor_missing 'unzip is required to extract the native release'
    unzip -Z1 "$archive_path" > "$archive_listing" ||
      fail invalid_archive "Could not inspect $archive_name"
    ;;
  tar.gz)
    command -v tar >/dev/null 2>&1 || fail extractor_missing 'tar is required to extract the native release'
    tar -tzf "$archive_path" > "$archive_listing" ||
      fail invalid_archive "Could not inspect $archive_name"
    ;;
esac

[ -s "$archive_listing" ] || fail invalid_archive "Archive is empty: $archive_name"
while IFS= read -r archive_entry || [ -n "$archive_entry" ]; do
  case "$archive_entry" in
    "$archive_root"|"$archive_root"/*) ;;
    *) fail invalid_archive "Archive entry is outside $archive_root: $archive_entry" ;;
  esac
  case "/$archive_entry/" in
    *'/../'*|*'/./'*) fail invalid_archive "Archive entry is unsafe: $archive_entry" ;;
  esac
done < "$archive_listing"

case "$archive_extension" in
  zip)
    unzip -q "$archive_path" -d "$temporary_directory/extracted" ||
      fail extraction_failed "Could not extract $archive_name"
    ;;
  tar.gz)
    mkdir -p "$temporary_directory/extracted"
    tar -xzf "$archive_path" -C "$temporary_directory/extracted" ||
      fail extraction_failed "Could not extract $archive_name"
    ;;
esac

source_directory=$temporary_directory/extracted/$archive_root
source_executable=$source_directory/browser-pilot
[ -d "$source_directory" ] || fail invalid_archive "Archive root is missing: $archive_root"
[ -f "$source_executable" ] && [ ! -L "$source_executable" ] ||
  fail invalid_archive 'Archive does not contain a regular browser-pilot executable'
if find "$source_directory" -type l -print -quit | grep -q .; then
  fail invalid_archive 'Archive contains an unexpected symbolic link'
fi

versions_directory=$install_root/versions
target_directory=$versions_directory/$version-$platform-$architecture
mkdir -p "$versions_directory" "$bin_directory" ||
  fail install_directory_failed 'Could not create the installation directories'

is_owned_link() {
  link_path=$1
  if [ ! -e "$link_path" ] && [ ! -L "$link_path" ]; then
    return 0
  fi
  [ -L "$link_path" ] || return 1
  link_target=$(readlink "$link_path") || return 1
  case "$link_target" in
    "$install_root"/versions/*/browser-pilot) return 0 ;;
    *) return 1 ;;
  esac
}

for command_name in bp browser-pilot; do
  link_path=$bin_directory/$command_name
  is_owned_link "$link_path" ||
    fail command_conflict "Refusing to replace an unmanaged command: $link_path"
done

if [ -e "$target_directory" ]; then
  [ -d "$target_directory" ] && [ -f "$target_directory/browser-pilot" ] ||
    fail install_conflict "Existing version path is not a valid installation: $target_directory"
else
  staging_directory=$versions_directory/.install-$version-$platform-$architecture.$$
  [ ! -e "$staging_directory" ] || fail install_conflict "Staging path already exists: $staging_directory"
  cp -R "$source_directory" "$staging_directory" ||
    fail install_failed "Could not stage Browser Pilot in $versions_directory"
  chmod u+x "$staging_directory/browser-pilot" ||
    fail install_failed 'Could not make the Browser Pilot executable runnable'
  mv "$staging_directory" "$target_directory" ||
    fail install_failed "Could not install Browser Pilot in $target_directory"
  staging_directory=''
fi

install_link() {
  command_name=$1
  link_path=$bin_directory/$command_name
  is_owned_link "$link_path" ||
    fail command_conflict "Refusing to replace an unmanaged command: $link_path"
  temporary_link=$bin_directory/.$command_name.$$.tmp
  [ ! -e "$temporary_link" ] && [ ! -L "$temporary_link" ] ||
    fail command_conflict "Temporary command path already exists: $temporary_link"
  ln -s "$target_directory/browser-pilot" "$temporary_link" ||
    fail install_failed "Could not create $command_name command"
  mv -f "$temporary_link" "$link_path" ||
    fail install_failed "Could not activate $command_name command"
  temporary_link=''
}

install_link bp
install_link browser-pilot

if path_contains "$bin_directory"; then
  path_ready=true
else
  path_ready=false
fi

printf 'ok=true\nchannel=native\nversion=%s\ncommand=%s\nbin_directory=%s\npath_ready=%s\n' \
  "$version" "$target_directory/browser-pilot" "$bin_directory" "$path_ready"
