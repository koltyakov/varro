import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import {
  InlineMessageImage,
  getInlineImagePresentation,
  preloadInlineImageDimensions,
} from './InlineMessageImage';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function renderImage(src = 'https://example.test/image.png', allowCover?: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  cleanup = render(
    () => <InlineMessageImage src={src} alt="diagram.png" allowCover={allowCover} />,
    container!
  );
  return container.querySelector<HTMLImageElement>('.chat-image-img')!;
}

function loadImage(image: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  });
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  image.parentElement!.getBoundingClientRect = () => ({ width: 640, height: 360 }) as DOMRect;
  image.dispatchEvent(new Event('load'));
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('InlineMessageImage', () => {
  it('skips preloading when Image is unavailable', async () => {
    vi.stubGlobal('Image', undefined);

    await expect(
      preloadInlineImageDimensions('https://example.test/no-image-global.png')
    ).resolves.toBeUndefined();
  });

  it('uses cover for a sufficiently large image with a compatible crop', () => {
    const image = renderImage();

    loadImage(image, 1600, 1000);

    expect(image.classList.contains('chat-image-img-cover')).toBe(true);
    expect(container?.querySelector('.chat-image-ambient')).toBeNull();
  });

  it('contains images with ambient fill when cover is disabled', () => {
    const image = renderImage('https://example.test/tile.png', false);

    loadImage(image, 1600, 1000);

    expect(image.classList.contains('chat-image-img-ambient')).toBe(true);
    expect(container?.querySelector('.chat-image-ambient')).toBeInstanceOf(HTMLImageElement);
  });

  it('places a blurred copy behind portrait images', () => {
    const image = renderImage();

    loadImage(image, 1080, 1920);

    expect(image.classList.contains('chat-image-img-ambient')).toBe(true);
    const ambient = container?.querySelector<HTMLImageElement>('.chat-image-ambient');
    expect(ambient?.getAttribute('src')).toBe('https://example.test/image.png');
    expect(ambient?.getAttribute('alt')).toBe('');
    expect(ambient?.getAttribute('aria-hidden')).toBe('true');
  });

  it('preserves the presentation when a reconciled image remounts with the same source', () => {
    const src = 'https://example.test/reconciled-image.png';
    const image = renderImage(src);
    loadImage(image, 1080, 1920);
    expect(image.classList.contains('chat-image-img-ambient')).toBe(true);

    cleanup?.();
    container?.remove();
    cleanup = undefined;
    container = null;

    const reconciledImage = renderImage(src);

    expect(reconciledImage.classList.contains('chat-image-img-ambient')).toBe(true);
    expect(reconciledImage.parentElement?.querySelector('.chat-image-ambient')).toBeInstanceOf(
      HTMLImageElement
    );
  });

  it('uses decoded dimensions before painting an existing-session image', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1080);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1920);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 640, 360)
    );

    const image = renderImage('https://example.test/existing-session-image.png');

    expect(image.classList.contains('chat-image-img-ambient')).toBe(true);
    expect(image.parentElement?.querySelector('.chat-image-ambient')).toBeInstanceOf(
      HTMLImageElement
    );
  });

  it('uses dimensions decoded by the composer before mounting the sent image', async () => {
    class DecodedImage {
      src = '';
      naturalWidth = 1080;
      naturalHeight = 1920;

      async decode() {}
    }
    vi.stubGlobal('Image', DecodedImage);
    const src = 'data:image/png;base64,composer-handoff';

    await preloadInlineImageDimensions(src);
    const image = renderImage(src);

    expect(image.classList.contains('chat-image-img-ambient')).toBe(true);
  });

  it('abandons an image decode that does not settle', async () => {
    vi.useFakeTimers();
    class StalledImage {
      static latest: StalledImage | undefined;
      private value = '';
      naturalWidth = 0;
      naturalHeight = 0;

      constructor() {
        StalledImage.latest = this;
      }

      get src() {
        return this.value;
      }

      set src(value: string) {
        this.value = value;
      }

      decode() {
        return new Promise<void>(() => {});
      }
    }
    vi.stubGlobal('Image', StalledImage);

    const preload = preloadInlineImageDimensions('data:image/png;base64,stalled');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(preload).resolves.toBeUndefined();
    expect(StalledImage.latest?.src).toBe('');
  });

  it('keeps small landscape images contained instead of upscaling them to cover', () => {
    const image = renderImage();

    loadImage(image, 320, 180);

    expect(image.classList.contains('chat-image-img-contain')).toBe(true);
    expect(container?.querySelector('.chat-image-ambient')).toBeNull();
  });
});

describe('getInlineImagePresentation', () => {
  it('uses ambient fill when cover would crop too much of a large image', () => {
    expect(getInlineImagePresentation(3000, 1000, 640, 360)).toBe('ambient');
  });

  it('uses ambient fill around a small image with a mismatched aspect ratio', () => {
    expect(getInlineImagePresentation(400, 320, 640, 360)).toBe('ambient');
  });
});
