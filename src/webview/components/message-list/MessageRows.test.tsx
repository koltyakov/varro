import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../../hooks/useOpenCode';
import { formatClockTime } from '../../lib/message-time';
import { setState, startLoading, stopLoading } from '../../lib/state';
import { copyIcon, gitForkIcon } from '../../lib/ui-icons';
import { assistantMessage, textPart } from '../MessageList.test-utils';
import { toCssUrl } from '../UiIcon';
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
  stopLoading();
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

    summary?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(150);
    summary?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    vi.advanceTimersByTime(150);
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(false);

    summary?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(onWorkedSummaryHoverChange).not.toHaveBeenCalled();
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', true);
    expect(summary?.classList.contains('is-hover-intent-active')).toBe(true);
    summary?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', false);
  });

  it('shows the completion clock time for interrupted summaries', () => {
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
            inputTokens: 0,
            outputTokens: 0,
            agentCount: 0,
            interrupted: true,
          }}
          msg={{ info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] }}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
          onWorkedSummaryHoverChange={onWorkedSummaryHoverChange}
        />
      ),
      container
    );

    const summary = container.querySelector<HTMLElement>('.assistant-dialog-summary');
    expect(summary?.textContent).toContain('Interrupted');
    expect(summary?.querySelector('time')?.textContent).toBe(formatClockTime(completedAt));

    summary?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(summary?.classList.contains('is-completion-time-visible')).toBe(true);
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', true);
  });

  it('includes the final response in the summary hover region', () => {
    vi.useFakeTimers();
    const onWorkedSummaryHoverChange = vi.fn();
    cleanup = render(
      () => (
        <div class="interactive-list-track">
          <div data-msg-id="assistant-1">
            <div class="assistant-message-flow-item-final">Final response</div>
          </div>
          <div class="trailing-assistant-summary-row">
            <AssistantDialogSummaryForMessage
              summary={{
                durationMs: 1_000,
                promptMessageId: 'user-1',
                inputTokens: 0,
                outputTokens: 0,
                agentCount: 0,
              }}
              msg={{ info: assistantMessage('assistant-1', { sessionID: 'session-1' }), parts: [] }}
              hasBuildAgent={false}
              latestPlanImplementationMessageId={null}
              onWorkedSummaryHoverChange={onWorkedSummaryHoverChange}
            />
          </div>
        </div>
      ),
      container
    );

    const finalResponse = container.querySelector<HTMLElement>(
      '.assistant-message-flow-item-final'
    );
    const responseRow = container.querySelector<HTMLElement>('[data-msg-id="assistant-1"]');
    const summary = container.querySelector<HTMLElement>('.assistant-dialog-summary');
    finalResponse?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(300);

    expect(summary?.classList.contains('is-hover-intent-active')).toBe(true);
    expect(onWorkedSummaryHoverChange).toHaveBeenLastCalledWith('user-1', true);

    finalResponse?.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: responseRow })
    );
    responseRow?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: finalResponse })
    );

    expect(summary?.classList.contains('is-hover-intent-active')).toBe(true);

    responseRow?.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: summary })
    );
    summary?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: responseRow })
    );

    expect(summary?.classList.contains('is-hover-intent-active')).toBe(true);
    expect(onWorkedSummaryHoverChange).toHaveBeenCalledTimes(1);
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
    const icon = button?.querySelector<HTMLElement>('.ui-icon');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(gitForkIcon));

    button?.click();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
  });

  it('forks a completed response while a later turn is active', () => {
    startLoading();
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
    expect(button?.disabled).toBe(false);

    button?.click();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
  });

  it('copies the final assistant response', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    cleanup = render(
      () => (
        <AssistantDialogSummaryForMessage
          summary={{ durationMs: 1_000, inputTokens: 0, outputTokens: 0, agentCount: 0 }}
          msg={{
            info: assistantMessage('assistant-1', { sessionID: 'session-1' }),
            parts: [
              textPart('text-1', 'First paragraph'),
              textPart('synthetic', 'Internal text', { synthetic: true }),
              textPart('text-2', 'Second paragraph'),
            ],
          }}
          hasBuildAgent={false}
          latestPlanImplementationMessageId={null}
        />
      ),
      container
    );

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy final response"]'
    );
    expect(
      button?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(copyIcon));
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('.assistant-dialog-summary-turn-action')
      ).map((action) => action.getAttribute('aria-label'))
    ).toEqual(['Copy final response', 'Fork chat from here']);

    button?.click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('First paragraph\n\nSecond paragraph')
    );
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
