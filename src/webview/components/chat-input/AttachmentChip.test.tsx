import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { getFileTypeIcon } from '../FileTypeIcon';
import { AttachmentChip } from './AttachmentChip';

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
