const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const BROWSER_PILOT_REPOSITORY = 'relixiaobo/browser-pilot';
export const NATIVE_INSTALL_UNSUPPORTED_EXIT_CODE = 10;

export function releaseVersionMetadata(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`package version must be semver, received ${JSON.stringify(version)}`);

  const nextMajor = Number(match[1]) + 1;
  const minimumVersion = version.split('+', 1)[0];
  const maximumVersionExclusive = `${nextMajor}.0.0`;
  return {
    minimumVersion,
    maximumVersionExclusive,
    supportedVersionRange: `>=${minimumVersion} <${maximumVersionExclusive}`,
  };
}

export function browserPilotCliMetadata(packageManifest) {
  const version = packageManifest.version;
  const requiredNodeVersion = packageManifest.engines?.node;
  if (typeof requiredNodeVersion !== 'string') {
    throw new Error('package.json engines.node is required');
  }

  return {
    testedVersion: version,
    ...releaseVersionMetadata(version),
    installation: {
      strategy: 'native-first',
      native: {
        repository: BROWSER_PILOT_REPOSITORY,
        version,
        installers: {
          posix: 'scripts/install-native.sh',
          windows: 'scripts/install-native.ps1',
        },
        unsupportedPlatformExitCode: NATIVE_INSTALL_UNSUPPORTED_EXIT_CODE,
      },
      npmFallback: {
        requiredNodeVersion,
        installCommand: `npm install --global browser-pilot-cli@${version}`,
      },
    },
  };
}
