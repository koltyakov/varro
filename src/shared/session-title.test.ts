import { describe, expect, it } from 'vitest';
import { normalizeSessionTitle } from './session-title';

describe('normalizeSessionTitle', () => {
  it('collapses generated timestamped new-session titles', () => {
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10.819Z')).toBe('New Chat');
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10+05:30')).toBe('New Chat');
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10Z')).toBe('New Chat');
  });

  it('renames the legacy empty-session title', () => {
    expect(normalizeSessionTitle('New session')).toBe('New Chat');
    expect(normalizeSessionTitle(' New session ')).toBe('New Chat');
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
