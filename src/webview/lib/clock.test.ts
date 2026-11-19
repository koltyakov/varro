import { flush as flushSolid, createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSecondClock } from './clock';

afterEach(() => {
  vi.useRealTimers();
});

describe('useSecondClock', () => {
  it('shares one interval and stops it after the last consumer is disposed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    flushSolid();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const first = createRoot((dispose) => ({ dispose, now: useSecondClock() }));
    flushSolid();
    const second = createRoot((dispose) => ({ dispose, now: useSecondClock() }));
    flushSolid();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(first.now()).toBe(10_000);

    vi.advanceTimersByTime(1_000);
    flushSolid();
    expect(first.now()).toBe(11_000);
    expect(second.now()).toBe(11_000);

    first.dispose();
    flushSolid();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    second.dispose();
    flushSolid();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('runs only while enabled and restarts from the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    flushSolid();
    const [enabled, setEnabled] = createSignal(false);
    const consumer = createRoot((dispose) => ({ dispose, now: useSecondClock(enabled) }));
    flushSolid();

    vi.advanceTimersByTime(5_000);
    flushSolid();
    const idleValue = consumer.now();
    expect(idleValue).toBeLessThan(55_000);

    setEnabled(true);
    flushSolid();
    expect(consumer.now()).toBe(55_000);
    vi.advanceTimersByTime(1_000);
    flushSolid();
    expect(consumer.now()).toBe(56_000);

    setEnabled(false);
    flushSolid();
    vi.advanceTimersByTime(3_000);
    flushSolid();
    expect(consumer.now()).toBe(56_000);

    consumer.dispose();
    flushSolid();
  });
});
