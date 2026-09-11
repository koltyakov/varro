/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Test fixtures cross the generic persistence and validated event boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import type { ServerEvent } from '../shared/protocol';
import { StreamingTextCache } from './streaming-text-cache';

// oxlint-disable-next-line anti-slop/no-module-mocking -- The host logger requires VS Code's output channel, which is unavailable in unit tests.
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));

const info = { id: 'message-1', sessionID: 'session-1', role: 'assistant', time: { created: 1 } };
const part = {
  id: 'part-1',
  messageID: info.id,
  sessionID: info.sessionID,
  type: 'text',
  text: '',
  time: { start: 1 },
};

function setup() {
  let stored: unknown;
  const persistence: Persistence = {
    get: <T>() => stored as T | undefined,
    set: (_key, value) => {
      stored = structuredClone(value);
    },
    remove: () => {
      stored = undefined;
    },
  };
  const cache = new StreamingTextCache(persistence);
  return { cache, persistence };
}

function delta(cache: StreamingTextCache, text: string) {
  cache.observe({
    type: 'message.part.delta',
    properties: {
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
      field: 'text',
      delta: text,
    },
  });
}

afterEach(() => vi.useRealTimers());

describe('StreamingTextCache', () => {
  it('restores the beginning on repeated history reads and after a host reload', async () => {
    vi.useFakeTimers();
    const { cache, persistence } = setup();
    cache.observe({ type: 'message.part.updated', properties: { part } } as ServerEvent);
    delta(cache, '# Beginning\n\n');
    delta(cache, 'Still streaming');
    expect(cache.restore(info, [part])[0]?.text).toBe('# Beginning\n\nStill streaming');
    expect(part.text).toBe('');
    await vi.advanceTimersByTimeAsync(250);

    const reloaded = new StreamingTextCache(persistence);
    expect(reloaded.restore(info, [part])[0]?.text).toBe('# Beginning\n\nStill streaming');
    delta(reloaded, ' more');
    expect(reloaded.restore(info, [part])[0]?.text).toBe('# Beginning\n\nStill streaming more');
    expect(reloaded.restore(info, [part])[0]?.text).toBe('# Beginning\n\nStill streaming more');
    await reloaded.flush();
  });

  it('preserves longer snapshots, authoritative final text, and session boundaries', async () => {
    const { cache } = setup();
    delta(cache, 'Beginning');
    expect(cache.restore(info, [{ ...part, text: 'Beginning and more' }])[0]?.text).toBe(
      'Beginning and more'
    );
    expect(
      cache.restore(info, [{ ...part, text: 'Edited', time: { start: 1, end: 2 } }])[0]?.text
    ).toBe('Edited');
    expect(cache.restore({ ...info, time: { created: 1, completed: 2 } }, [part])).toEqual([part]);
    expect(cache.restore({ ...info, sessionID: 'other-session' }, [])).toEqual([]);
    expect(cache.restore({ ...info, id: 'other-message' }, [])).toEqual([]);
    cache.observe({
      type: 'message.part.updated',
      properties: {
        part: { ...part, text: 'Final response', time: { start: 1, end: 2 } },
      },
    } as ServerEvent);
    expect(cache.restore(info, [part])).toEqual([part]);
    await cache.flush();
  });

  it('restores projected text absent from a snapshot and removes deleted parts', async () => {
    const { cache } = setup();
    cache.observe({
      type: 'session.next.text.delta',
      properties: {
        sessionID: info.sessionID,
        assistantMessageID: info.id,
        textID: part.id,
        delta: 'Beginning',
      },
    } as ServerEvent);
    expect(cache.restore(info, [])).toEqual([
      expect.objectContaining({ id: part.id, type: 'text', text: 'Beginning' }),
    ]);
    cache.observe({
      type: 'message.part.removed',
      properties: {
        sessionID: info.sessionID,
        messageID: info.id,
        partID: part.id,
      },
    });
    expect(cache.restore(info, [])).toEqual([]);
    await cache.flush();
  });

  it('expires abandoned streams', async () => {
    vi.useFakeTimers();
    const { cache, persistence } = setup();
    delta(cache, 'Abandoned');
    await cache.flush();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(new StreamingTextCache(persistence).restore(info, [])).toEqual([]);
  });
});
