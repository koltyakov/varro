import { describe, expect, it } from 'vitest';
import type { AssistantMessage, FileDiff, Message, Part, Provider } from '../types';
import {
  getAssistantDiffRequest,
  formatCost,
  formatDuration,
  formatNumber,
  formatRelativeAge,
  getAssistantDuration,
  getAssistantTotalTokens,
  getContextWindow,
  getStepFinishParts,
  getTaskDiffs,
  isAssistantMessage,
  sumAssistantTokens,
  sumSessionCost,
} from './message-metrics';

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'assistant-1',
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1_000, completed: 3_500 },
    parentID: 'parent-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'primary',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 25,
      cache: { read: 10, write: 5 },
    },
    ...overrides,
  };
}

describe('message metrics helpers', () => {
  it('identifies assistant messages', () => {
    const message: Message = assistantMessage();
    expect(isAssistantMessage(message)).toBe(true);
    expect(
      isAssistantMessage({
        id: 'user-1',
        sessionID: 'session-1',
        role: 'user',
        time: { created: 0 },
        agent: 'coder',
        model: { providerID: 'provider-1', modelID: 'model-1' },
      })
    ).toBe(false);
  });

  it('formats numbers and durations across thresholds', () => {
    expect(formatNumber(undefined)).toBe('0');
    expect(formatNumber(1_234.4)).toBe('1,234');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1_500)).toBe('2s');
    expect(formatDuration(9_500)).toBe('10s');
    expect(formatDuration(15_000)).toBe('15s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
    expect(formatDuration(172_800_000)).toBe('2d');
  });

  it('formats cost values', () => {
    expect(formatCost(undefined)).toBe('');
    expect(formatCost(0)).toBe('');
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(0.05)).toBe('$0.05');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(12.345)).toBe('$12.35');
  });

  it('sums session cost across assistant messages', () => {
    const messages = [
      assistantMessage({ cost: 0.5 }),
      assistantMessage({ id: 'assistant-2', cost: 1.25 }),
    ];
    expect(sumSessionCost(messages)).toBeCloseTo(1.75);
    expect(sumSessionCost([])).toBe(0);
  });

  it('computes assistant token totals with and without explicit totals', () => {
    const withExplicit = assistantMessage({
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 }, total: 99 },
    });
    const inferred = assistantMessage();
    expect(getAssistantTotalTokens(withExplicit)).toBe(99);
    expect(getAssistantTotalTokens(inferred)).toBe(190);
  });

  it('sums token usage across assistant messages', () => {
    const total = sumAssistantTokens([
      assistantMessage(),
      assistantMessage({
        id: 'assistant-2',
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      }),
    ]);

    expect(total).toEqual({
      total: 205,
      input: 101,
      output: 52,
      reasoning: 28,
      cacheRead: 14,
      cacheWrite: 10,
    });
  });

  it('computes durations and context window usage', () => {
    const message = assistantMessage();
    const providers: Provider[] = [
      {
        id: 'provider-1',
        name: 'Provider',
        source: 'custom',
        models: {
          'model-1': {
            id: 'model-1',
            name: 'Model',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 200, output: 100 },
          },
        },
      },
    ];

    expect(getAssistantDuration(message)).toBe(2_500);
    expect(getContextWindow(message, providers)).toEqual({ used: 190, limit: 200, percent: 95 });
    expect(getContextWindow(message, [])).toBeNull();
  });

  it('builds diff requests only for completed last assistant messages', () => {
    expect(getAssistantDiffRequest(assistantMessage(), true)).toEqual({
      sessionID: 'session-1',
      messageID: 'assistant-1',
    });
    expect(getAssistantDiffRequest(assistantMessage(), false)).toBeNull();
    expect(
      getAssistantDiffRequest(assistantMessage({ time: { created: 1_000 } }), true)
    ).toBeNull();
    expect(
      getAssistantDiffRequest(
        {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 0 },
          agent: 'coder',
          model: { providerID: 'provider-1', modelID: 'model-1' },
        },
        true
      )
    ).toBeNull();
  });

  it('selects step finish parts and task diffs', () => {
    const stepFinish: Part = {
      id: 'finish-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'step-finish',
      reason: 'done',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const parts: Part[] = [
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'hello',
      },
      stepFinish,
    ];
    const diffs: FileDiff[] = [
      { file: 'src/app.ts', before: '', after: 'x', additions: 1, deletions: 0 },
    ];

    expect(getStepFinishParts(parts)).toEqual([stepFinish]);
    expect(
      getTaskDiffs(
        {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 0 },
          summary: { diffs },
          agent: 'coder',
          model: { providerID: 'provider-1', modelID: 'model-1' },
        },
        []
      )
    ).toEqual(diffs);
    expect(getTaskDiffs(assistantMessage(), diffs)).toEqual(diffs);
  });

  it('formats relative age across all thresholds', () => {
    const now = 1_000_000_000;
    expect(formatRelativeAge(now, now)).toBe('now');
    expect(formatRelativeAge(now - 30_000, now)).toBe('now');
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe('5m');
    expect(formatRelativeAge(now - 59 * 60_000, now)).toBe('59m');
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeAge(now - 23 * 3_600_000, now)).toBe('23h');
    expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe('2d');
    expect(formatRelativeAge(now - 6 * 86_400_000, now)).toBe('6d');
    expect(formatRelativeAge(now - 7 * 86_400_000, now)).toBe('1w');
    expect(formatRelativeAge(now - 14 * 86_400_000, now)).toBe('2w');
    expect(formatRelativeAge(now - 30 * 86_400_000, now)).toBe('4w');
  });

  it('clamps future timestamps to now in relative age', () => {
    const now = 1_000_000_000;
    expect(formatRelativeAge(now + 60_000, now)).toBe('now');
  });
});
