import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSettledResize } from './settled-resize-observer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('observeSettledResize', () => {
  it('coalesces resize deliveries across observed elements', async () => {
    vi.useFakeTimers();
    let notifyResize: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      }
    );
    const first = document.createElement('div');
    const second = document.createElement('div');
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const disposeFirst = observeSettledResize(first, firstCallback);
    const disposeSecond = observeSettledResize(second, secondCallback);
    const entries = [{ target: first }, { target: second }] as ResizeObserverEntry[];

    for (let index = 0; index < 20; index += 1) {
      notifyResize?.(entries, {} as ResizeObserver);
    }

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledOnce();

    disposeFirst();
    disposeSecond();
    expect(unobserve).toHaveBeenCalledWith(first);
    expect(unobserve).toHaveBeenCalledWith(second);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
