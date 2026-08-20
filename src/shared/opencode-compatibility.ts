// Bump this only when Varro starts relying on APIs from a newer OpenCode release.
// Keeping it explicit avoids forcing a CLI update for SDK-only patch releases.
export const MINIMUM_SUPPORTED_OPENCODE_VERSION = '1.16.0';

export const OPENCODE_SDK_PACKAGE_NAME = '@opencode-ai/sdk';

export function getMaximumTestedOpenCodeVersion<T>(packageJson: T): string {
  const packageRecord = asRecord(packageJson);
  if (!packageRecord) {
    throw new Error('Varro package.json is not an object');
  }

  const dependencies = asRecord(packageRecord.dependencies);
  if (!dependencies) {
    throw new Error('Varro package.json does not declare dependencies');
  }

  const declaredVersion = dependencies[OPENCODE_SDK_PACKAGE_NAME];
  if (!isString(declaredVersion)) {
    throw new Error(`Varro package.json does not declare ${OPENCODE_SDK_PACKAGE_NAME}`);
  }

  const version = declaredVersion.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) {
    throw new Error(`Invalid ${OPENCODE_SDK_PACKAGE_NAME} version: ${declaredVersion}`);
  }
  return version;
}

export function assertOpenCodeCompatibilityReportCurrent<PackageJson, Report>(
  packageJson: PackageJson,
  report: Report
): void {
  const ceiling = getMaximumTestedOpenCodeVersion(packageJson);
  const value = asRecord(report);
  if (!value) {
    throw new Error('OpenCode compatibility report is not an object');
  }

  if (value.declaredFloor !== MINIMUM_SUPPORTED_OPENCODE_VERSION) {
    throw new Error(
      `OpenCode compatibility report floor does not match ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
  }
  if (value.declaredCeiling !== ceiling) {
    throw new Error(`OpenCode compatibility report does not cover declared ceiling ${ceiling}`);
  }
  const results = Array.isArray(value.results) ? value.results : [];
  const floorResult = results.map(asRecord).find((result) => {
    if (!result) return false;
    return (
      result.requestedVersion === MINIMUM_SUPPORTED_OPENCODE_VERSION &&
      result.serverVersion === MINIMUM_SUPPORTED_OPENCODE_VERSION
    );
  });
  if (floorResult?.compatible !== true) {
    throw new Error(
      `OpenCode compatibility report does not pass declared floor ${MINIMUM_SUPPORTED_OPENCODE_VERSION}`
    );
  }

  const ceilingResult = results.map(asRecord).find((result) => {
    if (!result) return false;
    return result.requestedVersion === ceiling && result.serverVersion === ceiling;
  });
  if (ceilingResult?.compatible !== true) {
    throw new Error(`OpenCode compatibility report does not pass declared ceiling ${ceiling}`);
  }
}

export const OPENCODE_UPDATE_REQUIRED_PREFIX = 'OpenCode update required.';
import { asRecord, isString } from './type-utils';
