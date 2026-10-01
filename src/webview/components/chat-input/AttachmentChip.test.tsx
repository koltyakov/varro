import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFileTypeIcon } from '../FileTypeIcon';
import { AttachmentChip } from './AttachmentChip';
import { dismissComposerOverlays } from './composer-overlay-dismiss';

let container: HTMLDivElement;
let cleanup: () => void;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  container.remove();
  document.querySelector('.chat-attachment-image-preview')?.remove();
});

describe('AttachmentChip', () => {
  it('shows a failure reason when a previously valid image becomes broken', () => {
    const [error, setError] = createSignal<string>();
    cleanup = render(
      () => (
        <AttachmentChip
          label="Image 1"
          icon="image"
          title={error() ?? 'Image 1'}
          disabled={!!error()}
          previewImage={error() ? undefined : { url: 'blob:image', alt: 'Image 1' }}
        />
      ),
      container
    );
    const chip = container.querySelector<HTMLElement>('.chat-attachment-chip')!;
    chip.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.chat-attachment-image-preview')).not.toBeNull();
    setError('Could not decode the image');
    expect(chip.title).toBe('Could not decode the image');
    expect(chip.classList.contains('disabled')).toBe(true);
    expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
    chip.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
  });

  it('shows a non-interactive large-image warning and opens compression only on right click', () => {
    const onClick = vi.fn();
    const onCompress = vi.fn();
    cleanup = render(
      () => (
        <AttachmentChip
          label="image.png"
          icon="image"
          onClick={onClick}
          onCompress={onCompress}
          compressionHint="Large image · 3.0 MB · Right-click to shrink it."
        />
      ),
      container
    );
    const indicator = container.querySelector<HTMLElement>('.chip-image-size')!;
    expect(indicator.tagName).toBe('SPAN');
    expect(indicator.title).toContain('3.0 MB');
    expect(container.querySelector('.image-size-warning')).not.toBeNull();
    indicator.click();
    expect(onCompress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
    container
      .querySelector('.chat-attachment-chip')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onCompress).toHaveBeenCalledTimes(1);
  });
  it('keeps an off current-document toggle operable without announcing it as disabled', () => {
    const [enabled, setEnabled] = createSignal(false);
    cleanup = render(
      () => (
        <AttachmentChip
          label="app.ts"
          disabled={!enabled()}
          toggle
          onClick={() => setEnabled((value) => !value)}
        />
      ),
      container
    );
    const chip = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(chip.tabIndex).toBe(0);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.hasAttribute('aria-disabled')).toBe(false);
    expect(chip.classList.contains('disabled')).toBe(true);
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('still announces an unsupported attachment as disabled', () => {
    cleanup = render(() => <AttachmentChip label="diagram.png" icon="image" disabled />, container);
    const chip = container.querySelector<HTMLElement>('.chat-attachment-chip')!;
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.hasAttribute('aria-pressed')).toBe(false);
  });

  it('shows an image preview above the chip while hovered', () => {
    container.className = 'chat-input-shell';
    cleanup = render(
      () => (
        <AttachmentChip
          label="diagram.png"
          icon="image"
          previewImage={{ url: 'blob:diagram', alt: 'diagram.png' }}
        />
      ),
      container
    );
    const chip = container.querySelector<HTMLElement>('.chat-attachment-chip')!;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    container.getBoundingClientRect = () => ({ left: 10, right: 510, width: 500 }) as DOMRect;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    chip.getBoundingClientRect = () => ({ left: 20, right: 120, top: 400, width: 100 }) as DOMRect;

    chip.dispatchEvent(new MouseEvent('mouseenter'));

    const preview = document.querySelector<HTMLElement>('.chat-attachment-image-preview');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('blob:diagram');
    expect(preview?.style.bottom).toBe(`${window.innerHeight - 400 + 22}px`);
    expect(preview?.style.getPropertyValue('--attachment-preview-max-width')).toBe('400px');
    expect(preview?.style.getPropertyValue('--attachment-preview-tail-offset')).not.toBe('0px');

    chip.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
  });

  it('dismisses an image preview when the composer changes', () => {
    cleanup = render(
      () => (
        <AttachmentChip
          label="diagram.png"
          icon="image"
          previewImage={{ url: 'blob:diagram', alt: 'diagram.png' }}
        />
      ),
      container
    );
    const chip = container.querySelector<HTMLElement>('.chat-attachment-chip')!;
    chip.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.chat-attachment-image-preview')).not.toBeNull();

    dismissComposerOverlays();

    expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
  });

  it('omits a redundant title unless the attachment label is truncated', () => {
    cleanup = render(
      () => <AttachmentChip label="diagram.png" icon="image" title="diagram.png" />,
      container
    );
    const chip = container.querySelector<HTMLElement>('.chat-attachment-chip')!;
    const stem = chip.querySelector<HTMLElement>('.chip-label-stem')!;

    expect(chip.hasAttribute('title')).toBe(false);

    Object.defineProperties(stem, {
      clientWidth: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 80 },
    });
    chip.dispatchEvent(new MouseEvent('mouseenter'));

    expect(chip.title).toBe('diagram.png');
  });

  it('keeps descriptive titles that differ from the visible label', () => {
    cleanup = render(
      () => <AttachmentChip label="app.ts" icon="file" title="src/app.ts L4-8" />,
      container
    );

    expect(container.querySelector<HTMLElement>('.chat-attachment-chip')?.title).toBe(
      'src/app.ts L4-8'
    );
    expect(container.querySelector<HTMLImageElement>('.file-type-icon')?.src).toBe(
      getFileTypeIcon('app.ts')
    );
  });

  it('uses a format icon for named images while preserving previews', () => {
    cleanup = render(
      () => <AttachmentChip label="diagram.png" path="images/diagram.png" icon="image" />,
      container
    );

    expect(container.querySelector<HTMLImageElement>('.file-type-icon')?.src).toBe(
      getFileTypeIcon('images/diagram.png')
    );
  });
});
