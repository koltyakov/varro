import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { resetDefaultAppState, setState, state } from '../lib/state';

const postMessageMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise RestartBlocked's bridge module integration. */
vi.mock('../lib/bridge', () => ({
  postMessage: postMessageMock,
}));

import { RestartBlocked } from './RestartBlocked';

describe('RestartBlocked', () => {
  let container: HTMLDivElement;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    setState(
      storePath('restartBlocked', {
        totalSessionCount: 3,
        directories: [
          { directory: '/repo-a', sessionCount: 2 },
          { directory: '/repo-b', sessionCount: 1 },
        ],
      })
    );
    flushSolid();
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = render(() => RestartBlocked(), container);
    flushSolid();
  });

  afterEach(() => {
    cleanup?.();
    flushSolid();
    container.remove();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    vi.useRealTimers();
  });

  it('wraps long directories between path segments without changing their text', () => {
    setState(
      storePath('restartBlocked', {
        totalSessionCount: 1,
        directories: [{ directory: '/Users/dev/very-long-project/packages/web', sessionCount: 1 }],
      })
    );
    flushSolid();

    const path = container.querySelector<HTMLElement>(
      '[title="/Users/dev/very-long-project/packages/web"]'
    );
    expect(path?.textContent).toBe('/Users/dev/very-long-project/packages/web');
    // One break opportunity after each separator: "/", "Users/", "dev/", ... "packages/".
    expect(path?.querySelectorAll('wbr')).toHaveLength(5);
  });

  it('renders directory counts and periodically checks again', async () => {
    expect(container.textContent).toContain('3 sessions are still running');
    expect(container.textContent).toContain('/repo-a');
    expect(container.textContent).toContain('/repo-b');

    await vi.advanceTimersByTimeAsync(3000);
    flushSolid();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'server/restart/check',
      payload: { checkId: expect.any(Number) },
    });
  });

  it('offers force restart and a top close control', () => {
    const forceButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Force Restart'
    );
    forceButton?.click();
    flushSolid();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'server/restart',
      payload: { force: true },
    });

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close restart status"]'
    );
    expect(closeButton?.classList.contains('chat-image-preview-close')).toBe(true);
    expect(closeButton?.classList.contains('server-status-close')).toBe(true);
    closeButton?.click();
    flushSolid();
    expect(state.restartBlocked).toBeNull();
  });

  it('closes from the bottom action row without restarting', () => {
    const closeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Close'
    );
    expect(closeButton).toBeDefined();
    closeButton?.click();
    flushSolid();

    expect(state.restartBlocked).toBeNull();
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
