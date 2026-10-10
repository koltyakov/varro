import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ImagePreviewOverlay } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';
import { navArrowLeftIcon, navArrowRightIcon, xmarkIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';
import { fixture } from '../test-fixtures';
import { IMAGE_PLACEHOLDER } from '../lib/deferred-content';

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
    expect(
      close?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(xmarkIcon));
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
    expect(
      focusable
        .slice(1)
        .map((button) =>
          button.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
        )
    ).toEqual([toCssUrl(navArrowLeftIcon), toCssUrl(navArrowRightIcon)]);

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

describe('ImagePreviewOverlay image copying', () => {
  const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>();
  let originalClipboard: Clipboard;
  let encode: BlobCallback;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    write.mockReset().mockResolvedValue();
    vi.stubGlobal(
      'ClipboardItem',
      class {
        readonly types = ['image/png'];
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fixture<CanvasRenderingContext2D>({ drawImage: vi.fn() })
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      encode = callback;
    });
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function openMenu(loaded = true) {
    const element = overlay()!.querySelector<HTMLImageElement>('img')!;
    if (loaded) {
      Object.defineProperties(element, {
        naturalWidth: { value: 1920, configurable: true },
        naturalHeight: { value: 1080, configurable: true },
      });
      element.dispatchEvent(new Event('load'));
    }
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 150,
    });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    return overlay()!.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  }

  it('copies the image from its context menu without closing the preview', async () => {
    const onClose = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);
    await Promise.resolve();
    const button = openMenu();
    expect(button.textContent).toBe('Copy image');
    expect(document.activeElement).toBe(button);
    button.click();
    expect(write).toHaveBeenCalledOnce();
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
    expect(overlay()!.querySelector('[role="status"]')?.textContent).toBe('Copying image…');
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(overlay()!.querySelector('[role="status"]')?.textContent).toBe('Image copied')
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables copying until the original is loaded and never copies placeholders', () => {
    const [current, setCurrent] = createSignal(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    expect(openMenu(false).disabled).toBe(true);
    setCurrent({ ...image, url: IMAGE_PLACEHOLDER });
    expect(openMenu().disabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('dismisses the menu on Escape without closing the image dialog', async () => {
    const onClose = vi.fn();
    const escaped = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);
    await Promise.resolve();
    window.addEventListener('keydown', escaped);
    try {
      openMenu().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(overlay()!.querySelector('.chat-image-preview-close'));
      expect(escaped).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', escaped);
    }
  });

  it('dismisses the menu when clicking outside it', () => {
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    openMenu();
    overlay()!
      .querySelector('img')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
  });

  it('reports clipboard errors in the preview', async () => {
    write.mockRejectedValue(new Error('Clipboard permission denied'));
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    openMenu().click();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(overlay()!.querySelector('[role="alert"]')?.textContent).toBe(
        'Clipboard permission denied'
      )
    );
  });

  it('clears the menu and ignores old copy results when navigating to another image', async () => {
    const [current, setCurrent] = createSignal(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    openMenu().click();
    setCurrent({ ...image, url: 'data:image/jpeg;base64,BBBB', title: 'next.jpg' });
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
    expect(openMenu(false).disabled).toBe(true);
    setCurrent(image);
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
  });
});
