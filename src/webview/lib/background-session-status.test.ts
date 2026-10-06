import { createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../types';
import { createPendingBackgroundSessionIds } from './background-session-status';

afterEach(() => vi.useRealTimers());

describe('pending background sessions', () => {
  it('switches at one minute, stops scheduling once pending, and resets on active work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const [statuses, setStatuses] = createSignal<Record<string, SessionStatus>>({
      waiting: { type: 'busy', background: true, backgroundStartedAt: 100_000 },
      active: { type: 'busy' },
      retry: { type: 'retry', attempt: 1, message: 'Retry', next: 100_000 },
    });
    const consumer = createRoot((dispose) => ({
      dispose,
      pending: createPendingBackgroundSessionIds(statuses),
    }));
    expect(consumer.pending().size).toBe(0);
    vi.advanceTimersByTime(59_999);
    expect(consumer.pending().size).toBe(0);
    vi.advanceTimersByTime(1);
    expect([...consumer.pending()]).toEqual(['waiting']);
    expect(vi.getTimerCount()).toBe(0);

    setStatuses({ waiting: { type: 'busy' } });
    expect(consumer.pending().size).toBe(0);
    setStatuses({ waiting: { type: 'busy', background: true } });
    vi.advanceTimersByTime(59_999);
    expect(consumer.pending().size).toBe(0);
    vi.advanceTimersByTime(1);
    expect([...consumer.pending()]).toEqual(['waiting']);
    setStatuses({ waiting: { type: 'idle' } });
    expect(consumer.pending().size).toBe(0);
    consumer.dispose();
  });

  it('restores old waits immediately and cancels unfinished timers on disposal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const consumer = createRoot((dispose) => ({
      dispose,
      pending: createPendingBackgroundSessionIds(() => ({
        old: { type: 'busy', background: true, backgroundStartedAt: 1 },
        recent: { type: 'busy', background: true, backgroundStartedAt: 90_000 },
      })),
    }));
    expect([...consumer.pending()]).toEqual(['old']);
    expect(vi.getTimerCount()).toBe(1);
    consumer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
