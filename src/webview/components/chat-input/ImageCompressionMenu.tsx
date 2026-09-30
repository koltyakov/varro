import { onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { CompressedImage, ImageCompressionAnalysis } from '../../lib/image-compression';
import { formatImageBytes } from '../../lib/image-compression';
import { observePopupViewport } from '../../lib/popup-position';
import { registerComposerOverlayDismiss } from './composer-overlay-dismiss';

export function ImageCompressionMenu(props: {
  x: number;
  y: number;
  size: number;
  mime: string;
  analysis: ImageCompressionAnalysis | null;
  canRestore: boolean;
  busy: boolean;
  error: string | null;
  onClose: (restoreFocus?: boolean) => void;
  onApply: (image: CompressedImage) => void;
  onRestore: () => void;
}) {
  let menu: HTMLDivElement | undefined;
  const positionMenu = () => {
    if (!menu) return;
    const margin = 8;
    const gap = 6;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(props.x, window.innerWidth - margin - rect.width))}px`;
    menu.style.top = `${Math.max(margin, Math.min(props.y - gap - rect.height, window.innerHeight - margin - rect.height))}px`;
  };
  onMount(() => {
    if (menu) {
      positionMenu();
      onCleanup(observePopupViewport(menu, positionMenu));
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && menu?.contains(event.target)) return;
      props.onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('contextmenu', outside, true);
    window.addEventListener('focusin', outside);
    const unregister = registerComposerOverlayDismiss(props.onClose);
    onCleanup(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('focusin', outside);
      unregister();
    });
  });
  const describe = (image: CompressedImage) => {
    const reduction =
      props.size > 0 ? Math.max(0, Math.round((1 - image.size / props.size) * 100)) : 0;
    return `${image.width} × ${image.height} · ${formatImageBytes(image.size)} (${reduction}% smaller)`;
  };
  return (
    <Portal>
      <div
        ref={(element) => {
          menu = element;
        }}
        class="session-item-actions-menu image-compression-menu"
        role="menu"
        aria-label="Compress image"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose(true);
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(
            menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
          );
          const index = items.findIndex((item) => item === document.activeElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <Show when={props.analysis?.recommended}>
          {(image) => (
            <button
              type="button"
              role="menuitem"
              disabled={props.busy}
              onClick={() => props.onApply(image())}
            >
              Recommended<span>{describe(image())}</span>
            </button>
          )}
        </Show>
        <Show when={props.analysis?.smaller}>
          {(image) => (
            <button
              type="button"
              role="menuitem"
              disabled={props.busy}
              onClick={() => props.onApply(image())}
            >
              Smaller size<span>{describe(image())}</span>
            </button>
          )}
        </Show>
        <Show when={props.canRestore}>
          <button type="button" role="menuitem" disabled={props.busy} onClick={props.onRestore}>
            Restore original
          </button>
        </Show>
        <Show when={props.analysis}>
          <p class="image-compression-current">
            Current image: {props.analysis?.width} × {props.analysis?.height} ·{' '}
            {formatImageBytes(props.size)}
          </p>
        </Show>
        <p>
          Resizing may reduce readability of small text.
          <Show when={props.mime === 'image/png'}>
            <span class="image-compression-transparency">PNG transparency is preserved.</span>
          </Show>
        </p>
        <Show when={props.busy}>
          <p role="status">Compressing image…</p>
        </Show>
        <Show when={props.error}>
          <p role="alert">{props.error}</p>
        </Show>
      </div>
    </Portal>
  );
}
