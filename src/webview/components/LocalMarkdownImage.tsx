import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { VARRO_API_ENDPOINTS } from '../../shared/protocol';
import type { LocalImageRequest, LocalImageResponse } from '../../shared/local-images';
import { apiCall } from '../lib/bridge';
import { ImagePreviewOverlay, createImagePreviewEffect } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';

/** Reserve the frame before requesting media; original bytes are only used by an open preview. */
export function LocalMarkdownImage(props: {
  source: string;
  alt: string;
  directory?: string;
  sessionID?: string;
}) {
  const [image, setImage] = createSignal<LocalImageResponse | null>(null);
  const [error, setError] = createSignal('');
  const [preview, setPreview] = createSignal<PreviewImage | null>(null);
  const [nearViewport, setNearViewport] = createSignal(false);
  const [element, setElement] = createSignal<HTMLSpanElement>();
  let controller: AbortController | undefined;
  let previewController: AbortController | undefined;
  onCleanup(() => {
    controller?.abort();
    previewController?.abort();
  });
  const closePreview = () => {
    previewController?.abort();
    setPreview(null);
  };
  createImagePreviewEffect(() => preview() !== null, closePreview);

  const request = (signal: AbortSignal, original = false) => {
    const body: LocalImageRequest = {
      path: props.source,
      directory: props.directory,
      sessionID: props.sessionID,
    };
    if (original) body.original = true;
    return apiCall<LocalImageResponse>('POST', VARRO_API_ENDPOINTS.localImage, body, {
      signal,
      retries: 0,
      timeoutMs: 20_000,
    });
  };

  createEffect(
    () => nearViewport() && [props.source, props.directory, props.sessionID],
    (scope) => {
      if (!scope) return;
      const current = new AbortController();
      controller = current;
      setImage(null);
      setError('');
      closePreview();
      void request(current.signal).then(
        (result) => {
          if (!current.signal.aborted) setImage(result);
        },
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections may contain arbitrary transport or abort errors.
        (reason: unknown) => {
          if (!current.signal.aborted)
            setError(reason instanceof Error ? reason.message : 'Could not load local image');
        }
      );
      return () => current.abort();
    }
  );

  createEffect(element, (node) => {
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  });

  async function openPreview() {
    const loaded = image();
    if (!loaded) return;
    previewController?.abort();
    const current = new AbortController();
    previewController = current;
    setPreview({
      url: loaded.url,
      alt: props.alt,
      title: props.alt || loaded.path,
      mime: loaded.mime,
    });
    try {
      const original = await request(current.signal, true);
      if (!current.signal.aborted)
        setPreview({
          url: original.url,
          alt: props.alt,
          title: props.alt || original.path,
          mime: original.mime,
        });
    } catch (reason) {
      if (!current.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Could not load original image');
    }
  }

  return (
    <>
      <span ref={setElement} class="local-markdown-image" title={props.source}>
        <Show
          when={image()}
          fallback={
            <span class="local-markdown-image-placeholder" role="status">
              {error() || props.alt || 'Loading local image...'}
            </span>
          }
        >
          {(loaded) => (
            <button
              type="button"
              class="remote-markdown-image-preview"
              aria-label={`Open image preview: ${props.alt || props.source}`}
              ref={(button) =>
                button.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openPreview();
                })
              }
            >
              <img src={loaded().url} alt={props.alt} />
            </button>
          )}
        </Show>
      </span>
      <ImagePreviewOverlay image={preview()} onClose={closePreview} />
    </>
  );
}
