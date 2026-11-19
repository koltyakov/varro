import { flush as flushSolid, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { ImagePreviewOverlay } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';
import { checkIcon, navArrowLeftIcon, navArrowRightIcon, xmarkIcon } from '../lib/ui-icons';
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
    flushSolid();
    dispose = undefined;
    document.body.replaceChildren();
    flushSolid();
  });

  it('moves focus into the dialog when it opens', async () => {
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    flushSolid();

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
    flushSolid();
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );
    flushSolid();

    expect(document.activeElement).toBe(focusable[0]);
    expect(document.activeElement).not.toBe(outside);
  });

  it('returns focus to the opener when the overlay closes', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();
    flushSolid();

    const [current, setCurrent] = createSignal<PreviewImage | null>(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(document.activeElement).not.toBe(opener);

    setCurrent(null);
    flushSolid();

    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes from side clicks but not clicks on the image figure', () => {
    const onClose = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);
    flushSolid();

    overlay()
      ?.querySelector('.chat-image-preview-overlay-inner')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(onClose).toHaveBeenCalledOnce();

    overlay()
      ?.querySelector('.chat-image-preview-figure')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
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
    flushSolid();
    dispose = undefined;
    document.body.replaceChildren();
    flushSolid();
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    vi.restoreAllMocks();
    flushSolid();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    flushSolid();
    expect(event.defaultPrevented).toBe(true);
    return overlay()!.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  }

  it('copies the image without closing the preview or changing its figure content', async () => {
    let finishWrite!: () => void;
    write.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      })
    );
    const onClose = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const button = openMenu();
    flushSolid();
    const figure = overlay()!.querySelector('.chat-image-preview-figure')!;
    const figureContent = figure.innerHTML;
    expect(button.textContent).toBe('Copy image');
    expect(document.activeElement).toBe(button);
    button.click();
    flushSolid();
    expect(write).toHaveBeenCalledOnce();
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
    expect(figure.innerHTML).toBe(figureContent);
    const pendingCopyButton = openMenu();
    flushSolid();
    expect(pendingCopyButton.disabled).toBe(true);
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
    finishWrite();
    await vi.waitFor(() => expect(pendingCopyButton.disabled).toBe(false));
    flushSolid();
    expect(figure.innerHTML).toBe(figureContent);
    const feedback = overlay()!.querySelector('[role="status"]');
    expect(feedback?.textContent).toBe('Image copied');
    expect(feedback?.classList.contains('session-action-feedback')).toBe(true);
    expect(feedback?.getAttribute('aria-live')).toBe('polite');
    expect(
      feedback?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(checkIcon));
    expect(figure.contains(feedback)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses successful copy feedback automatically', async () => {
    vi.useFakeTimers();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    flushSolid();
    openMenu().click();
    flushSolid();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(overlay()!.querySelector('[role="status"]')?.textContent).toBe('Image copied')
    );
    flushSolid();
    vi.advanceTimersByTime(1_600);
    flushSolid();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
  });

  it('clears successful copy feedback when navigating to another image', async () => {
    const [current, setCurrent] = createSignal(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    flushSolid();
    openMenu().click();
    flushSolid();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(overlay()!.querySelector('[role="status"]')?.textContent).toBe('Image copied')
    );
    flushSolid();
    setCurrent({ ...image, url: 'data:image/jpeg;base64,BBBB', title: 'next.jpg' });
    flushSolid();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
  });

  it('disables copying until the original is loaded and never copies placeholders', () => {
    const [current, setCurrent] = createSignal(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    flushSolid();
    expect(openMenu(false).disabled).toBe(true);
    flushSolid();
    setCurrent({ ...image, url: IMAGE_PLACEHOLDER });
    flushSolid();
    expect(openMenu().disabled).toBe(true);
    flushSolid();
    expect(write).not.toHaveBeenCalled();
  });

  it('dismisses the menu on Escape without closing the image dialog', async () => {
    const onClose = vi.fn();
    const escaped = vi.fn();
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={onClose} />, container);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    window.addEventListener('keydown', escaped);
    flushSolid();
    try {
      openMenu().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      flushSolid();
      expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(overlay()!.querySelector('.chat-image-preview-close'));
      expect(escaped).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', escaped);
      flushSolid();
    }
  });

  it('dismisses the menu when clicking outside it', () => {
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    flushSolid();
    openMenu();
    flushSolid();
    overlay()!
      .querySelector('img')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSolid();
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
  });

  it('reports clipboard errors in the preview', async () => {
    write.mockRejectedValue(new Error('Clipboard permission denied'));
    dispose = render(() => <ImagePreviewOverlay image={image} onClose={() => {}} />, container);
    flushSolid();
    openMenu().click();
    flushSolid();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(overlay()!.querySelector('[role="alert"]')?.textContent).toBe(
        'Clipboard permission denied'
      )
    );
    flushSolid();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
  });

  it('clears the menu and ignores old copy results when navigating to another image', async () => {
    const [current, setCurrent] = createSignal(image);
    dispose = render(() => <ImagePreviewOverlay image={current()} onClose={() => {}} />, container);
    flushSolid();
    openMenu().click();
    flushSolid();
    setCurrent({ ...image, url: 'data:image/jpeg;base64,BBBB', title: 'next.jpg' });
    flushSolid();
    encode(new Blob(['pixels'], { type: 'image/png' }));
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(overlay()!.querySelector('[role="status"]')).toBeNull();
    expect(openMenu(false).disabled).toBe(true);
    flushSolid();
    setCurrent(image);
    flushSolid();
    expect(overlay()!.querySelector('[role="menu"]')).toBeNull();
  });
});
