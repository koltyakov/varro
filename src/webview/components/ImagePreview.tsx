import { Show, createEffect, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';

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
            class="chat-image-preview-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${image().title}`}
            onClick={props.onClose}
          >
            <button
              type="button"
              class="chat-image-preview-close"
              aria-label="Close image preview"
              title="Close image preview"
              onClick={(event) => {
                event.stopPropagation();
                props.onClose();
              }}
            >
              <CloseIcon />
            </button>
            <div class="chat-image-preview-overlay-scroll">
              <div
                class="chat-image-preview-overlay-inner"
                onClick={(event) => event.stopPropagation()}
              >
                <figure class="chat-image-preview-figure">
                  <img src={image().url} alt={image().alt} class="chat-image-preview-img" />
                  <Show when={props.showNavigation}>
                    <div class="chat-image-preview-nav-group">
                      <button
                        type="button"
                        class="chat-image-preview-nav chat-image-preview-nav-prev"
                        aria-label="Previous image"
                        title="Previous image"
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onPrevious?.();
                        }}
                      >
                        <ChevronLeftIcon />
                      </button>
                      <button
                        type="button"
                        class="chat-image-preview-nav chat-image-preview-nav-next"
                        aria-label="Next image"
                        title="Next image"
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onNext?.();
                        }}
                      >
                        <ChevronRightIcon />
                      </button>
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
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="m4 4 8 8" stroke-linecap="round" />
      <path d="m12 4-8 8" stroke-linecap="round" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="M10 3 5 8l5 5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="m6 3 5 5-5 5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
