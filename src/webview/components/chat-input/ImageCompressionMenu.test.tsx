import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageCompressionMenu } from './ImageCompressionMenu';
import { dismissComposerOverlays } from './composer-overlay-dismiss';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
});

it('offers measured presets with keyboard navigation, Escape and outside dismissal', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 280, 200)
  );
  const onClose = vi.fn();
  const onApply = vi.fn();
  const image = {
    url: 'data:image/png;base64,small',
    mime: 'image/png',
    size: 100_000,
    width: 2048,
    height: 1024,
  };
  cleanup = render(
    () => (
      <ImageCompressionMenu
        x={20}
        y={600}
        size={3 * 1024 * 1024}
        mime="image/png"
        analysis={{
          width: 4000,
          height: 2000,
          recommended: image,
          smaller: { ...image, width: 1280, height: 640 },
        }}
        canRestore
        busy={false}
        error={null}
        onClose={onClose}
        onApply={onApply}
        onRestore={() => {}}
      />
    ),
    document.body
  );
  const menu = document.querySelector<HTMLElement>('.image-compression-menu')!;
  expect(menu.style.top).toBe('394px');
  expect(menu.style.left).toBe('20px');
  expect(menu.style.maxHeight).toBe('');
  const buttons = menu.querySelectorAll<HTMLButtonElement>('button');
  expect(document.activeElement).toBe(buttons[0]);
  expect(buttons[0]?.textContent).toContain('2048 × 1024 · 98 KB (97% smaller)');
  expect(menu.textContent).toContain('Current image: 4000 × 2000 · 3.0 MB');
  expect(menu.querySelector('.image-compression-current')?.textContent).toContain('3.0 MB');
  expect(menu.querySelector('.image-compression-transparency')?.textContent).toBe(
    'PNG transparency is preserved.'
  );
  expect(menu.textContent).not.toContain('Custom');
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(buttons[1]);
  buttons[0]!.click();
  expect(onApply).toHaveBeenCalledWith(image);
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onClose).toHaveBeenCalledWith(true);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
  dismissComposerOverlays();
  expect(onClose).toHaveBeenCalledTimes(3);
});

it('formats KB sizes and percentage reductions from the current image size', () => {
  cleanup = render(
    () => (
      <ImageCompressionMenu
        x={20}
        y={20}
        size={800 * 1024}
        mime="image/jpeg"
        analysis={{
          width: 3440,
          height: 1440,
          recommended: {
            url: 'data:image/jpeg;base64,small',
            mime: 'image/jpeg',
            size: 400 * 1024,
            width: 2048,
            height: 857,
          },
          smaller: null,
        }}
        canRestore={false}
        busy={false}
        error={null}
        onClose={() => {}}
        onApply={() => {}}
        onRestore={() => {}}
      />
    ),
    document.body
  );
  const menu = document.querySelector('.image-compression-menu')!;
  expect(menu.textContent).toContain('Current image: 3440 × 1440 · 800 KB');
  expect(menu.querySelector('button')?.textContent).toContain('2048 × 857 · 400 KB (50% smaller)');
  expect(menu.querySelectorAll('button')).toHaveLength(1);
  expect(menu.querySelector('form')).toBeNull();
});
