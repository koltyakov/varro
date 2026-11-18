/* oxlint-disable anti-slop/no-module-mocking -- Exercise local image lifecycle with a mocked host API. */
import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalImageResponse } from '../../shared/local-images';
import { setState } from '../lib/state';

const bridge = vi.hoisted(() => ({
  apiCall:
    vi.fn<
      (
        method: string,
        path: string,
        body: { path: string; directory?: string; sessionID?: string; original?: boolean },
        options: { signal: AbortSignal; retries: number; timeoutMs: number }
      ) => Promise<LocalImageResponse>
    >(),
  postMessage: vi.fn(),
}));
vi.mock('../lib/bridge', () => bridge);

import { LocalMarkdownImage } from './LocalMarkdownImage';

const thumbnail = {
  url: 'data:image/webp;base64,AAAA',
  path: '/workspace/chart.png',
  mime: 'image/webp',
};
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function mount() {
  cleanup = render(
    () => (
      <LocalMarkdownImage
        source="chart.png"
        alt="Local chart"
        directory="/workspace"
        sessionID="session-1"
      />
    ),
    container
  );
  flushSolid();
}

beforeEach(() => {
  bridge.apiCall.mockReset().mockResolvedValue(thumbnail);
  bridge.postMessage.mockReset();
  setState(storePath('remoteImages', 'off'));
  flushSolid();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  flushSolid();
  container.remove();
  vi.unstubAllGlobals();
});

describe('LocalMarkdownImage', () => {
  it('automatically loads a thumbnail even when remote images are disabled', async () => {
    mount();
    await vi.waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toBe(thumbnail.url)
    );
    expect(bridge.apiCall).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/varro/local-image',
      { path: 'chart.png', directory: '/workspace', sessionID: 'session-1' },
      { signal: expect.any(AbortSignal), retries: 0, timeoutMs: 20_000 }
    );
  });

  it('does not load offscreen images and starts when they approach the viewport', async () => {
    let enter: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          enter = () => callback([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    mount();
    expect(bridge.apiCall).not.toHaveBeenCalled();
    enter?.();
    flushSolid();
    await vi.waitFor(() => expect(bridge.apiCall).toHaveBeenCalledOnce());
    expect(disconnect).toHaveBeenCalled();
  });

  it('loads the original only when the preview opens', async () => {
    const original = { ...thumbnail, url: 'data:image/png;base64,BBBB', mime: 'image/png' };
    bridge.apiCall.mockResolvedValueOnce(thumbnail).mockResolvedValueOnce(original);
    mount();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    container.querySelector('button')?.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(document.body.querySelector('.chat-image-preview-img')?.getAttribute('src')).toBe(
        original.url
      )
    );
    expect(bridge.apiCall.mock.calls[1]?.[2]).toEqual({
      path: 'chart.png',
      directory: '/workspace',
      sessionID: 'session-1',
      original: true,
    });
    document.body.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.click();
    flushSolid();
    expect(bridge.apiCall.mock.calls[1]?.[3].signal.aborted).toBe(true);
  });

  it('cancels pending work on unmount and ignores late results', async () => {
    let resolve: ((value: LocalImageResponse) => void) | undefined;
    bridge.apiCall.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    mount();
    const signal = bridge.apiCall.mock.calls[0]?.[3].signal;
    cleanup?.();
    cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    resolve?.(thumbnail);
    await Promise.resolve();
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps a readable placeholder when a file is unavailable', async () => {
    bridge.apiCall.mockRejectedValueOnce(new Error('Local image is not in an open workspace'));
    mount();
    await vi.waitFor(() => expect(container.textContent).toContain('not in an open workspace'));
    expect(container.querySelector('img')).toBeNull();
  });
});
