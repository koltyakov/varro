import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { InlineMessageImage, getInlineImagePresentation } from './InlineMessageImage';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function renderImage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  cleanup = render(
    () => <InlineMessageImage src="https://example.test/image.png" alt="diagram.png" />,
    container!
  );
  return container.querySelector<HTMLImageElement>('.chat-image-img')!;
}

function loadImage(image: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  });
  image.parentElement!.getBoundingClientRect = () => ({ width: 640, height: 360 }) as DOMRect;
  image.dispatchEvent(new Event('load'));
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

describe('InlineMessageImage', () => {
  it('uses cover for a sufficiently large image with a compatible crop', () => {
    const image = renderImage();

    loadImage(image, 1600, 1000);

    expect(image.classList.contains('chat-image-img-cover')).toBe(true);
    expect(container?.querySelector('.chat-image-ambient')).toBeNull();
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
