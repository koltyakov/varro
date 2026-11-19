import { ariaBoolean } from '../lib/aria';
import { createEffect, Show, createSignal, onCleanup, untrack } from 'solid-js';
import { parseRemoteImageUrl } from '../../shared/remote-images';
import type { RemoteImageResponse } from '../../shared/remote-images';
import { state } from '../lib/state';
import { remoteImageRequests } from '../lib/remote-image-requests';
import { checkIcon, copyIcon, mediaImageIcon } from '../lib/ui-icons';
import { postMessage } from '../lib/bridge';
import { getExternalLinkContext } from '../lib/external-link';
import { writeClipboard } from '../lib/write-clipboard';
import { UiIcon } from './UiIcon';
import {
  clearRemoteImagePreviews,
  getRemoteImagePreview,
  rememberRemoteImagePreview,
} from '../lib/remote-image-previews';
import { ImagePreviewOverlay, createImagePreviewEffect } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';

/** Ask mode requires a click; on mode loads only near the viewport. */
export function RemoteMarkdownImage(props: {
  source: string;
  alt: string;
  onLoadAll?: () => void;
}) {
  const source = untrack(() => parseRemoteImageUrl(props.source));
  const key = untrack(
    () =>
      `${state.editorContext.workspacePath ?? ''}\u0000${state.activeSessionId ?? ''}\u0000${source?.href ?? ''}`
  );
  const [image, setImage] = createSignal<RemoteImageResponse | null>(getRemoteImagePreview(key));
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [preview, setPreview] = createSignal<PreviewImage | null>(null);
  const [nearViewport, setNearViewport] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let copyTimeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(copyTimeout);
  });
  let element: HTMLSpanElement | undefined;
  let controller: AbortController | undefined;
  let automaticRequest = false;
  const cancel = () => {
    controller?.abort();
    controller = undefined;
    setLoading(false);
  };
  onCleanup(cancel);
  createEffect(
    () => state.remoteImages,
    (mode) => {
      if (mode !== 'on' && automaticRequest) cancel();
      if (mode === 'off') {
        cancel();
        clearRemoteImagePreviews();
        setImage(null);
        setPreview(null);
        setError('');
      }
    }
  );
  createImagePreviewEffect(
    () => preview() !== null,
    () => setPreview(null)
  );

  const load = async (automatic = false) => {
    if (!source || controller || (!automatic && (image() || state.remoteImages === 'off'))) return;
    const current = new AbortController();
    controller = current;
    automaticRequest = automatic;
    setLoading(true);
    setError('');
    try {
      const result = await remoteImageRequests.load(source.href, current.signal, automatic);
      // Mode changes and disposal cancel this controller before a late result can paint.
      if (current.signal.aborted) return;
      if (!result.url.startsWith('data:image/webp;base64,') || result.url.length > 350_000)
        throw new Error('Invalid image preview response');
      rememberRemoteImagePreview(key, result);
      setImage(result);
    } catch (reason) {
      if (!current.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Could not load image');
    } finally {
      if (controller === current) {
        controller = undefined;
        setLoading(false);
      }
    }
  };

  const copyUrl = async () => {
    if (!source || !(await writeClipboard(source.href)) || disposed) return;
    setCopied(true);
    clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => setCopied(false), 1500);
  };

  // A markdown link may wrap the image. Handle actions at the element before
  // that link's native listener runs, rather than at Solid's delegated root.
  function imageAction(action: () => void) {
    return (buttonOrLink: HTMLElement) => {
      buttonOrLink.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
    };
  }

  createEffect(
    () => state.remoteImages,
    (mode) => {
      setNearViewport(false);
      if (mode !== 'on' || !element) return;
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
      observer.observe(element);
      return () => observer.disconnect();
    }
  );

  createEffect(
    () => state.remoteImages === 'on' && nearViewport() && !image() && !loading() && !error(),
    (ready) => {
      if (ready) void load(true);
    }
  );

  return (
    <Show when={state.remoteImages !== 'off' && source} fallback={props.alt}>
      <span
        ref={(node) => {
          element = node;
        }}
        class="remote-markdown-image"
      >
        <Show
          when={image()}
          fallback={
            <span class="remote-markdown-image-placeholder" aria-busy={ariaBoolean(loading())}>
              <span class="remote-markdown-image-heading">
                <span class="remote-markdown-image-icon" aria-hidden="true">
                  <UiIcon source={mediaImageIcon} width={20} height={20} />
                </span>
                <span class="remote-markdown-image-labels">
                  <span class="remote-markdown-image-alt">{props.alt || 'Remote image'}</span>
                  <span class="remote-markdown-image-host" title={source?.href}>
                    {source?.hostname}
                  </span>
                </span>
              </span>
              <span class="remote-markdown-image-url-row">
                <a
                  class="remote-markdown-image-url"
                  href={source?.href}
                  data-external="true"
                  data-vscode-context={getExternalLinkContext(source?.href ?? '')}
                  title={source?.href}
                  ref={imageAction(() => {
                    if (source)
                      postMessage({ type: 'vscode/open-external', payload: { url: source.href } });
                  })}
                >
                  {source?.href}
                </a>
                <button
                  type="button"
                  class="remote-markdown-image-copy-url"
                  aria-label={copied() ? 'Image URL copied' : 'Copy image URL'}
                  title={copied() ? 'Copied' : 'Copy image URL'}
                  ref={imageAction(() => void copyUrl())}
                >
                  <UiIcon
                    source={copied() ? checkIcon : copyIcon}
                    width={12}
                    height={12}
                    aria-hidden="true"
                  />
                </button>
              </span>
              <span class="remote-markdown-image-footer">
                <Show when={error()}>
                  <span role="status" class="remote-markdown-image-error" title={error()}>
                    {error()}
                  </span>
                </Show>
                <span class="remote-markdown-image-actions">
                  <button
                    type="button"
                    data-remote-image-load
                    class="remote-markdown-image-load"
                    disabled={loading()}
                    title="Load this image. Shares the URL and extension host's IP with the image server."
                    ref={imageAction(() => void load())}
                  >
                    {loading() ? 'Loading...' : error() ? 'Retry image' : 'Load image'}
                  </button>
                  <Show when={props.onLoadAll}>
                    <button
                      type="button"
                      class="remote-markdown-image-load-all"
                      title="Load all images in this response. Shares the URLs and extension host's IP with the image servers."
                      ref={imageAction(() => props.onLoadAll?.())}
                    >
                      Load all
                    </button>
                  </Show>
                </span>
              </span>
            </span>
          }
        >
          {(loaded) => (
            <button
              type="button"
              class="remote-markdown-image-preview"
              title={source?.href}
              aria-label={`Open image preview: ${props.alt || source?.hostname}`}
              ref={imageAction(() => {
                setPreview({
                  url: loaded().url,
                  alt: props.alt,
                  title: `${props.alt || 'Remote image'} · ${loaded().hostname}`,
                  mime: 'image/webp',
                });
              })}
            >
              <img src={loaded().url} alt={props.alt} />
            </button>
          )}
        </Show>
      </span>
      <ImagePreviewOverlay image={preview()} onClose={() => setPreview(null)} />
    </Show>
  );
}
