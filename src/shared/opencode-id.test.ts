import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeMessageID } from './opencode-id';

describe('OpenCode IDs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not silently wrap a Varro-generated OpenCode timestamp', () => {
    vi.useFakeTimers();
    const timestampRangeMs = 2 ** 36;
    vi.setSystemTime(timestampRangeMs - 2);

    expect(createOpenCodeMessageID()).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(() => createOpenCodeMessageID()).toThrow(/uint48 timestamp era/i);
  });
});
