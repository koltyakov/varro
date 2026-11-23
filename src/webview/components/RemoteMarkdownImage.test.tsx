import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
/* oxlint-disable anti-slop/no-module-mocking -- Mock the host RPC boundary while exercising image consent and lifecycle in the DOM. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { RemoteImageResponse } from '../../shared/remote-images';
import { setState } from '../lib/state';

const bridge = vi.hoisted(() => ({
  apiCall:
    vi.fn<
      (
        method: string,
        path: string,
        body: { url: string; automatic?: boolean },
        options: { signal: AbortSignal; retries: number; timeoutMs: number }
      ) => Promise<RemoteImageResponse>
    >(),
  postMessage: vi.fn(),
}));
vi.mock('../lib/bridge', () => bridge);

import { RemoteMarkdownImage } from './RemoteMarkdownImage';

const preview = { url: 'data:image/webp;base64,AAAA', hostname: 'images.test' };
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}
let sequence = 0;

function mount(source = 'https://images.test/chart.png') {
  cleanup = render(() => <RemoteMarkdownImage source={source} alt="Sales chart" />, container);
}

function imageAction(root: ParentNode = container) {
  return root.querySelector<HTMLButtonElement>(
    '[data-remote-image-load], .remote-markdown-image-preview'
  );
}

beforeEach(() => {
  bridge.apiCall.mockReset().mockResolvedValue(preview);
  bridge.postMessage.mockReset();
  applyState(storePath('remoteImages', 'off'));
  applyState(storePath('activeSessionId', `remote-image-test-${++sequence}`));
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  applyState(storePath('remoteImages', 'off'));
  applyState(storePath('activeSessionId', null));
  vi.unstubAllGlobals();
});

describe('RemoteMarkdownImage', () => {
  it('shows only alt text while disabled', () => {
    mount();
    flushSolid();
    expect(container.textContent).toBe('Sales chart');
    expect(container.querySelector('button, img')).toBeNull();
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('does not fetch when opt-in is enabled or a placeholder mounts', () => {
    mount();
    flushSolid();
    applyState(storePath('remoteImages', 'ask'));
    expect(container.textContent).toContain('images.test');
    expect(imageAction()?.title).toContain('extension host');
    expect(imageAction()?.textContent).toBe('Load image');
    expect(container.querySelector('img')).toBeNull();
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('loads only on click and previews the data URL without further fetching', async () => {
    applyState(storePath('remoteImages', 'ask'));
    mount();
    flushSolid();
    imageAction()?.click();
    flushSolid();
    expect(bridge.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/remote-image',
      { url: 'https://images.test/chart.png' },
      { signal: expect.any(AbortSignal), retries: 0, timeoutMs: 20_000 }
    );
    await vi.waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toBe(preview.url)
    );
    flushSolid();
    imageAction()?.click();
    flushSolid();
    expect(document.body.querySelector('.chat-image-preview-img')?.getAttribute('src')).toBe(
      preview.url
    );
    document.body.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.click();
    flushSolid();
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it('reuses an approved thumbnail on remount without a request', async () => {
    applyState(storePath('remoteImages', 'ask'));
    mount();
    flushSolid();
    imageAction()?.click();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    flushSolid();
    cleanup?.();
    flushSolid();
    mount();
    flushSolid();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(preview.url);
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it('requires a new click after disabling and re-enabling', async () => {
    applyState(storePath('remoteImages', 'ask'));
    mount();
    flushSolid();
    imageAction()?.click();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    flushSolid();
    applyState(storePath('remoteImages', 'off'));
    expect(container.querySelector('img')).toBeNull();
    applyState(storePath('remoteImages', 'ask'));
    expect(imageAction()?.textContent).toBe('Load image');
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it.each(['off', 'unmount'])(
    'cancels pending requests on %s and ignores late results',
    async (action) => {
      let finish!: (value: RemoteImageResponse) => void;
      bridge.apiCall.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      applyState(storePath('remoteImages', 'ask'));
      mount();
      flushSolid();
      imageAction()?.click();
      flushSolid();
      const requestSignal = bridge.apiCall.mock.calls[0]![3].signal;
      if (action === 'off') setState(storePath('remoteImages', 'off'));
      else cleanup?.();
      flushSolid();
      expect(requestSignal.aborted).toBe(true);
      finish(preview);
      await Promise.resolve();
      flushSolid();
      expect(container.querySelector('img')).toBeNull();
    }
  );

  it('shows an actionable failure and retries only on another click', async () => {
    bridge.apiCall.mockRejectedValueOnce(
      new Error('Image URLs must resolve only to public internet addresses')
    );
    applyState(storePath('remoteImages', 'ask'));
    mount();
    flushSolid();
    imageAction()?.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain('public internet')
    );
    flushSolid();
    expect(imageAction()?.textContent).toBe('Retry image');
    expect(bridge.apiCall).toHaveBeenCalledOnce();
    imageAction()?.click();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    flushSolid();
    expect(bridge.apiCall).toHaveBeenCalledTimes(2);
  });

  it('rejects a host response containing a remote source', async () => {
    bridge.apiCall.mockResolvedValue({
      url: 'https://images.test/unsafe.png',
      hostname: 'images.test',
    });
    applyState(storePath('remoteImages', 'ask'));
    mount();
    flushSolid();
    imageAction()?.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Invalid image preview response')
    );
    flushSolid();
    expect(container.querySelector('img')).toBeNull();
  });

  it.each(['http://images.test/a.png', 'https://user:secret@images.test/a.png', 'file:///a.png'])(
    'never offers to load unsupported source %s',
    (source) => {
      applyState(storePath('remoteImages', 'ask'));
      mount(source);
      flushSolid();
      expect(container.textContent).toBe('Sales chart');
      expect(container.querySelector('button')).toBeNull();
    }
  );

  it('does not activate an enclosing Markdown link when loading', async () => {
    applyState(storePath('remoteImages', 'ask'));
    const clicked = vi.fn();
    const anchor = document.createElement('a');
    anchor.href = 'https://other.test/';
    anchor.addEventListener('click', clicked);
    flushSolid();
    container.append(anchor);
    cleanup = render(
      () => <RemoteMarkdownImage source="https://images.test/chart.png" alt="Chart" />,
      anchor
    );
    flushSolid();
    imageAction(anchor)?.click();
    flushSolid();
    expect(clicked).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(anchor.querySelector('img')).not.toBeNull());
    flushSolid();
  });

  it('loads automatically only after an on-mode image approaches the viewport', async () => {
    let intersect!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = '200px';
        readonly scrollMargin = '0px';
        readonly thresholds = [0];
        constructor(callback: IntersectionObserverCallback) {
          intersect = () =>
            callback(
              [
                {
                  isIntersecting: true,
                  target: container,
                  time: 0,
                  rootBounds: null,
                  boundingClientRect: container.getBoundingClientRect(),
                  intersectionRect: container.getBoundingClientRect(),
                  intersectionRatio: 1,
                },
              ],
              this
            );
        }
        observe() {}
        unobserve() {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
        disconnect = disconnect;
      }
    );
    applyState(storePath('remoteImages', 'on'));
    mount();
    flushSolid();
    expect(bridge.apiCall).not.toHaveBeenCalled();
    intersect();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    flushSolid();
    expect(bridge.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/remote-image',
      { url: 'https://images.test/chart.png', automatic: true },
      expect.any(Object)
    );
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not automatically retry a failed image in a loop', async () => {
    bridge.apiCall.mockRejectedValue(new Error('Image server returned HTTP 403'));
    applyState(storePath('remoteImages', 'on'));
    mount();
    flushSolid();
    await vi.waitFor(() => expect(container.textContent).toContain('HTTP 403'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(bridge.apiCall).toHaveBeenCalledOnce();
    expect(imageAction()?.textContent).toBe('Retry image');
  });

  it('cancels an automatic request when returning to ask mode', async () => {
    let finish!: (value: RemoteImageResponse) => void;
    bridge.apiCall.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    applyState(storePath('remoteImages', 'on'));
    mount();
    flushSolid();
    await vi.waitFor(() => expect(bridge.apiCall).toHaveBeenCalledOnce());
    flushSolid();
    const requestSignal = bridge.apiCall.mock.calls[0]![3].signal;
    applyState(storePath('remoteImages', 'ask'));
    expect(requestSignal.aborted).toBe(true);
    finish(preview);
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens the full source URL exactly once without loading the image or activating an outer link', () => {
    applyState(storePath('remoteImages', 'ask'));
    const outerLink = document.createElement('a');
    const outerClick = vi.fn();
    outerLink.href = 'https://other.test/';
    outerLink.addEventListener('click', outerClick);
    flushSolid();
    container.append(outerLink);
    const source = 'https://images.test/chart.png?size=large';
    cleanup = render(() => <RemoteMarkdownImage source={source} alt="Chart" />, outerLink);
    flushSolid();
    const link = container.querySelector<HTMLAnchorElement>('.remote-markdown-image-url');
    expect(link?.textContent).toBe(source);
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
      varroLinkUrl: source,
      varroLinkText: source,
    });
    link?.click();
    flushSolid();
    expect(outerClick).not.toHaveBeenCalled();
    expect(bridge.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'vscode/open-external',
      payload: { url: source },
    });
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('copies the full source URL without fetching or opening it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    applyState(storePath('remoteImages', 'ask'));
    const source = 'https://images.test/a/long/path/chart.png?size=large';
    mount(source);
    flushSolid();
    container.querySelector<HTMLButtonElement>('.remote-markdown-image-copy-url')?.click();
    flushSolid();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Image URL copied"]')).not.toBeNull()
    );
    flushSolid();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(bridge.apiCall).not.toHaveBeenCalled();
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });
});
