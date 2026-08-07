import { describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry, UserMessage } from '../../types';
import { getAssistantDialogSummaryMap } from './assistant-dialog';

function userMessage(id: string, sessionID: string, created: number): MessageEntry<UserMessage> {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [],
  };
}

function assistantMessage(
  id: string,
  sessionID: string,
  parentID: string,
  created: number,
  completed: number,
  mode = 'build'
): MessageEntry<AssistantMessage> {
  return {
    info: {
      id,
      sessionID,
      role: 'assistant',
      time: { created, completed },
      parentID,
      modelID: 'gpt-5',
      providerID: 'openai',
      mode,
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
}

describe('getAssistantDialogSummaryMap', () => {
  it('waits for a terminal assistant step before adding the worked summary', () => {
    const intermediate = assistantMessage(
      'assistant-tool-call',
      'session-parent',
      'user-1',
      2_000,
      3_000
    );
    intermediate.info.finish = 'tool-calls';
    const messages: MessageEntry[] = [
      userMessage('user-1', 'session-parent', 1_000),
      intermediate,
    ];

    expect(
      getAssistantDialogSummaryMap(messages, undefined, {
        primarySessionId: 'session-parent',
      }).size
    ).toBe(0);

    const final = assistantMessage('assistant-final', 'session-parent', 'user-1', 3_100, 4_000);
    final.info.finish = 'stop';
    messages.push(final);

    expect(
      getAssistantDialogSummaryMap(messages, undefined, {
        primarySessionId: 'session-parent',
      }).get('assistant-final')
    ).toMatchObject({ durationMs: 3_000, inputTokens: 20, outputTokens: 10 });
  });

  it('does not let a child completion become the primary worked summary', () => {
    const messages: MessageEntry[] = [
      userMessage('user-1', 'session-parent', 1_000),
      assistantMessage('assistant-parent', 'session-parent', 'user-1', 2_000, 3_000),
      userMessage('user-child', 'session-child', 2_100),
      assistantMessage('assistant-child', 'session-child', 'user-child', 2_200, 4_000),
    ];

    const summaries = getAssistantDialogSummaryMap(messages, undefined, {
      primarySessionId: 'session-parent',
    });

    expect([...summaries.keys()]).toEqual(['assistant-parent']);
  });
});
