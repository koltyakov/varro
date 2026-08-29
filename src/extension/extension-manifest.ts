import { readFileSync } from 'fs';
import { join } from 'path';
import { getMaximumTestedOpenCodeVersion } from '../shared/opencode-compatibility';

const maximumTestedVersionByManifestPath = new Map<string, string>();

export function readMaximumTestedOpenCodeVersion(
  packageJsonPath = join(__dirname, '..', '..', 'package.json')
) {
  const cached = maximumTestedVersionByManifestPath.get(packageJsonPath);
  if (cached) return cached;
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = getMaximumTestedOpenCodeVersion(packageJson);
  maximumTestedVersionByManifestPath.set(packageJsonPath, version);
  return version;
}
