import { describe, expect, it } from 'vitest';
import type { TaskSessionInfo } from '../../lib/task-session';
import type { AssistantMessage, MessageEntry, UserMessage } from '../../types';
import { flushesAssistantDialog, getAssistantDialogSummaryMap } from './assistant-dialog';

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
  it('calculates weighted generation TPS without initial latency, tool waits, or child tokens', () => {
    const first = assistantMessage('first', 'session-1', 'user-1', 1_000, 5_000);
    first.info.tokens.output = 100;
    first.info.tokens.reasoning = 100;
    first.parts = [
      {
        id: 'r',
        messageID: 'first',
        sessionID: 'session-1',
        type: 'reasoning',
        text: 'Thinking',
        time: { start: 2_000, end: 3_000 },
      },
      {
        id: 't1',
        messageID: 'first',
        sessionID: 'session-1',
        type: 'text',
        text: 'First',
        time: { start: 3_000, end: 4_000 },
      },
    ];
    const tool = assistantMessage('tool', 'session-1', 'user-1', 5_000, 20_000);
    tool.info.tokens.output = 1_000;
    tool.parts = [
      {
        id: 'tool',
        messageID: 'tool',
        sessionID: 'session-1',
        type: 'tool',
        callID: 'call',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {},
          output: 'Done',
          title: 'bash',
          metadata: {},
          time: { start: 6_000, end: 20_000 },
        },
      },
    ];
    const last = assistantMessage('last', 'session-1', 'user-1', 20_000, 25_000);
    last.info.tokens.output = 100;
    last.parts = [
      {
        id: 't2',
        messageID: 'last',
        sessionID: 'session-1',
        type: 'text',
        text: 'Last',
        time: { start: 21_000, end: 25_000 },
      },
    ];
    const child = assistantMessage('child', 'child-1', 'first', 2_000, 24_000, 'subagent');
    child.info.tokens.output = 5_000;
    const summary = getAssistantDialogSummaryMap([
      userMessage('user-1', 'session-1', 0),
      first,
      tool,
      child,
      last,
    ]).get('last');
    expect(summary?.durationMs).toBe(25_000);
    expect(summary?.tokensPerSecond).toBe(50);
  });

  it.each([
    undefined,
    { start: 2_000 },
    { start: 2_000, end: 2_000 },
    { start: 3_000, end: 2_000 },
    { start: 2_000, end: Number.NaN },
    { start: 500, end: 3_000 },
    { start: 2_000, end: 5_000 },
  ])('omits TPS when generation timing is unavailable or invalid: %s', (time) => {
    const message = assistantMessage('assistant-1', 'session-1', 'user-1', 1_000, 4_000);
    message.parts = [
      {
        id: 'text',
        messageID: 'assistant-1',
        sessionID: 'session-1',
        type: 'text',
        text: 'Hello',
        time,
      },
    ];
    expect(
      getAssistantDialogSummaryMap([message]).get('assistant-1')?.tokensPerSecond
    ).toBeUndefined();
  });

  it.each([0, -1, Number.NaN])('omits TPS for unusable response duration: %s', (duration) => {
    const message = assistantMessage('assistant-1', 'session-1', 'user-1', 1_000, 1_000 + duration);
    message.parts = [
      {
        id: 'text',
        messageID: 'assistant-1',
        sessionID: 'session-1',
        type: 'text',
        text: 'Hello',
      },
    ];
    expect(
      getAssistantDialogSummaryMap([message]).get('assistant-1')?.tokensPerSecond
    ).toBeUndefined();
  });

  it('does not include untimed responses in timed generation TPS', () => {
    const untimed = assistantMessage('untimed', 'session-1', 'user-1', 1_000, 100_000);
    untimed.info.tokens.output = 10_000;
    untimed.parts = [
      { id: 't1', messageID: 'untimed', sessionID: 'session-1', type: 'text', text: 'Untimed' },
    ];
    const timed = assistantMessage('timed', 'session-1', 'user-1', 100_000, 104_000);
    timed.info.tokens.output = 100;
    timed.parts = [
      {
        id: 't2',
        messageID: 'timed',
        sessionID: 'session-1',
        type: 'text',
        text: 'Timed',
        time: { start: 102_000, end: 104_000 },
      },
    ];
    expect(getAssistantDialogSummaryMap([untimed, timed]).get('timed')?.tokensPerSecond).toBe(50);
  });

  it('hides TPS when reasoning tokens have no corresponding generation timing', () => {
    const message = assistantMessage('assistant-1', 'session-1', 'user-1', 1_000, 4_000);
    message.info.tokens.reasoning = 100;
    message.parts = [
      {
        id: 'text',
        messageID: 'assistant-1',
        sessionID: 'session-1',
        type: 'text',
        text: 'Hello',
        time: { start: 2_000, end: 4_000 },
      },
    ];
    expect(
      getAssistantDialogSummaryMap([message]).get('assistant-1')?.tokensPerSecond
    ).toBeUndefined();
  });

  it('summarizes transcript ranges exactly like one pass', () => {
    const child = {
      ...assistantMessage('child-run', 'child-1', 'assistant-2', 22, 24, 'subagent'),
    };
    child.info.cost = 0.3;
    const messages: MessageEntry[] = [
      assistantMessage('leading', 'session-1', 'older-user', 1, 2),
      userMessage('user-1', 'session-1', 10),
      assistantMessage('assistant-1', 'session-1', 'user-1', 11, 15),
      userMessage('user-2', 'session-1', 20),
      assistantMessage('assistant-2', 'session-1', 'user-2', 21, 25),
      child,
      assistantMessage('assistant-3', 'session-1', 'user-2', 26, 30),
      userMessage('user-3', 'session-1', 40),
      assistantMessage('assistant-4', 'session-1', 'user-3', 41, 45),
    ];
    const options = {
      sessions: [
        { id: 'session-1', title: 'Root', time: { created: 0 } },
        { id: 'child-1', parentID: 'session-1', title: 'Child', time: { created: 22 }, cost: 0.2 },
      ],
      primarySessionId: 'session-1',
      collectLeadingSummaryStats: true,
      pauses: [{ messageId: 'assistant-3', pausedAt: 31 }],
    };
    const whole = getAssistantDialogSummaryMap(messages, undefined, options);
    expect(whole.size).toBeGreaterThan(2);
    const splits = messages.flatMap((entry, index) =>
      index > 0 && flushesAssistantDialog(entry, 'session-1') ? [index] : []
    );
    for (const split of splits) {
      const entriesById = new Map(
        messages.slice(0, split).map((entry) => [entry.info.id, entry] as const)
      );
      const history = getAssistantDialogSummaryMap(messages.slice(0, split), undefined, {
        ...options,
        childRunsByParentId: new Map([['assistant-2', [child]]]),
        range: { start: 0, end: split, nextUserRequestCreated: messages[split]!.info.time.created },
      });
      const tail = getAssistantDialogSummaryMap(messages, undefined, {
        ...options,
        entriesById,
        range: { start: split, end: messages.length },
      });
      expect(new Map([...history, ...tail])).toEqual(whole);
    }
  });

  it('sums reported turn costs including child snapshots once and excludes later turns', () => {
    const first = assistantMessage('a1', 'root', 'u1', 2_000, 3_000);
    first.info.cost = 0.004;
    const child = assistantMessage('c1', 'child', 'a1', 2_100, 2_900, 'subagent');
    child.info.cost = 0.03;
    const second = assistantMessage('a2', 'root', 'u2', 5_000, 6_000);
    second.info.cost = 0.01;
    const summaries = getAssistantDialogSummaryMap(
      [userMessage('u1', 'root', 1_000), first, child, userMessage('u2', 'root', 4_000), second],
      undefined,
      {
        primarySessionId: 'root',
        sessions: [
          { id: 'child', parentID: 'root', title: 'Child', time: { created: 2_000 }, cost: 0.066 },
        ],
      }
    );
    expect(summaries.get('a1')?.cost).toBeCloseTo(0.07);
    expect(summaries.get('a2')?.cost).toBe(0.01);
  });

  it('keeps the requested turn cost separate from earlier turns', () => {
    const first = assistantMessage('a1', 'root', 'u1', 2_000, 3_000);
    first.info.cost = 1.43;
    const second = assistantMessage('a2', 'root', 'u2', 5_000, 6_000);
    second.info.cost = 0.07;
    const summaries = getAssistantDialogSummaryMap(
      [userMessage('u1', 'root', 1_000), first, userMessage('u2', 'root', 4_000), second],
      new Set(['a2'])
    );
    expect(summaries.size).toBe(1);
    expect(summaries.get('a2')?.cost).toBe(0.07);
  });

  it('does not estimate cost when OpenCode reports no spending', () => {
    const message = assistantMessage('a1', 'root', 'u1', 2_000, 3_000);
    expect(
      getAssistantDialogSummaryMap([userMessage('u1', 'root', 1_000), message]).get('a1')?.cost
    ).toBeUndefined();
  });
  it.each([false, true])(
    'keeps provider recovery and server restart in one turn, completed: %s',
    (completed) => {
      const notice = (id: string, created: number, text: string) => {
        const entry = userMessage(id, 'session-parent', created);
        entry.parts = [
          {
            id: `${id}-text`,
            messageID: id,
            sessionID: 'session-parent',
            type: 'text',
            text,
            synthetic: true,
          },
        ];
        return entry;
      };
      const failed = assistantMessage('failed', 'session-parent', 'prompt', 2_000, 3_000);
      failed.info.finish = 'error';
      failed.info.error = {
        name: 'UnknownError',
        data: { message: 'WebSocket closed with code 1012' },
      };
      const restarted = assistantMessage('restarted', 'session-parent', 'recovery', 4_000, 5_000);
      const resumed = assistantMessage('resumed', 'session-parent', 'restart', 6_000, 7_000);
      resumed.info.finish = completed ? 'stop' : 'tool-calls';
      const messages = [
        userMessage('prompt', 'session-parent', 1_000),
        failed,
        notice(
          'recovery',
          3_100,
          'The previous response was interrupted. Continue from where you left off without repeating completed content.'
        ),
        restarted,
        notice(
          'restart',
          5_100,
          'The server restarted while you were working. Continue from where you left off without repeating completed work.'
        ),
        resumed,
      ];

      const summaries = getAssistantDialogSummaryMap(messages, undefined, {
        primarySessionId: 'session-parent',
      });
      expect([...summaries.keys()]).toEqual(completed ? ['resumed'] : []);
      if (completed) {
        expect(summaries.get('resumed')).toMatchObject({
          durationMs: 6_000,
          promptMessageId: 'prompt',
          inputTokens: 30,
          outputTokens: 15,
        });
      }
    }
  );

  it('still ends a turn when a real prompt includes automatic context', () => {
    const followup = userMessage('followup', 'session-parent', 4_000);
    followup.parts = [
      {
        id: 'context',
        messageID: 'followup',
        sessionID: 'session-parent',
        type: 'text',
        text: 'Instructions from: /repo/AGENTS.md',
        synthetic: true,
      },
      {
        id: 'prompt-text',
        messageID: 'followup',
        sessionID: 'session-parent',
        type: 'text',
        text: 'Do the next task',
      },
    ];
    const summaries = getAssistantDialogSummaryMap([
      userMessage('prompt', 'session-parent', 1_000),
      assistantMessage('first', 'session-parent', 'prompt', 2_000, 3_000),
      followup,
      assistantMessage('second', 'session-parent', 'followup', 5_000, 6_000),
    ]);
    expect([...summaries.keys()]).toEqual(['first', 'second']);
    expect(summaries.get('second')).toMatchObject({
      promptMessageId: 'followup',
      durationMs: 2_000,
    });
  });

  it.each([true, false])(
    'closes paused work and excludes the gap before continuation with a prompt: %s',
    (newPrompt) => {
      const paused = incompleteAssistantMessage('paused', 'session-parent', 'prompt', 2_000);
      paused.info.finish = 'tool-calls';
      const messages: MessageEntry[] = [
        userMessage('prompt', 'session-parent', 1_000),
        paused,
        ...(newPrompt ? [userMessage('resume', 'session-parent', 3_611_000)] : []),
        assistantMessage(
          'resumed',
          'session-parent',
          newPrompt ? 'resume' : 'prompt',
          3_611_000,
          3_616_000
        ),
      ];
      const summaries = getAssistantDialogSummaryMap(messages, undefined, {
        primarySessionId: 'session-parent',
        pauses: [{ messageId: 'paused', pausedAt: 11_000 }],
      });
      expect(summaries.get('paused')).toMatchObject({ durationMs: 10_000, completedAt: 11_000 });
      expect(summaries.get('resumed')).toMatchObject({ durationMs: 5_000, completedAt: 3_616_000 });
      expect(paused.info.time.completed).toBeUndefined();
    }
  );

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
