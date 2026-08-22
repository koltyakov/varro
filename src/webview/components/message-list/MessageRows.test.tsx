import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../../hooks/useOpenCode';
import { formatClockTime } from '../../lib/message-time';
import { setState } from '../../lib/state';
import { assistantMessage } from '../MessageList.test-utils';
import { AssistantDialogSummaryForMessage, getForkBoundaryMessageId } from './MessageRows';

const forkSessionMock = vi.hoisted(() => vi.fn(async () => 'forked-session'));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise MessageRows integration with useOpenCode actions. */
vi.mock('../../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../../hooks/useOpenCode');
  return { ...actual, forkSession: forkSessionMock };
});

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  forkSessionMock.mockClear();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  setState('messages', []);
  container.remove();
});

describe('AssistantDialogSummaryForMessage', () => {
  it('shows the completion clock time and reports its prompt while hovered', () => {
    vi.useFakeTimers();
    const completedAt = new Date(2026, 0, 2, 13, 45).getTime();
    const onWorkedSummaryHoverChange = vi.fn();
    cleanup = render(
      () => (
        <AssistantDialogSummaryForMessage
          summary={{
            durationMs: 1_000,
            completedAt,
            promptMessageId: 'user-1',
            inputTokens: 10,
            outputTokens: 5,
            agentCount: 0,
          }}
          msg={{ info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] }}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
          onWorkedSummaryHoverChange={onWorkedSummaryHoverChange}
          showCompletedTime={true}
        />
      ),
      container
    );

    const summary = container.querySelector<HTMLElement>('.assistant-dialog-summary');
    const completedTime = summary?.querySelector<HTMLTimeElement>(
      '.assistant-dialog-summary-completed-time'
    );
    expect(completedTime?.textContent).toBe(formatClockTime(completedAt));
    expect(completedTime?.textContent).not.toMatch(/\d{1,2}\/\d{1,2}/);
    expect(summary?.classList.contains('is-completion-time-visible')).toBe(true);
    expect(summary?.querySelector('.assistant-dialog-summary-token-budget')?.textContent).toBe(
      ' - Tokens ↑ 10 ↓ 5'
    );

    summary?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(150);
    summary?.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(150);
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(false);

    summary?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', true);
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(true);
    summary?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', false);
  });

  it('forks the session from the summarized assistant message', () => {
    cleanup = render(
      () => (
        <AssistantDialogSummaryForMessage
          summary={{ durationMs: 1_000, inputTokens: 0, outputTokens: 0, agentCount: 0 }}
          msg={{ info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] }}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
        />
      ),
      container
    );

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork chat from here"]'
    );
    expect(button).not.toBeNull();

    button?.click();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
  });

  it('shows the custom fork tooltip after 500ms', async () => {
    vi.useFakeTimers();
    cleanup = render(
      () => (
        <AssistantDialogSummaryForMessage
          summary={{ durationMs: 1_000, inputTokens: 0, outputTokens: 0, agentCount: 0 }}
          msg={{ info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] }}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
        />
      ),
      container
    );

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork chat from here"]'
    );
    expect(button?.hasAttribute('title')).toBe(false);

    button?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(499);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Fork chat from here'
    );
  });

  it('uses the next source-session message as the exclusive fork boundary', () => {
    const summarized = {
      info: assistantMessage('assistant-1', { sessionID: 'session-1' }),
      parts: [],
    };
    setState('messages', [
      summarized,
      {
        info: assistantMessage('child-assistant', { sessionID: 'child-session' }),
        parts: [],
      },
      {
        info: {
          id: 'user-2',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 2 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.4' },
        },
        parts: [],
      },
    ]);
    cleanup = render(
      () => (
        <AssistantDialogSummaryForMessage
          summary={{ durationMs: 1_000, inputTokens: 0, outputTokens: 0, agentCount: 0 }}
          msg={summarized}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
        />
      ),
      container
    );

    container.querySelector<HTMLButtonElement>('button[aria-label="Fork chat from here"]')?.click();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1', 'user-2');
  });
});

describe('getForkBoundaryMessageId', () => {
  it('returns no boundary when the summarized response is the trailing source message', () => {
    const messages = [
      { info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] },
    ];

    expect(getForkBoundaryMessageId(messages, 'session-1', 'assistant-1')).toBeUndefined();
  });
});
