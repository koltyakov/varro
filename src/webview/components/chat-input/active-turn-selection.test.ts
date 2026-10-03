import { describe, expect, it } from 'vitest';
import type { MessageEntry, UserMessage } from '../../types';
import { getActiveTurnSelection, matchesActiveTurnSelection } from './active-turn-selection';

const model = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
function user(overrides: Partial<UserMessage> = {}): MessageEntry {
  return {
    info: {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model,
      ...overrides,
    },
    parts: [],
  };
}

describe('active turn selection', () => {
  it('requires matching agent, provider, model and normalized reasoning', () => {
    const messages = [user()];
    expect(matchesActiveTurnSelection(messages, 'session-1', 'build', model)).toBe(true);
    expect(matchesActiveTurnSelection(messages, 'session-1', 'plan', model)).toBe(false);
    expect(
      matchesActiveTurnSelection(messages, 'session-1', 'build', { ...model, providerID: 'other' })
    ).toBe(false);
    expect(
      matchesActiveTurnSelection(messages, 'session-1', 'build', { ...model, modelID: 'other' })
    ).toBe(false);
    expect(
      matchesActiveTurnSelection(messages, 'session-1', 'build', { ...model, variant: 'xhigh' })
    ).toBe(false);
    expect(
      matchesActiveTurnSelection(
        [user({ model: { ...model, variant: 'default' } })],
        'session-1',
        'build',
        { ...model, variant: undefined }
      )
    ).toBe(true);
  });

  it('ignores children, queued inbox messages and steers when identifying a turn', () => {
    const changed = { ...model, variant: 'xhigh' };
    const messages = [
      user(),
      user({ sessionID: 'child', agent: 'plan', model: changed }),
      user({ pendingDelivery: 'queue', model: changed }),
      user({ delivery: 'steer', model: changed }),
    ];
    expect(matchesActiveTurnSelection(messages, 'session-1', 'build', model)).toBe(true);
    expect(matchesActiveTurnSelection(messages, 'session-1', 'build', changed)).toBe(false);
  });

  it('uses assistant settings and falls back to its parent for missing agent and reasoning', () => {
    const messages: MessageEntry[] = [
      user(),
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          parentID: 'user-1',
          time: { created: 2 },
          providerID: model.providerID,
          modelID: model.modelID,
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ];
    expect(matchesActiveTurnSelection(messages, 'session-1', 'build', model)).toBe(true);
  });

  it('does not allow steering with unknown turn settings', () => {
    expect(matchesActiveTurnSelection([], 'session-1', 'build', model)).toBe(false);
    expect(matchesActiveTurnSelection([user()], 'session-1', null, model)).toBe(false);
    expect(matchesActiveTurnSelection([user()], 'session-1', 'build', null)).toBe(false);
  });

  it('does not subscribe active-turn selection to distant historical message metadata', () => {
    let historyReads = 0;
    const history = Array.from({ length: 6000 }, (_, index) => {
      const message = user({ id: `history-${index}` });
      return {
        get info() {
          historyReads += 1;
          return message.info;
        },
        parts: message.parts,
      };
    });
    const messages: MessageEntry[] = [
      ...history,
      user(),
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          parentID: 'user-1',
          time: { created: 2 },
          providerID: model.providerID,
          modelID: model.modelID,
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
      user({ sessionID: 'child', model: { ...model, variant: 'xhigh' } }),
      user({ id: 'steer', delivery: 'steer', model: { ...model, variant: 'xhigh' } }),
    ];

    expect(getActiveTurnSelection(messages, 'session-1')).toEqual({ agent: 'build', model });
    expect(historyReads).toBe(0);
  });
});
