import { describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry, Part, UserMessage } from '../../types';
import {
  estimateContextBreakdown,
  estimateNestedContextBreakdown,
} from '../../../shared/context-breakdown';

type PartInput = Part extends infer T
  ? T extends Part
    ? Omit<T, 'id' | 'sessionID' | 'messageID'>
    : never
  : never;

function userMessage(id: string, system?: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
    system,
  };
}

function assistantMessage(id: string, sessionID = 'session-1', input = 20): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 2 },
    parentID: 'user-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: {
      input,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function part(value: PartInput): Part {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    ...value,
  };
}

describe('estimateContextBreakdown', () => {
  it('estimates message categories and assigns unaccounted input tokens to other', () => {
    const messages: MessageEntry[] = [
      {
        info: userMessage('user-1', 'system prompt'),
        parts: [part({ type: 'text', text: 'hello world' })],
      },
      {
        info: assistantMessage('assistant-1'),
        parts: [part({ type: 'text', text: 'assistant response' })],
      },
    ];

    expect(
      Object.fromEntries(
        estimateContextBreakdown(messages, 20).map((segment) => [segment.key, segment.tokens])
      )
    ).toEqual({
      system: 4,
      user: 3,
      assistant: 5,
      other: 8,
    });
  });

  it('attributes tool arguments and results to tool calls', () => {
    const messages: MessageEntry[] = [
      {
        info: assistantMessage('assistant-1'),
        parts: [
          part({
            type: 'tool',
            callID: 'call-1',
            tool: 'read',
            state: {
              status: 'completed',
              input: { filePath: '/repo/file.ts' },
              output: 'file contents',
              title: 'Read file',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          }),
        ],
      },
    ];

    expect(estimateContextBreakdown(messages, 20)).toEqual([
      { key: 'tool', tokens: 8, percent: 40 },
      { key: 'other', tokens: 12, percent: 60 },
    ]);
  });

  it('scales estimates to the reported input token count', () => {
    const messages: MessageEntry[] = [
      {
        info: userMessage('user-1', 'z'.repeat(200)),
        parts: [part({ type: 'text', text: 'x'.repeat(400) })],
      },
      {
        info: assistantMessage('assistant-1'),
        parts: [part({ type: 'text', text: 'y'.repeat(400) })],
      },
    ];

    const breakdown = estimateContextBreakdown(messages, 10);

    expect(breakdown.reduce((total, segment) => total + segment.tokens, 0)).toBe(10);
    expect(breakdown.every((segment) => segment.percent <= 100)).toBe(true);
  });

  it('combines each nested session using its latest input token count', () => {
    const messages: MessageEntry[] = [
      { info: assistantMessage('assistant-root'), parts: [] },
      {
        info: assistantMessage('assistant-child', 'child-1', 10),
        parts: [part({ type: 'text', text: 'x'.repeat(20) })],
      },
    ];

    expect(estimateNestedContextBreakdown([[messages[0]!], [messages[1]!]])).toEqual([
      { key: 'assistant', tokens: 5, percent: 16.7 },
      { key: 'other', tokens: 25, percent: 83.3 },
    ]);
  });
});
