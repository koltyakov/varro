import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RalphIteration } from '../../../shared/ralph';
import { setState } from '../../lib/state';
import type { UsageLimitNotice } from '../../lib/usage-limit';
import { getRalphIterationLiveIssue } from './ralph-live-issue';

function createIteration(overrides: Partial<RalphIteration> = {}): RalphIteration {
  return {
    index: 1,
    childSessionId: 'child-1',
    status: 'running',
    startedAt: 1,
    endedAt: null,
    filesChanged: [],
    verification: {},
    ...overrides,
  };
}

function createNotice(message: string, attempt: number | null): UsageLimitNotice {
  return { source: 'status', statusCode: 429, message, unit: 'requests', retryAt: null, attempt };
}

function createRetryStatus(message: string, attempt: number) {
  return { type: 'retry', attempt, message, next: 1_700_000_000_000 } as const;
}

function resetState() {
  setState('sessionStatus', {});
  setState('sessionUsageLimits', {});
  setState('failedSessionIds', []);
}

beforeEach(resetState);
afterEach(resetState);

describe('getRalphIterationLiveIssue', () => {
  it('reports nothing without an iteration or a child session', () => {
    expect(getRalphIterationLiveIssue(null)).toBeNull();
    expect(getRalphIterationLiveIssue(undefined)).toBeNull();
    expect(getRalphIterationLiveIssue(createIteration({ childSessionId: null }))).toBeNull();
  });

  it('reports nothing for a healthy child session', () => {
    expect(getRalphIterationLiveIssue(createIteration())).toBeNull();
  });

  it('surfaces a displayable usage limit ahead of any failure state', () => {
    setState('sessionUsageLimits', { 'child-1': createNotice('Rate limit reached', null) });

    expect(getRalphIterationLiveIssue(createIteration())).toBe('Rate limit reached');
  });

  it('ignores a usage limit that is still being retried silently', () => {
    setState('sessionUsageLimits', { 'child-1': createNotice('Service unavailable', 1) });

    expect(getRalphIterationLiveIssue(createIteration())).toBeNull();
  });

  it('reports a generic failure once the child session is marked failed', () => {
    setState('failedSessionIds', ['child-1']);

    expect(getRalphIterationLiveIssue(createIteration())).toBe('Iteration failed');
  });

  it('prefers the retry status message for a failed retrying session', () => {
    setState('failedSessionIds', ['child-1']);
    setState('sessionStatus', { 'child-1': createRetryStatus('Upstream returned 500', 2) });

    expect(getRalphIterationLiveIssue(createIteration())).toBe('Upstream returned 500');
  });

  it('falls back to a generic retry message when the retry carries no text', () => {
    setState('failedSessionIds', ['child-1']);
    setState('sessionStatus', { 'child-1': createRetryStatus('   ', 2) });

    expect(getRalphIterationLiveIssue(createIteration())).toBe('Iteration retry failed');
  });

  it('stays quiet while a retry is still inside the silent service-retry window', () => {
    setState('failedSessionIds', ['child-1']);
    setState('sessionStatus', { 'child-1': createRetryStatus('Service unavailable', 1) });

    expect(getRalphIterationLiveIssue(createIteration())).toBeNull();
  });

  it('scopes the lookup to the iteration own child session', () => {
    setState('failedSessionIds', ['child-2']);

    expect(getRalphIterationLiveIssue(createIteration())).toBeNull();
    expect(getRalphIterationLiveIssue(createIteration({ childSessionId: 'child-2' }))).toBe(
      'Iteration failed'
    );
  });
});
