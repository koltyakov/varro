import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
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
    resetDefaultAppState();
    setState('restartBlocked', {
      totalSessionCount: 3,
      directories: [
        { directory: '/repo-a', sessionCount: 2 },
        { directory: '/repo-b', sessionCount: 1 },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = render(() => RestartBlocked(), container);
  });

  afterEach(() => {
    cleanup?.();
    container.remove();
    resetDefaultAppState();
    vi.useRealTimers();
  });

  it('renders directory counts and periodically checks again', async () => {
    expect(container.textContent).toContain('3 sessions are still running');
    expect(container.textContent).toContain('/repo-a');
    expect(container.textContent).toContain('/repo-b');

    await vi.advanceTimersByTimeAsync(3000);

    expect(postMessageMock).toHaveBeenCalledWith({
      type: 'server/restart/check',
      payload: { checkId: expect.any(Number) },
    });
  });

  it('offers force restart and a close control', () => {
    const forceButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Force Restart'
    );
    forceButton?.click();

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
    expect(state.restartBlocked).toBeNull();
  });
});
