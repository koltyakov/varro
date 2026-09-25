import { createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSecondClock } from './clock';

afterEach(() => {
  vi.useRealTimers();
});

describe('useSecondClock', () => {
  it('shares one interval and stops it after the last consumer is disposed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const first = createRoot((dispose) => ({ dispose, now: useSecondClock() }));
    const second = createRoot((dispose) => ({ dispose, now: useSecondClock() }));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(first.now()).toBe(10_000);

    vi.advanceTimersByTime(1_000);
    expect(first.now()).toBe(11_000);
    expect(second.now()).toBe(11_000);

    first.dispose();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    second.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('runs only while enabled and restarts from the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const [enabled, setEnabled] = createSignal(false);
    const consumer = createRoot((dispose) => ({ dispose, now: useSecondClock(enabled) }));

    vi.advanceTimersByTime(5_000);
    const idleValue = consumer.now();
    expect(idleValue).toBeLessThan(55_000);

    setEnabled(true);
    expect(consumer.now()).toBe(55_000);
    vi.advanceTimersByTime(1_000);
    expect(consumer.now()).toBe(56_000);

    setEnabled(false);
    vi.advanceTimersByTime(3_000);
    expect(consumer.now()).toBe(56_000);

    consumer.dispose();
  });
});
