import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEntry } from '../types';
import {
  applyMessagePartDelta,
  clearMessages,
  clearStreamingState,
  finishMessageStreaming,
  state,
  streamingDeltaQueue,
  upsertMessage,
} from './state';
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

// The AI-08 live capture handled eight deltas during a 1,008 ms frame gap. Withholding frames must
// delay delivery without losing, reordering, or duplicating text, and must not poll for a frame.
describe('streaming deltas while frames are withheld', () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames.length = 0;
    clearMessages();
    clearStreamingState();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    // SAFETY: The fixture provides the MessageEntry fields read by these streaming helpers.
    upsertMessage({
      info: { id: 'm1', sessionID: 's1', role: 'user', time: { created: 0 } },
      parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: '' }],
    } as MessageEntry);
  });

  afterEach(() => {
    streamingDeltaQueue.reset();
    clearMessages();
    clearStreamingState();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('coalesces every delta into one request and applies them in order on the next frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    for (const chunk of ['one ', 'two ', 'three ', 'four']) {
      applyMessagePartDelta('m1', 'p1', chunk, 's1');
      vi.advanceTimersByTime(125);
    }

    // No timer or extra frame request runs while the host withholds frames.
    expect(frames).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.streamingText).toBe('');

    frames.splice(0).forEach((frame) => frame(0));

    expect(state.streamingPartId).toBe('p1');
    expect(state.streamingText).toBe('one two three four');
    expect(frames).toHaveLength(0);
  });

  it('applies withheld deltas exactly once when a later event flushes them first', () => {
    applyMessagePartDelta('m1', 'p1', 'partial ', 's1');
    applyMessagePartDelta('m1', 'p1', 'answer', 's1');

    finishMessageStreaming('m1');

    const part = state.messages[0]?.parts[0];
    expect(part?.type === 'text' ? part.text : null).toBe('partial answer');

    frames.splice(0).forEach((frame) => frame(0));

    const after = state.messages[0]?.parts[0];
    expect(after?.type === 'text' ? after.text : null).toBe('partial answer');
  });

  it('drops withheld deltas when the stream is cleared before a frame arrives', () => {
    applyMessagePartDelta('m1', 'p1', 'discarded', 's1');

    clearStreamingState();
    frames.splice(0).forEach((frame) => frame(0));

    expect(state.streamingText).toBe('');
    const part = state.messages[0]?.parts[0];
    expect(part?.type === 'text' ? part.text : null).toBe('');
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
