import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadImage } from './image-loading';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loadImage', () => {
  it('resolves decoded images', async () => {
    class DecodedImage extends EventTarget {
      set src(_url: string) {
        queueMicrotask(() => this.dispatchEvent(new Event('load')));
      }
    }
    vi.stubGlobal('Image', DecodedImage);
    expect(await loadImage('data:image/gif;base64,valid')).toBeInstanceOf(DecodedImage);
  });

  it('reports decode failures and clears the timeout', async () => {
    vi.useFakeTimers();
    class BrokenImage extends EventTarget {
      set src(_url: string) {
        this.dispatchEvent(new Event('error'));
      }
    }
    vi.stubGlobal('Image', BrokenImage);
    await expect(loadImage('data:image/gif;base64,broken')).rejects.toThrow(
      'Could not decode the image'
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds image decoding waits', async () => {
    vi.useFakeTimers();
    class PendingImage extends EventTarget {
      src = '';
    }
    vi.stubGlobal('Image', PendingImage);
    const result = expect(loadImage('blob:pending')).rejects.toThrow(
      'Timed out decoding the image'
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
