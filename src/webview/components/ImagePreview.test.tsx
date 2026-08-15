import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ImagePreviewOverlay } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';

const image: PreviewImage = {
  url: 'data:image/png;base64,AAAA',
  alt: 'Screenshot',
  title: 'screenshot.png',
  mime: 'image/png',
};

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

function overlay() {
  return document.querySelector<HTMLElement>('.chat-image-preview-overlay');
}

describe('ImagePreviewOverlay focus management', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it('moves focus into the dialog when it opens', async () => {
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    await Promise.resolve();

    const close = overlay()?.querySelector('.chat-image-preview-close');
    expect(document.activeElement).toBe(close);
  });

  it('keeps Tab inside the dialog instead of escaping to the page behind it', () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);

    dispose = render(
      () => (
        <ImagePreviewOverlay
          image={image}
          onClose={() => {}}
          onPrevious={() => {}}
          onNext={() => {}}
          showNavigation
        />
      ),
      container
    );

    const focusable = Array.from(overlay()!.querySelectorAll('button'));
    expect(focusable.length).toBeGreaterThan(1);

    const last = focusable[focusable.length - 1]!;
    last.focus();
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );

    expect(document.activeElement).toBe(focusable[0]);
    expect(document.activeElement).not.toBe(outside);
  });

  it('returns focus to the opener when the overlay closes', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();

    const [current, setCurrent] = createSignal<PreviewImage | null>(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    await Promise.resolve();
    expect(document.activeElement).not.toBe(opener);

    setCurrent(null);

    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes from side clicks but not clicks on the image figure', () => {
    const onClose = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);

    overlay()
      ?.querySelector('.chat-image-preview-overlay-inner')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();

    overlay()
      ?.querySelector('.chat-image-preview-figure')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
