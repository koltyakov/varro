import { describe, expect, it } from 'vitest';
import {
  getMessageEntriesForSession,
  getLatestAssistantMessageInfo,
  getLatestAssistantMessageInfoWithTokens,
  sumAssistantTokensFromMessageEntries,
} from '../components/chat-input/message-usage';
import type { AssistantMessage, Message } from '../types';

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

function assistantMessage(id: string, tokens = { input: 0, output: 0 }): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function countedEntry(info: Message, onRead: () => void): { info: Message } {
  const entry = {} as { info: Message };
  Object.defineProperty(entry, 'info', {
    configurable: true,
    get: () => {
      onRead();
      return info;
    },
  });
  return entry;
}

describe('ChatInput perf helpers', () => {
  it('finds the latest assistant from the tail without scanning the full history', () => {
    let readCount = 0;
    const entries = Array.from({ length: 1000 }, (_, index) =>
      countedEntry(userMessage(`user-${index}`), () => {
        readCount += 1;
      })
    );
    entries.push(
      countedEntry(assistantMessage('assistant-latest'), () => {
        readCount += 1;
      })
    );

    expect(getLatestAssistantMessageInfo(entries)?.id).toBe('assistant-latest');
    expect(readCount).toBe(1);
  });

  it('finds the latest token-bearing assistant from the tail without allocating assistant arrays', () => {
    let readCount = 0;
    const entries = Array.from({ length: 1000 }, (_, index) =>
      countedEntry(userMessage(`user-${index}`), () => {
        readCount += 1;
      })
    );
    entries.push(
      countedEntry(assistantMessage('assistant-with-tokens', { input: 10, output: 5 }), () => {
        readCount += 1;
      }),
      countedEntry(userMessage('user-tail'), () => {
        readCount += 1;
      })
    );

    expect(getLatestAssistantMessageInfoWithTokens(entries)?.id).toBe('assistant-with-tokens');
    expect(readCount).toBe(2);
  });

  it('skips subagent messages when finding latest assistant', () => {
    const entries = [
      { info: assistantMessage('primary', { input: 10, output: 5 }) },
      { info: { ...assistantMessage('subagent-1', { input: 20, output: 10 }), mode: 'subagent' } },
    ];

    expect(getLatestAssistantMessageInfo(entries)?.id).toBe('primary');
    expect(getLatestAssistantMessageInfoWithTokens(entries)?.id).toBe('primary');
  });

  it('scopes context token helpers to the active session including selected subagents', () => {
    const entries = [
      { info: assistantMessage('primary', { input: 10, output: 5 }) },
      {
        info: {
          ...assistantMessage('other-session', { input: 100, output: 50 }),
          sessionID: 'session-2',
        },
      },
      {
        info: {
          ...assistantMessage('selected-subagent', { input: 20, output: 10 }),
          sessionID: 'child-1',
          mode: 'subagent',
        },
      },
    ];

    const currentSessionEntries = getMessageEntriesForSession(entries, 'child-1');

    expect(
      getLatestAssistantMessageInfoWithTokens(currentSessionEntries, {
        includeSubagents: true,
      })?.id
    ).toBe('selected-subagent');
    expect(sumAssistantTokensFromMessageEntries(currentSessionEntries)).toMatchObject({
      total: 30,
      input: 20,
      output: 10,
    });
  });

  it('sums assistant tokens directly from message entries', () => {
    expect(
      sumAssistantTokensFromMessageEntries([
        { info: userMessage('user-1') },
        { info: assistantMessage('assistant-1', { input: 10, output: 5 }) },
        { info: assistantMessage('assistant-2', { input: 2, output: 3 }) },
      ])
    ).toMatchObject({ total: 20, input: 12, output: 8 });
  });
});
