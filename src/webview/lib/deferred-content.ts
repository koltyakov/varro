import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { apiCall } from './bridge';
import type { FilePart, Part } from '../types';
import { isString } from '../../shared/type-utils';

let thumbnailQueue: Promise<void> = Promise.resolve();

function loadThumbnail(path: string, signal: AbortSignal): Promise<string> {
  const request = thumbnailQueue.then(async () => {
    signal.throwIfAborted();
    const value = await apiCall<{ url: string | null }>(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}view=thumbnail`,
      undefined,
      { signal, retries: 0 }
    );
    return value.url ?? IMAGE_PLACEHOLDER;
  });
  // The caller reports failures. Keep the queue usable after cancellation or a failed preview.
  thumbnailQueue = request.then(
    () => {},
    () => {}
  );
  return request;
}

export const IMAGE_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="384" height="256" viewBox="0 0 384 256"><rect width="384" height="256" fill="#888" fill-opacity=".12"/><path d="M160 150l22-28 18 20 12-14 20 26h-72zm0-48h72v52h-72z" fill="none" stroke="#888" stroke-width="3"/></svg>'
  );

export function deferredFilePath(url: string): string | null {
  return url.startsWith('varro-content:') ? url.slice('varro-content:'.length) : null;
}

export async function loadFileContent(url: string, signal?: AbortSignal): Promise<string> {
  const path = deferredFilePath(url);
  if (!path) return url;
  const part = await apiCall<FilePart>('GET', path, undefined, { signal, retries: 0 });
  if (part.type !== 'file' || !isString(part.url) || deferredFilePath(part.url))
    throw new Error('Invalid attachment response');
  return part.url;
}

/** Detail data belongs to the mounted disclosure, not the canonical streaming store. */
export function createDeferredPart<T extends Part & { deferred?: string }>(
  source: Accessor<T>,
  enabled: Accessor<boolean>
) {
  const [loaded, setLoaded] = createSignal<{ source: T; value: T }>();
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  createEffect(() => {
    const part = source();
    const active = enabled();
    attempt();
    setError('');
    setLoading(false);
    if (!active || !part.deferred) return;
    const controller = new AbortController();
    setLoading(true);
    void apiCall<T>('GET', part.deferred, undefined, { signal: controller.signal, retries: 0 })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.id !== part.id ||
          value.messageID !== part.messageID ||
          value.sessionID !== part.sessionID ||
          value.type !== part.type
        )
          throw new Error('Invalid message detail response');
        setLoaded({ source: part, value });
      })
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values have no typed contract.
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    onCleanup(() => {
      controller.abort();
      setLoaded(undefined);
    });
  });
  return {
    part: () => (loaded()?.source === source() ? loaded()!.value : source()),
    loading,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function createDeferredImage(
  source: Accessor<string>,
  thumbnail: boolean,
  enabled: Accessor<boolean> = () => true
) {
  const [resolved, setResolved] = createSignal<{ source: string; url: string }>();
  const [error, setError] = createSignal('');
  const [attempt, setAttempt] = createSignal(0);
  createEffect(() => {
    const url = source();
    const active = enabled();
    attempt();
    setError('');
    const path = deferredFilePath(url);
    if (!active || !path) return;
    const controller = new AbortController();
    const request = thumbnail
      ? loadThumbnail(path, controller.signal)
      : loadFileContent(url, controller.signal);
    void request
      .then((value) => {
        if (!controller.signal.aborted) setResolved({ source: url, url: value });
      })
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values have no typed contract.
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    onCleanup(() => {
      controller.abort();
      setResolved(undefined);
    });
  });
  return {
    url: () =>
      !deferredFilePath(source())
        ? source()
        : resolved()?.source === source()
          ? resolved()!.url
          : IMAGE_PLACEHOLDER,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
