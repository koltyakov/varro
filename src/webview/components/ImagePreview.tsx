import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import { trapModalFocus } from '../lib/modal-focus';
import { navArrowLeftIcon, navArrowRightIcon, xmarkIcon } from '../lib/ui-icons';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';
import { createDeferredImage, IMAGE_PLACEHOLDER } from '../lib/deferred-content';
import { observePopupViewport } from '../lib/popup-position';
import { writeClipboardImage } from '../lib/write-clipboard';

export type PreviewImage = {
  url: string;
  alt: string;
  title: string;
  mime?: string;
};

type PreviewNavigationOptions = {
  canNavigate?: Accessor<boolean>;
  onPrevious?: () => void;
  onNext?: () => void;
};

export function createImagePreviewEffect(
  isOpen: Accessor<boolean>,
  onClose: () => void,
  navigation?: PreviewNavigationOptions
) {
  createEffect(() => {
    if (!isOpen()) return;

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (!navigation?.canNavigate?.()) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigation.onPrevious?.();
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigation.onNext?.();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    document.body.classList.add('chat-image-preview-open');

    onCleanup(() => {
      window.removeEventListener('keydown', handleKeydown);
      document.body.classList.remove('chat-image-preview-open');
    });
  });
}

export function ImagePreviewOverlay(props: {
  image: PreviewImage | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  showNavigation?: boolean;
  position?: number;
  total?: number;
}) {
  const content = createDeferredImage(
    () => props.image?.url ?? '',
    false,
    () => !!props.image
  );
  let previewElement: HTMLImageElement | undefined;
  let copyGeneration = 0;
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [loadedUrl, setLoadedUrl] = createSignal('');
  const [copyState, setCopyState] = createSignal<'idle' | 'copying' | 'copied'>('idle');
  const [copyError, setCopyError] = createSignal('');
  createEffect(() => {
    void props.image?.url;
    void content.url();
    copyGeneration++;
    setMenu(null);
    setLoadedUrl('');
    setCopyState('idle');
    setCopyError('');
  });
  onCleanup(() => copyGeneration++);
  const copyImage = async () => {
    if (!previewElement || copyState() === 'copying') return;
    const generation = copyGeneration;
    setMenu(null);
    setCopyState('copying');
    setCopyError('');
    try {
      await writeClipboardImage(previewElement);
      if (generation === copyGeneration) setCopyState('copied');
    } catch (error) {
      if (generation !== copyGeneration) return;
      setCopyState('idle');
      setCopyError(error instanceof Error ? error.message : 'Could not copy the image');
    }
  };
  return (
    <Portal>
      <Show when={props.image}>
        {(image) => (
          <div
            ref={(element) => onCleanup(trapModalFocus(element))}
            class="chat-image-preview-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${image().title}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onClose();
            }}
          >
            <Tooltip content="Close image preview">
              <button
                type="button"
                class="chat-image-preview-close"
                aria-label="Close image preview"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose();
                }}
              >
                <CloseIcon />
              </button>
            </Tooltip>
            <div class="chat-image-preview-overlay-scroll">
              <div class="chat-image-preview-overlay-inner">
                <figure
                  class="chat-image-preview-figure"
                  onClick={(event) => event.stopPropagation()}
                >
                  <img
                    ref={(element) => {
                      previewElement = element;
                    }}
                    src={content.url()}
                    alt={image().alt}
                    class="chat-image-preview-img"
                    decoding="async"
                    onLoad={() => setLoadedUrl(content.url())}
                    onError={() => setLoadedUrl('')}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setMenu({ x: event.clientX, y: event.clientY });
                    }}
                  />
                  <Show when={content.error()}>
                    <div role="alert">
                      {content.error()}{' '}
                      <button type="button" onClick={content.retry}>
                        Retry
                      </button>
                    </div>
                  </Show>
                  <Show when={props.showNavigation}>
                    <div class="chat-image-preview-nav-group">
                      <Tooltip content="Previous image">
                        <button
                          type="button"
                          class="chat-image-preview-nav chat-image-preview-nav-prev"
                          aria-label="Previous image"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onPrevious?.();
                          }}
                        >
                          <ChevronLeftIcon />
                        </button>
                      </Tooltip>
                      <Tooltip content="Next image">
                        <button
                          type="button"
                          class="chat-image-preview-nav chat-image-preview-nav-next"
                          aria-label="Next image"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onNext?.();
                          }}
                        >
                          <ChevronRightIcon />
                        </button>
                      </Tooltip>
                    </div>
                  </Show>
                  <figcaption class="chat-image-preview-caption">
                    <Show when={props.total && props.total > 1}>
                      <span class="chat-image-preview-count">
                        {props.position} / {props.total}
                      </span>
                      <span class="chat-image-preview-caption-separator">&middot;</span>
                    </Show>
                    <span class="chat-image-preview-caption-label">{image().title}</span>
                    <Show when={image().mime}>
                      <span class="chat-image-preview-caption-mime">· {image().mime}</span>
                    </Show>
                  </figcaption>
                  <Show when={copyState() !== 'idle'}>
                    <div class="chat-image-preview-copy-status" role="status">
                      {copyState() === 'copying' ? 'Copying image…' : 'Image copied'}
                    </div>
                  </Show>
                  <Show when={copyError()}>
                    <div class="chat-image-preview-copy-status" role="alert">
                      {copyError()}
                    </div>
                  </Show>
                </figure>
              </div>
            </div>
            <Show when={menu()}>
              {(position) => (
                <ImagePreviewContextMenu
                  x={position().x}
                  y={position().y}
                  disabled={
                    loadedUrl() !== content.url() ||
                    content.url() === IMAGE_PLACEHOLDER ||
                    !!content.error() ||
                    copyState() === 'copying'
                  }
                  onClose={() => setMenu(null)}
                  onCopy={() => void copyImage()}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </Portal>
  );
}

function ImagePreviewContextMenu(props: {
  x: number;
  y: number;
  disabled: boolean;
  onClose: () => void;
  onCopy: () => void;
}) {
  let menu!: HTMLDivElement;
  const previousFocus = document.activeElement;
  const positionMenu = () => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8))}px`;
  };
  onMount(() => {
    positionMenu();
    onCleanup(observePopupViewport(menu, positionMenu));
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      props.onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('contextmenu', outside, true);
    window.addEventListener('focusin', outside);
    onCleanup(() => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('focusin', outside);
      if (menu.contains(document.activeElement) && previousFocus instanceof HTMLElement)
        previousFocus.focus({ preventScroll: true });
    });
  });
  return (
    <div
      ref={(element) => {
        menu = element;
      }}
      class="session-item-actions-menu chat-image-preview-context-menu"
      role="menu"
      aria-label="Image actions"
      tabIndex={-1}
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        }
      }}
    >
      <button type="button" role="menuitem" disabled={props.disabled} onClick={props.onCopy}>
        Copy image
      </button>
    </div>
  );
}

function CloseIcon() {
  return <UiIcon source={xmarkIcon} aria-hidden="true" />;
}

function ChevronLeftIcon() {
  return <UiIcon source={navArrowLeftIcon} aria-hidden="true" />;
}

function ChevronRightIcon() {
  return <UiIcon source={navArrowRightIcon} aria-hidden="true" />;
}
