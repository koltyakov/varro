import { describe, expect, it } from 'vitest';
import type { MessageEntry } from '../../types';
import { computeTurnEndAssistantIds } from './thread-visibility';

function user(id: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    parts: [],
  };
}

function assistant(id: string): MessageEntry {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 0 },
      parentID: 'u1',
      modelID: 'gpt-5',
      providerID: 'openai',
      mode: 'default',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
}

describe('computeTurnEndAssistantIds', () => {
  it('marks the single assistant message of a turn', () => {
    const ids = computeTurnEndAssistantIds([user('u1'), assistant('a1')]);
    expect(ids.has('a1')).toBe(true);
  });

  it('marks only the final assistant step of a multi-step response', () => {
    const ids = computeTurnEndAssistantIds([
      user('u1'),
      assistant('a-step-1'),
      assistant('a-step-2'),
      assistant('a-final'),
    ]);
    expect(ids.has('a-step-1')).toBe(false);
    expect(ids.has('a-step-2')).toBe(false);
    expect(ids.has('a-final')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('tracks a turn end per prompt even without a trailing user message', () => {
    const ids = computeTurnEndAssistantIds([
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('b1'),
      assistant('b2'),
    ]);
    expect(ids.has('a1')).toBe(true);
    expect(ids.has('b1')).toBe(false);
    expect(ids.has('b2')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('ignores messages without an assistant counterpart', () => {
    expect(computeTurnEndAssistantIds([user('u1')])).toEqual(new Set());
    expect(computeTurnEndAssistantIds([])).toEqual(new Set());
  });
});
