import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { RalphIteration } from '../../../shared/ralph';
import type { Session } from '../../types';
import { setSessionUsageLimit, setState } from '../../lib/state';
import { RalphIterationCard } from './RalphIterationCard';
import { client } from '../../lib/client';
import * as bridge from '../../lib/bridge';

const selectSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise iteration-card actions through useOpenCode. */
vi.mock('../../hooks/useOpenCode', () => ({
  selectSession: selectSessionMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

async function flushMicrotasks(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

function iteration(overrides: Partial<RalphIteration> = {}): RalphIteration {
  return {
    index: 6,
    childSessionId: null,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    filesChanged: [],
    verification: {},
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  selectSessionMock.mockReset();
  setState('sessionStatus', {});
  setState('sessionUsageLimits', {});
  setState('failedSessionIds', []);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setState('sessionStatus', {});
  setState('sessionUsageLimits', {});
  setState('failedSessionIds', []);
});

describe('RalphIterationCard', () => {
  it('explains contradictory command evidence and opens the repair session', async () => {
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-1',
            status: 'failed',
            verification: { lint: 'fail' },
            verificationEvidence: {
              lint: {
                sessionId: 'repair-1',
                messageId: 'message-1',
                partId: 'part-1',
                command: 'npm run lint',
                exitCode: 2,
                reportedVerdict: 'pass',
              },
            },
          }),
        }),
      container!
    );
    expect(container?.textContent).toContain('model reported PASS; command failed');
    expect(container?.querySelector('.ralph-iter-verdict')?.textContent).toBe(
      'lint:fail (command)'
    );
    Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.ralph-verification-evidence button') ?? []
    )
      .find((button) => button.textContent?.includes('Open lint session'))
      ?.click();
    await flushMicrotasks();
    expect(selectSessionMock).toHaveBeenCalledWith('repair-1');
  });

  it('opens the exact recorded tool output and reports missing evidence without substituting another tool', async () => {
    const messages: Awaited<ReturnType<typeof client.session.messages>> = [
      {
        info: {
          id: 'message-1',
          sessionID: 'repair-1',
          role: 'assistant',
          time: { created: 200 },
          parentID: 'prompt-1',
          modelID: 'model',
          providerID: 'provider',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            type: 'tool',
            tool: 'bash',
            id: 'part-other',
            sessionID: 'repair-1',
            messageID: 'message-1',
            callID: 'call-other',
            state: {
              status: 'completed',
              input: { command: 'npm test' },
              output: 'wrong output',
              title: 'test',
              metadata: { exit: 0 },
              time: { start: 200, end: 210 },
            },
          },
          {
            type: 'tool',
            tool: 'bash',
            id: 'part-1',
            sessionID: 'repair-1',
            messageID: 'message-1',
            callID: 'call-1',
            state: {
              status: 'completed',
              input: { command: 'npm run lint' },
              output: 'lint failed on line 12',
              title: 'lint',
              metadata: { exit: 2 },
              time: { start: 220, end: 230 },
            },
          },
        ],
      },
    ];
    const readMessages = vi.spyOn(client.session, 'messages').mockResolvedValue(messages);
    const openText = vi.spyOn(bridge, 'postMessage').mockReturnValue(true);
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-1',
            status: 'failed',
            verification: { lint: 'fail' },
            verificationEvidence: {
              lint: {
                sessionId: 'repair-1',
                messageId: 'message-1',
                partId: 'part-1',
                command: 'npm run lint',
                exitCode: 2,
                reportedVerdict: 'pass',
              },
            },
          }),
        }),
      container!
    );
    container?.querySelector<HTMLButtonElement>('.ralph-verification-evidence button')?.click();
    await flushMicrotasks(5);
    expect(readMessages).toHaveBeenCalledWith('repair-1');
    expect(openText).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        title: 'Ralph lint command output',
        language: 'plaintext',
        content: 'npm run lint\nRecorded exit: 2\nModel reported: pass\n\nlint failed on line 12',
      },
    });
    readMessages.mockResolvedValue([]);
    container?.querySelector<HTMLButtonElement>('.ralph-verification-evidence button')?.click();
    await flushMicrotasks(5);
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      'no longer available'
    );
    expect(openText).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['pending', 'Pending'],
    ['running', 'Running'],
    ['passed', 'Passed'],
    ['failed', 'Error'],
    ['unverified', 'Unverified'],
    ['aborted', 'Aborted'],
  ] as const)('renders the %s status label', (status, label) => {
    cleanup = render(() => RalphIterationCard({ iteration: iteration({ status }) }), container!);

    const statusBadge = container?.querySelector('.ralph-iter-status');
    const button = container?.querySelector('button.ralph-iter-card');

    expect(statusBadge?.textContent).toBe(label);
    expect(statusBadge?.className).toContain(
      status === 'failed' ? 'ralph-iter-status-error' : `ralph-iter-status-${status}`
    );
    expect(button?.className).toContain(`ralph-iter-${status}`);
    expect(container?.querySelector('.ralph-iter-duration')).toBeNull();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((button as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it('opens the child session only when one is present', () => {
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-1',
            status: 'passed',
          }),
        }),
      container!
    );

    const enabledButton = container?.querySelector('button.ralph-iter-card');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((enabledButton as HTMLButtonElement | null)?.disabled).toBe(false);

    enabledButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(selectSessionMock).toHaveBeenCalledWith('child-session-1');

    cleanup?.();
    cleanup = render(() => RalphIterationCard({ iteration: iteration() }), container!);

    const disabledButton = container?.querySelector('button.ralph-iter-card');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((disabledButton as HTMLButtonElement | null)?.disabled).toBe(true);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (disabledButton as HTMLButtonElement | null)?.click();

    expect(selectSessionMock).toHaveBeenCalledTimes(1);
  });

  it('formats verdict labels and token summaries across the compact display branches', () => {
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-1',
            verification: {
              'cargo build': 'pass',
              typecheck: 'fail',
              lint: 'skipped',
            },
            tokens: {
              input: 1200,
              output: 12500,
              reasoning: 400,
              cacheRead: 50,
              cacheWrite: 25,
              total: 14175,
            },
          }),
        }),
      container!
    );

    const verdicts = Array.from(container?.querySelectorAll('.ralph-iter-verdict') ?? []);
    const tokens = container?.querySelector('.ralph-iter-tokens');

    expect(verdicts.map((node) => node.textContent)).toEqual([
      'cb:pass (reported)',
      'typecheck:fail (reported)',
      'lint:skipped (reported)',
    ]);
    expect(verdicts[0]?.getAttribute('title')).toBe('cargo build: pass (model-reported)');
    expect(tokens?.textContent).toBe('↓1.2k ↑13k');
    expect(tokens?.getAttribute('title')).toContain('input 1200');
    expect(tokens?.getAttribute('title')).toContain('output 12500');
    expect(tokens?.getAttribute('title')).toContain('reasoning 400');
    expect(tokens?.getAttribute('title')).toContain('cache r50/w25');
    expect(tokens?.getAttribute('title')).toContain('total 14175');

    cleanup?.();
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            tokens: {
              input: 999,
              output: 1_500_000,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 1_500_999,
            },
          }),
        }),
      container!
    );

    const millionTokens = container?.querySelector('.ralph-iter-tokens');
    expect(millionTokens?.textContent).toBe('↓999 ↑1.5M');
    expect(millionTokens?.getAttribute('title')).not.toContain('reasoning');
    expect(millionTokens?.getAttribute('title')).not.toContain('cache r');
  });

  it('formats completed and running durations from milliseconds through minutes', async () => {
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            startedAt: 100,
            endedAt: 350,
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-duration')?.textContent).toBe('250ms');

    cleanup?.();
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            startedAt: 1_000,
            endedAt: 6_000,
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-duration')?.textContent).toBe('5s');

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    cleanup?.();
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            status: 'running',
            startedAt: 9_000,
            endedAt: null,
          }),
        }),
      container!
    );

    vi.advanceTimersByTime(64_000);
    await flushMicrotasks();

    expect(container?.querySelector('.ralph-iter-duration')?.textContent).toBe('1m 5s');

    cleanup?.();
    cleanup = undefined;

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('keeps the duration after the iteration note', () => {
    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            status: 'passed',
            startedAt: 1_000,
            endedAt: 59_000,
            note: 'plan: PASS lint: SKIPPED',
          }),
        }),
      container!
    );

    const note = container?.querySelector('.ralph-iter-note');
    const duration = container?.querySelector('.ralph-iter-duration');

    expect(note?.textContent).toBe('plan: PASS lint: SKIPPED');
    expect(duration?.textContent).toBe('58s');
    expect(note?.nextElementSibling).toBe(duration);
  });

  it('prefers the active child-session issue over the saved note', () => {
    const childSession: Session = {
      id: 'child-session-1',
      projectID: 'project-1',
      directory: '/repo',
      title: 'child-session-1',
      version: '1',
      time: { created: 0, updated: 0 },
    };
    setState('sessions', [childSession]);
    setSessionUsageLimit('child-session-1', {
      source: 'status',
      statusCode: 429,
      message: 'messages exhausted · retry in 28s · attempt #5',
      unit: 'messages',
      retryAt: 28_000,
      attempt: 5,
      sessionID: 'child-session-1',
    });

    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-1',
            status: 'running',
            note: 'stale saved note',
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-note')?.textContent).toBe(
      'messages exhausted · retry in 28s · attempt #5'
    );
    expect(container?.querySelector('.ralph-iter-card')?.getAttribute('title')).toBe(
      'messages exhausted · retry in 28s · attempt #5'
    );
  });

  it('does not borrow usage-limit notices from sibling child sessions', () => {
    const managerSession: Session = {
      id: 'manager-session',
      projectID: 'project-1',
      directory: '/repo',
      title: 'manager-session',
      version: '1',
      time: { created: 0, updated: 0 },
    };
    const childSession: Session = {
      id: 'child-session-ok',
      projectID: 'project-1',
      directory: '/repo',
      title: 'child-session-ok',
      version: '1',
      parentID: 'manager-session',
      time: { created: 0, updated: 0 },
    };
    const siblingSession: Session = {
      id: 'child-session-error',
      projectID: 'project-1',
      directory: '/repo',
      title: 'child-session-error',
      version: '1',
      parentID: 'manager-session',
      time: { created: 0, updated: 0 },
    };
    setState('sessions', [managerSession, childSession, siblingSession]);
    setSessionUsageLimit('child-session-error', {
      source: 'status',
      statusCode: 429,
      message: 'The usage limit has been reached',
      unit: 'messages',
      retryAt: 28_000,
      attempt: 5,
      sessionID: 'child-session-error',
    });

    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-ok',
            status: 'passed',
            startedAt: 1_000,
            endedAt: 7_000,
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-status')?.textContent).toBe('Passed');
    expect(container?.querySelector('.ralph-iter-duration')?.textContent).toBe('6s');
    expect(container?.querySelector('.ralph-iter-note')).toBeNull();
    expect(container?.querySelector('.ralph-iter-card')?.getAttribute('title')).toBeNull();
  });

  it('shows running live-issue iterations as error and hides duration', () => {
    const childSession: Session = {
      id: 'child-session-2',
      projectID: 'project-1',
      directory: '/repo',
      title: 'child-session-2',
      version: '1',
      time: { created: 0, updated: 0 },
    };
    setState('sessions', [childSession]);
    setSessionUsageLimit('child-session-2', {
      source: 'status',
      statusCode: 429,
      message: 'The usage limit has been reached',
      unit: 'messages',
      retryAt: 28_000,
      attempt: 5,
      sessionID: 'child-session-2',
    });

    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-2',
            status: 'running',
            startedAt: 1_000,
            endedAt: null,
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-card')?.className).toContain('ralph-iter-error');
    expect(container?.querySelector('.ralph-iter-status')?.textContent).toBe('Error');
    expect(container?.querySelector('.ralph-iter-status')?.className).toContain(
      'ralph-iter-status-error'
    );
    expect(container?.querySelector('.ralph-iter-duration')).toBeNull();
    expect(container?.querySelector('.ralph-iter-note')?.textContent).toBe(
      'The usage limit has been reached'
    );
  });

  it('shows explicit error state and hides duration for failed iterations', () => {
    const childSession: Session = {
      id: 'child-session-3',
      projectID: 'project-1',
      directory: '/repo',
      title: 'child-session-3',
      version: '1',
      time: { created: 0, updated: 0 },
    };
    setState('sessions', [childSession]);
    setSessionUsageLimit('child-session-3', {
      source: 'status',
      statusCode: 429,
      message: 'The usage limit has been reached',
      unit: 'messages',
      retryAt: 28_000,
      attempt: 5,
      sessionID: 'child-session-3',
    });

    cleanup = render(
      () =>
        RalphIterationCard({
          iteration: iteration({
            childSessionId: 'child-session-3',
            status: 'failed',
            startedAt: 1_000,
            endedAt: 6_000,
          }),
        }),
      container!
    );

    expect(container?.querySelector('.ralph-iter-card')?.className).toContain('ralph-iter-error');
    expect(container?.querySelector('.ralph-iter-status')?.textContent).toBe('Error');
    expect(container?.querySelector('.ralph-iter-status')?.className).toContain(
      'ralph-iter-status-error'
    );
    expect(container?.querySelector('.ralph-iter-duration')).toBeNull();
    expect(container?.querySelector('.ralph-iter-note')?.textContent).toBe(
      'The usage limit has been reached'
    );
  });
});
