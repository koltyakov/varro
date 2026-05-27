import { describe, expect, it } from 'vitest';
import { isAbortedAssistantError, isAbortedToolError } from './aborted';

describe('isAbortedAssistantError', () => {
  it('detects legacy "aborted" error name', () => {
    expect(isAbortedAssistantError({ name: 'aborted', data: { message: 'Aborted' } })).toBe(true);
    expect(isAbortedAssistantError({ name: 'AbortError' })).toBe(true);
  });

  it('detects opencode MessageAbortedError', () => {
    expect(
      isAbortedAssistantError({
        name: 'MessageAbortedError',
        data: { message: 'The user aborted a request.' },
      })
    ).toBe(true);
  });

  it('detects abort via data.message fallback', () => {
    expect(isAbortedAssistantError({ name: 'UnknownError', data: { message: 'aborted' } })).toBe(
      true
    );
  });

  it('rejects non-abort errors', () => {
    expect(isAbortedAssistantError({ name: 'APIError', data: { message: 'timeout' } })).toBe(false);
    expect(isAbortedAssistantError(undefined)).toBe(false);
  });
});

describe('isAbortedToolError', () => {
  it('detects aborted tool errors', () => {
    expect(isAbortedToolError({ status: 'error', error: 'aborted' })).toBe(true);
    expect(isAbortedToolError({ status: 'error', error: 'AbortError' })).toBe(true);
    expect(isAbortedToolError({ status: 'error', error: 'Tool execution aborted' })).toBe(true);
  });

  it('rejects non-error status', () => {
    expect(isAbortedToolError({ status: 'completed', error: 'aborted' })).toBe(false);
  });

  it('rejects non-abort tool errors', () => {
    expect(isAbortedToolError({ status: 'error', error: 'timeout' })).toBe(false);
  });
});
