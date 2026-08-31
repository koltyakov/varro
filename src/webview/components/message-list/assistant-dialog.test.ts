import { describe, expect, it } from 'vitest';
import type { TaskSessionInfo } from '../../lib/task-session';
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

function incompleteAssistantMessage(
  id: string,
  sessionID: string,
  parentID: string,
  created: number
): MessageEntry<AssistantMessage> {
  const message = assistantMessage(id, sessionID, parentID, created, created);
  delete message.info.time.completed;
  return message;
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
    const messages: MessageEntry[] = [userMessage('user-1', 'session-parent', 1_000), intermediate];

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
    ).toMatchObject({
      durationMs: 3_000,
      completedAt: 4_000,
      promptMessageId: 'user-1',
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it('includes cache writes and reasoning but excludes cache reads from compact totals', () => {
    const assistant = assistantMessage('assistant-final', 'session-parent', 'user-1', 2_000, 3_000);
    assistant.info.tokens = {
      input: 3,
      output: 238,
      reasoning: 54,
      cache: { read: 7_347, write: 10_325 },
    };

    expect(
      getAssistantDialogSummaryMap(
        [userMessage('user-1', 'session-parent', 1_000), assistant],
        undefined,
        { primarySessionId: 'session-parent' }
      ).get('assistant-final')
    ).toMatchObject({ inputTokens: 10_328, outputTokens: 292 });
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

  it('treats a skipped question as a terminal stopped turn', () => {
    const skipped = assistantMessage(
      'assistant-question',
      'session-parent',
      'user-1',
      2_000,
      3_000
    );
    skipped.info.finish = 'tool-calls';
    skipped.parts = [
      {
        id: 'tool-1',
        sessionID: 'session-parent',
        messageID: 'assistant-question',
        type: 'tool',
        callID: 'call-1',
        tool: 'question',
        state: {
          status: 'error',
          input: { questions: [] },
          error: 'QuestionRejectedError: The user dismissed this question',
          time: { start: 2_100, end: 2_900 },
        },
      },
    ];

    expect(
      getAssistantDialogSummaryMap(
        [userMessage('user-1', 'session-parent', 1_000), skipped],
        undefined,
        { primarySessionId: 'session-parent' }
      ).get('assistant-question')
    ).toMatchObject({ durationMs: 2_000, questionSkipped: true });
  });

  it('marks an aborted turn as interrupted', () => {
    const interrupted = incompleteAssistantMessage(
      'assistant-interrupted',
      'session-parent',
      'user-1',
      2_000
    );
    interrupted.info.finish = 'tool-calls';
    interrupted.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };

    expect(
      getAssistantDialogSummaryMap(
        [userMessage('user-1', 'session-parent', 1_000), interrupted],
        undefined,
        { primarySessionId: 'session-parent' }
      ).get('assistant-interrupted')
    ).toMatchObject({ interrupted: true });
  });

  it('indexes a large session catalog once across many dialog summaries', () => {
    let parentIdReads = 0;
    const sessions: TaskSessionInfo[] = Array.from({ length: 200 }, (_, index) => ({
      id: `session-${index}`,
      get parentID() {
        parentIdReads += 1;
        return index === 0 ? undefined : 'session-parent';
      },
      title: `Session ${index}`,
      time: { created: index + 1 },
    }));
    const messages: MessageEntry[] = [];
    for (let index = 0; index < 50; index += 1) {
      messages.push(
        userMessage(`user-${index}`, 'session-parent', index * 10 + 1),
        assistantMessage(
          `assistant-${index}`,
          'session-parent',
          `user-${index}`,
          index * 10 + 2,
          index * 10 + 3
        )
      );
    }

    const summaries = getAssistantDialogSummaryMap(messages, undefined, {
      primarySessionId: 'session-parent',
      sessions,
    });

    expect(summaries.size).toBe(50);
    expect(parentIdReads).toBeLessThan(400);
  });
});
