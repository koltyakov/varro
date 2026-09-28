import { describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry, Part, UserMessage } from '../../types';
import {
  getFrozenSegmentBoundary,
  getHistorySegmentEnd,
  mergeSegmentMaps,
  restrictPartKeys,
  restrictStreamingProjection,
  sameStreamingProjection,
} from './history-segments';

function user(id: string, parts: Part[]): MessageEntry {
  const info: UserMessage = {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
  return { info, parts };
}

function assistant(id: string): MessageEntry {
  const info: AssistantMessage = {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts: [] };
}

function text(id: string, messageID: string, value: string, synthetic = false): Part {
  return { id, messageID, sessionID: 'session-1', type: 'text', text: value, synthetic };
}

describe('history segments', () => {
  it('splits at the last prompt that still renders as a user message', () => {
    const prompt = user('user-2', [text('prompt-2', 'user-2', 'Second prompt')]);
    const automatic = user('automatic', [
      text(
        'completion',
        'automatic',
        '<shell id="sh_1" state="failed" command="npm test">Failure</shell>',
        true
      ),
    ]);

    expect(
      getHistorySegmentEnd([
        user('user-1', [text('prompt-1', 'user-1', 'First prompt')]),
        assistant('assistant-1'),
        prompt,
        assistant('assistant-2'),
        automatic,
      ])
    ).toBe(2);
    expect(getHistorySegmentEnd([assistant('assistant-1'), automatic])).toBe(0);
  });

  it('keeps a frozen boundary until enough newer history accumulates', () => {
    const transcript = (turns: number) =>
      Array.from({ length: turns }, (_, turn) => [
        user(`user-${turn}`, [text(`prompt-${turn}`, `user-${turn}`, `Prompt ${turn}`)]),
        assistant(`assistant-${turn}`),
      ]).flat();
    const empty = { entry: null, index: 0 };

    expect(getFrozenSegmentBoundary(transcript(300), 598, empty)).toBe(empty);

    const messages = transcript(1000);
    const frozen = getFrozenSegmentBoundary(messages, 1200, empty);
    expect(frozen.index).toBe(800);
    expect(frozen.entry).toBe(messages[800]);
    expect(getFrozenSegmentBoundary(messages, 1598, frozen)).toBe(frozen);
    expect(getFrozenSegmentBoundary(messages, 1600, frozen).index).toBe(1200);

    const prepended = [assistant('older'), ...messages];
    expect(getFrozenSegmentBoundary(prepended, 1201, frozen).index).toBe(801);
  });

  it('keeps only history-owned streaming state', () => {
    const projection = restrictStreamingProjection(
      {
        partId: 'tail-text',
        text: 'x',
        textByPartId: new Map([
          ['history-text', ''],
          ['tail-text', 'x'],
        ]),
        hiddenPartKeys: new Set(['history\u0000history-text', 'tail\u0000tail-text']),
      },
      new Set(['history-text']),
      new Set(['history'])
    );

    expect(projection).toEqual({
      partId: null,
      text: '',
      textByPartId: new Map([['history-text', '']]),
      hiddenPartKeys: new Set(['history\u0000history-text']),
    });
    expect(
      sameStreamingProjection(projection, {
        ...projection,
        textByPartId: new Map(projection.textByPartId),
        hiddenPartKeys: new Set(projection.hiddenPartKeys),
      })
    ).toBe(true);
    expect(restrictPartKeys(new Set(['tail\u0000part']), new Set(['history'])).size).toBe(0);
  });

  it('merges segment maps in transcript order', () => {
    expect([
      ...mergeSegmentMaps(
        new Map([
          ['history-1', 1],
          ['history-2', 2],
        ]),
        new Map([['tail-1', 3]])
      ).keys(),
    ]).toEqual(['history-1', 'history-2', 'tail-1']);
  });
});
