import { describe, expect, it, vi } from 'vitest';
import { createStreamingDeltaQueue, shouldUseStreamingText } from './streaming-deltas';

function captureSchedule() {
  const callbacks: Array<() => void> = [];
  const scheduleFrame = (cb: () => void) => {
    callbacks.push(cb);
  };
  const drain = () => {
    const copy = callbacks.splice(0);
    copy.forEach((cb) => cb());
  };
  return { scheduleFrame, drain, pendingCount: () => callbacks.length };
}

function textDelta(item: { messageId: string; partId: string; sessionId?: string; text: string }) {
  return { ...item, partType: 'text' as const, partStartedAt: 0 };
}

describe('createStreamingDeltaQueue', () => {
  it('uses a timer when requestAnimationFrame is unavailable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);

    try {
      q.scheduleFlush();
      expect(flush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('stores and retrieves deltas by partId', () => {
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);
    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'hello' }));

    expect(q.get('p1')).toEqual(textDelta({ messageId: 'm1', partId: 'p1', text: 'hello' }));
    expect(q.get('missing')).toBeUndefined();
  });

  it('overwrites existing entry with the same partId on set', () => {
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);
    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'a' }));
    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'b' }));

    expect(q.get('p1')).toEqual(textDelta({ messageId: 'm1', partId: 'p1', text: 'b' }));
  });

  it('bump updates text for an existing partId', () => {
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);
    q.set(textDelta({ messageId: 'm1', partId: 'p1', sessionId: 's1', text: 'old' }));
    const result = q.bump('p1', 'new');

    expect(result).toEqual(
      textDelta({ messageId: 'm1', partId: 'p1', sessionId: 's1', text: 'new' })
    );
    expect(q.get('p1')).toEqual(
      textDelta({ messageId: 'm1', partId: 'p1', sessionId: 's1', text: 'new' })
    );
  });

  it('bump returns null for unknown partId', () => {
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);

    expect(q.bump('missing', 'text')).toBeNull();
  });

  it('takeAll drains all pending deltas', () => {
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush);
    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'a' }));
    q.set(textDelta({ messageId: 'm2', partId: 'p2', text: 'b' }));

    const items = q.takeAll();
    expect(items).toHaveLength(2);
    expect(items.map((d) => d.partId).toSorted()).toEqual(['p1', 'p2']);
    expect(q.takeAll()).toEqual([]);
  });

  it('clears pending deltas and increments generation on reset', () => {
    const { scheduleFrame, drain, pendingCount } = captureSchedule();
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush, scheduleFrame);

    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'a' }));
    q.scheduleFlush();
    expect(pendingCount()).toBe(1);

    q.reset();
    expect(q.takeAll()).toEqual([]);

    drain();
    expect(flush).not.toHaveBeenCalled();
  });

  it('scheduleFlush calls flush exactly once per frame', () => {
    const { scheduleFrame, drain, pendingCount } = captureSchedule();
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush, scheduleFrame);

    q.scheduleFlush();
    q.scheduleFlush();
    q.scheduleFlush();
    expect(pendingCount()).toBe(1);

    drain();
    expect(flush).toHaveBeenCalledTimes(1);

    q.scheduleFlush();
    expect(pendingCount()).toBe(1);
    drain();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('stale scheduled flush is skipped after reset', () => {
    const { scheduleFrame, drain } = captureSchedule();
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush, scheduleFrame);

    q.scheduleFlush();
    q.reset();
    drain();

    expect(flush).not.toHaveBeenCalled();

    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'fresh' }));
    q.scheduleFlush();
    drain();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(q.takeAll()).toEqual([textDelta({ messageId: 'm1', partId: 'p1', text: 'fresh' })]);
  });

  it('takeAll resets flushScheduled so next scheduleFlush queues again', () => {
    const { scheduleFrame, drain } = captureSchedule();
    const flush = vi.fn();
    const q = createStreamingDeltaQueue(flush, scheduleFrame);

    q.set(textDelta({ messageId: 'm1', partId: 'p1', text: 'a' }));
    q.scheduleFlush();
    drain();
    expect(flush).toHaveBeenCalledTimes(1);

    q.takeAll();
    q.set(textDelta({ messageId: 'm2', partId: 'p2', text: 'b' }));
    q.scheduleFlush();
    drain();
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

// shouldUseStreamingText is the guard that decides whether streaming text may
// overwrite committed part text. Its exact asymmetry matters: streamed text
// must only ever extend what the user already sees. Loosening any of these
// cases reintroduces text rollback or wipes during snapshot races.
describe('shouldUseStreamingText', () => {
  it('accepts identical text', () => {
    expect(shouldUseStreamingText('abc', 'abc')).toBe(true);
  });

  it('accepts a strict extension of the committed text', () => {
    expect(shouldUseStreamingText('abc', 'abcdef')).toBe(true);
  });

  it('accepts any streaming text when nothing is committed yet', () => {
    expect(shouldUseStreamingText('', 'abc')).toBe(true);
  });

  it('rejects empty streaming text so committed text is never wiped', () => {
    expect(shouldUseStreamingText('abc', '')).toBe(false);
  });

  it('rejects stale streaming text shorter than the committed text', () => {
    expect(shouldUseStreamingText('abcdef', 'abc')).toBe(false);
  });

  it('rejects divergent streaming text even when longer', () => {
    expect(shouldUseStreamingText('abc', 'abX-longer-but-diverged')).toBe(false);
  });
});
