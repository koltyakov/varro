// Bump this only when Varro starts relying on APIs from a newer OpenCode release.
// Keeping it explicit avoids forcing a CLI update for SDK-only patch releases.
export const MINIMUM_SUPPORTED_OPENCODE_VERSION = '1.16.0';

export const OPENCODE_SDK_PACKAGE_NAME = '@opencode-ai/sdk';

export function getMaximumTestedOpenCodeVersion(packageJson: unknown): string {
  if (!packageJson || typeof packageJson !== 'object') {
    throw new Error('Varro package.json is not an object');
  }

  const dependencies = (packageJson as { dependencies?: unknown }).dependencies;
  if (!dependencies || typeof dependencies !== 'object') {
    throw new Error('Varro package.json does not declare dependencies');
  }

  const declaredVersion = (dependencies as Record<string, unknown>)[OPENCODE_SDK_PACKAGE_NAME];
  if (typeof declaredVersion !== 'string') {
    throw new Error(`Varro package.json does not declare ${OPENCODE_SDK_PACKAGE_NAME}`);
  }

  const version = declaredVersion.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) {
    throw new Error(`Invalid ${OPENCODE_SDK_PACKAGE_NAME} version: ${declaredVersion}`);
  }
  return version;
}

export function assertOpenCodeCompatibilityReportCurrent(
  packageJson: unknown,
  report: unknown
): void {
  const ceiling = getMaximumTestedOpenCodeVersion(packageJson);
  if (!report || typeof report !== 'object') {
    throw new Error('OpenCode compatibility report is not an object');
  }

  const value = report as Record<string, unknown>;
  if (value.declaredFloor !== MINIMUM_SUPPORTED_OPENCODE_VERSION) {
    throw new Error(
      `OpenCode compatibility report floor does not match ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
  }
  if (value.declaredCeiling !== ceiling) {
    throw new Error(`OpenCode compatibility report does not cover declared ceiling ${ceiling}`);
  }
  const results = Array.isArray(value.results) ? value.results : [];
  const floorResult = results.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const result = entry as Record<string, unknown>;
    return (
      result.requestedVersion === MINIMUM_SUPPORTED_OPENCODE_VERSION &&
      result.serverVersion === MINIMUM_SUPPORTED_OPENCODE_VERSION
    );
  }) as Record<string, unknown> | undefined;
  if (floorResult?.compatible !== true) {
    throw new Error(
      `OpenCode compatibility report does not pass declared floor ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
  }

  const ceilingResult = results.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const result = entry as Record<string, unknown>;
    return result.requestedVersion === ceiling && result.serverVersion === ceiling;
  }) as Record<string, unknown> | undefined;
  if (ceilingResult?.compatible !== true) {
    throw new Error(`OpenCode compatibility report does not pass declared ceiling ${ceiling}`);
  }
}

export const OPENCODE_UPDATE_REQUIRED_PREFIX = 'OpenCode update required.';
