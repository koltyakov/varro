import { describe, expect, it } from 'vitest';
import {
  combineContextCharacters,
  countContextCharacters,
  estimateContextBreakdown,
  type ContextMessageEntry,
} from './context-breakdown';
import type { AssistantMessage, Part, UserMessage } from './opencode-types';

function user(id: string, text: string, system?: string): ContextMessageEntry {
  const info: UserMessage = {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
  if (system) info.system = system;
  return {
    info,
    parts: [{ id: `${id}-text`, sessionID: 'session-1', messageID: id, type: 'text', text }],
  };
}

function assistant(id: string, parts: Part[]): ContextMessageEntry {
  const info: AssistantMessage = {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 2, completed: 3 },
    parentID: 'user-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'build',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts };
}

const messages: ContextMessageEntry[] = [
  user('user-1', 'First request', 'Base prompt'),
  assistant('assistant-1', [
    {
      id: 'reasoning-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'reasoning',
      text: 'Thinking',
      time: { start: 1, end: 2 },
    },
    {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'file.ts',
        title: 'ls',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  ]),
  user('user-2', 'Second request', 'Updated system prompt'),
  assistant('assistant-2', [
    { id: 'text-2', sessionID: 'session-1', messageID: 'assistant-2', type: 'text', text: 'Done' },
  ]),
  user('user-3', 'Third request'),
];

describe('context breakdown', () => {
  it('combines split transcript counts exactly like one pass', () => {
    const whole = countContextCharacters(messages);
    for (let split = 0; split <= messages.length; split += 1) {
      expect(
        combineContextCharacters(
          countContextCharacters(messages.slice(0, split)),
          countContextCharacters(messages.slice(split))
        )
      ).toEqual(whole);
    }
    expect(whole.system).toBe('Updated system prompt'.length);
  });

  it('uses a supplied character counter and skips counting without input tokens', () => {
    let counted = 0;
    const count = (entries: readonly ContextMessageEntry[]) => {
      counted += 1;
      return countContextCharacters(entries);
    };

    expect(estimateContextBreakdown(messages, 0, count)).toEqual([]);
    expect(counted).toBe(0);
    expect(estimateContextBreakdown(messages, 100, count)).toEqual(
      estimateContextBreakdown(messages, 100)
    );
    expect(counted).toBe(1);
  });
});
