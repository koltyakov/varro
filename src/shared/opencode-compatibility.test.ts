import { describe, expect, it } from 'vitest';
import { getMaximumTestedOpenCodeVersion } from './opencode-compatibility';

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
});
