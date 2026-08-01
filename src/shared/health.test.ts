import { describe, expect, it } from 'vitest';
import { parseHealthResponse } from './health';

describe('parseHealthResponse', () => {
  it('accepts a boolean health state with an optional string version', () => {
    expect(parseHealthResponse({ healthy: true, version: '1.2.3' })).toEqual({
      healthy: true,
      version: '1.2.3',
    });
    expect(parseHealthResponse({ healthy: false, version: '1.2.3' })).toEqual({
      healthy: false,
      version: '1.2.3',
    });
    expect(parseHealthResponse({ healthy: true })).toEqual({ healthy: true });
    expect(parseHealthResponse({ healthy: true, version: '' })).toEqual({
      healthy: true,
      version: '',
    });
  });

  it.each([null, [], {}, { healthy: 'true', version: '1.2.3' }, { healthy: true, version: 1 }])(
    'rejects malformed payload %#',
    (value) => {
      expect(parseHealthResponse(value)).toBeNull();
    }
  );
});
