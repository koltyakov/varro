import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Part } from '../types';
import { areMessageEntriesEquivalent, getSharedMessagePrefixLength } from './message-entry-sync';

function assistantMessage(id: string, createdAt = 0): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: createdAt },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function toolPart(status: 'running' | 'completed', metadata?: Record<string, unknown>): Part {
  return {
    id: 'tool-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    metadata,
    state: {
      status,
      input: { command: 'pwd' },
      title: 'Run pwd',
      time: { start: 1, end: status === 'completed' ? 2 : undefined },
      output: status === 'completed' ? '/repo' : undefined,
    },
  };
}

describe('message entry sync helpers', () => {
  it('computes the shared prefix from message ids', () => {
    expect(
      getSharedMessagePrefixLength(
        [
          { info: assistantMessage('message-1', 1), parts: [] },
          { info: assistantMessage('message-2', 2), parts: [] },
          { info: assistantMessage('message-3', 3), parts: [] },
        ],
        [
          { info: assistantMessage('message-1', 1), parts: [] },
          { info: assistantMessage('message-2', 2), parts: [] },
          { info: assistantMessage('message-4', 4), parts: [] },
        ]
      )
    ).toBe(2);
  });

  it('treats structurally identical entries as equivalent', () => {
    const left = {
      info: assistantMessage('message-1', 1),
      parts: [toolPart('running', { cwd: '/repo' })],
    };
    const right = {
      info: { ...assistantMessage('message-1', 1) },
      parts: [toolPart('running', { cwd: '/repo' })],
    };

    expect(areMessageEntriesEquivalent(left, right)).toBe(true);
  });

  it('detects nested part metadata changes', () => {
    const left = {
      info: assistantMessage('message-1', 1),
      parts: [toolPart('running', { cwd: '/repo' })],
    };
    const right = {
      info: assistantMessage('message-1', 1),
      parts: [toolPart('completed', { cwd: '/repo', exitCode: 0 })],
    };

    expect(areMessageEntriesEquivalent(left, right)).toBe(false);
  });
});
