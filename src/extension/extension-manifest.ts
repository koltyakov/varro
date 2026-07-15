import { readFileSync } from 'fs';
import { join } from 'path';
import { getMaximumTestedOpenCodeVersion } from '../shared/opencode-compatibility';

export function readMaximumTestedOpenCodeVersion(
  packageJsonPath = join(__dirname, '..', '..', 'package.json')
) {
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return getMaximumTestedOpenCodeVersion(packageJson);
}
