const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
