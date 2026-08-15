import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../../hooks/useOpenCode';
import { setState } from '../../lib/state';
import { assistantMessage } from '../MessageList.test-utils';
import { AssistantDialogSummaryForMessage, getForkBoundaryMessageId } from './MessageRows';

const forkSessionMock = vi.hoisted(() => vi.fn(async () => 'forked-session'));

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
  setState('messages', []);
  container.remove();
});

describe('AssistantDialogSummaryForMessage', () => {
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
