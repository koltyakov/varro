import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSettledResize } from './settled-resize-observer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('observeSettledResize', () => {
  it('coalesces resize deliveries for each observed element', async () => {
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

  it('does not let one resizing element postpone another element', async () => {
    vi.useFakeTimers();
    let notifyResize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const first = document.createElement('div');
    const second = document.createElement('div');
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const disposeFirst = observeSettledResize(first, firstCallback);
    const disposeSecond = observeSettledResize(second, secondCallback);

    notifyResize?.(
      [{ target: first }, { target: second }] as ResizeObserverEntry[],
      {} as ResizeObserver
    );
    await vi.advanceTimersByTimeAsync(50);
    notifyResize?.([{ target: first }] as ResizeObserverEntry[], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(50);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(50);
    expect(firstCallback).toHaveBeenCalledOnce();

    disposeFirst();
    disposeSecond();
  });

  it('cancels only the disposed element callback', async () => {
    vi.useFakeTimers();
    let notifyResize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      }
    );
    const first = document.createElement('div');
    const second = document.createElement('div');
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const disposeFirst = observeSettledResize(first, firstCallback);
    const disposeSecond = observeSettledResize(second, secondCallback);

    notifyResize?.(
      [{ target: first }, { target: second }] as ResizeObserverEntry[],
      {} as ResizeObserver
    );
    disposeFirst();
    await vi.advanceTimersByTimeAsync(100);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();

    notifyResize?.([{ target: second }] as ResizeObserverEntry[], {} as ResizeObserver);
    disposeSecond();
    await vi.advanceTimersByTimeAsync(100);

    expect(secondCallback).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
