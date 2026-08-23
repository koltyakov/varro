import { Show, createEffect, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import { trapModalFocus } from '../lib/modal-focus';
import { navArrowLeftIcon, navArrowRightIcon, xmarkIcon } from '../lib/ui-icons';
import { Tooltip } from './Tooltip';
import { UiIcon } from './UiIcon';

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
            onClick={props.onClose}
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
                  <img src={image().url} alt={image().alt} class="chat-image-preview-img" />
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
                </figure>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Portal>
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
