import { readFileSync } from 'fs';
import { join } from 'path';
import { getMaximumTestedOpenCodeVersion } from '../shared/opencode-compatibility';

const maximumTestedVersionByManifestPath = new Map<string, string>();

export function readMaximumTestedOpenCodeVersion(
  packageJsonPath = join(__dirname, '..', '..', 'package.json'),
  apiVersion: 1 | 2 = 1
) {
  const cacheKey = `${packageJsonPath}:${apiVersion}`;
  const cached = maximumTestedVersionByManifestPath.get(cacheKey);
  if (cached) return cached;
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = getMaximumTestedOpenCodeVersion(packageJson, apiVersion);
  maximumTestedVersionByManifestPath.set(cacheKey, version);
  return version;
}
