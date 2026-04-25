import { describe, expect, it } from 'vitest';
import { normalizeSessionTitle } from './session-title';

describe('normalizeSessionTitle', () => {
  it('collapses generated timestamped new-session titles', () => {
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10.819Z')).toBe('New session');
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10+05:30')).toBe('New session');
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10Z')).toBe('New session');
  });

  it('returns an empty title for nullish and blank input', () => {
    expect(normalizeSessionTitle(null)).toBe('');
    expect(normalizeSessionTitle(undefined)).toBe('');
    expect(normalizeSessionTitle('')).toBe('');
    expect(normalizeSessionTitle('   ')).toBe('');
  });

  it('preserves non-generated titles after trimming', () => {
    expect(normalizeSessionTitle(' New session - onboarding notes ')).toBe(
      'New session - onboarding notes'
    );
    expect(normalizeSessionTitle('New session - 2026-04-22')).toBe('New session - 2026-04-22');
  });
});
