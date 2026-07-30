import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import {
  assertOpenCodeCompatibilityReportCurrent,
  getMaximumTestedOpenCodeVersion,
} from './opencode-compatibility';

describe('getMaximumTestedOpenCodeVersion', () => {
  it('reads the exact version from the SDK dependency range', () => {
    expect(
      getMaximumTestedOpenCodeVersion({
        dependencies: { '@opencode-ai/sdk': '^1.18.1' },
      })
    ).toBe('1.18.1');
  });

  it('rejects a manifest without a valid SDK version', () => {
    expect(() => getMaximumTestedOpenCodeVersion({ dependencies: {} })).toThrow(
      'Varro package.json does not declare @opencode-ai/sdk'
    );
  });

  it('rejects a compatibility report with a stale tested ceiling', () => {
    const maximumTestedVersion = getMaximumTestedOpenCodeVersion(packageJson);

    expect(() =>
      assertOpenCodeCompatibilityReportCurrent(packageJson, {
        declaredFloor: '1.16.0',
        declaredCeiling: '0.0.0',
        detectedFloor: '1.16.0',
        boundaryFound: true,
        results: [],
      })
    ).toThrow(
      `OpenCode compatibility report does not cover declared ceiling ${maximumTestedVersion}`
    );
  });

  it('keeps the committed compatibility verification aligned with the manifest', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const verificationSource = await readFile(
      resolve(root, 'scripts/opencode-compatibility/verified.json'),
      'utf8'
    );

    expect(() =>
      assertOpenCodeCompatibilityReportCurrent(packageJson, JSON.parse(verificationSource))
    ).not.toThrow();
  });
});
