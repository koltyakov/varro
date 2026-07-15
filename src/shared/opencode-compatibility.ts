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

export const OPENCODE_UPDATE_REQUIRED_PREFIX = 'OpenCode update required.';
