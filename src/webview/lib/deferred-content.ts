import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js';
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
  const [loaded, setLoaded] = createSignal<T>();
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const requestPath = createMemo(() => (enabled() ? source().deferred : undefined));
  createEffect(() => {
    const path = requestPath();
    attempt();
    setError('');
    setLoading(false);
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let dirty = false;
    let nextRequestAt = 0;
    const refresh = () => {
      if (inFlight || timer !== undefined || controller.signal.aborted) return;
      const delay = nextRequestAt - Date.now();
      if (delay > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          refresh();
        }, delay);
        return;
      }
      const part = untrack(source);
      dirty = false;
      inFlight = true;
      nextRequestAt = Date.now() + 100;
      setError('');
      setLoading(true);
      void apiCall<T>('GET', path, undefined, { signal: controller.signal, retries: 0 })
        .then((value) => {
          if (controller.signal.aborted) return;
          if (
            value.id !== part.id ||
            value.messageID !== part.messageID ||
            value.sessionID !== part.sessionID ||
            value.type !== part.type
          )
            throw new Error('Invalid message detail response');
          setLoaded(() => value);
        })
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values have no typed contract.
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          inFlight = false;
          if (controller.signal.aborted) return;
          setLoading(false);
          if (dirty) refresh();
        });
    };
    // One request at a time, at most ten per second, only while the disclosure
    // owns its details. Stream updates coalesce without starving a pending read.
    createEffect(() => {
      const part = source();
      if (part.type === 'tool') {
        const state = part.state;
        void state.input;
        if (state.status === 'pending') void state.raw;
        else {
          void state.metadata;
          if (state.status === 'completed') void state.output;
          if (state.status === 'error') void state.error;
        }
      }
      dirty = true;
      untrack(refresh);
    });
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
      setLoaded(undefined);
    });
  });
  const detail = () => {
    const value = loaded();
    const current = source();
    if (
      !value ||
      !requestPath() ||
      value.id !== current.id ||
      value.messageID !== current.messageID ||
      value.sessionID !== current.sessionID
    )
      return undefined;
    if (
      value.type === 'tool' &&
      current.type === 'tool' &&
      value.state.status !== current.state.status
    )
      return undefined;
    return value;
  };
  return {
    part: () => detail() ?? source(),
    loading: () => (loading() || !!requestPath()) && !detail() && !error(),
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
