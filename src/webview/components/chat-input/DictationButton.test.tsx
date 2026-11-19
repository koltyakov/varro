import { flush as flushSolid } from 'solid-js';
/* oxlint-disable anti-slop/no-module-mocking -- Exercise dictation UI without a real extension host or microphone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type {
  ExtensionMessage,
  DictationProvider,
  DictationRecordingState,
  WebviewMessage,
} from '../../../shared/protocol';
import { microphoneIcon, microphoneSpeakingSolidIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';

interface TestBridgeContext {
  handler?: (message: ExtensionMessage) => void;
}

const mocks = vi.hoisted(() => {
  const context: TestBridgeContext = {};
  return {
    post: vi.fn<(message: WebviewMessage) => boolean>(),
    feedback: vi.fn(),
    context,
    unsubscribe: vi.fn(),
  };
});
vi.mock('../../lib/bridge', () => ({
  postMessage: mocks.post,
  onMessage: (handler: (message: ExtensionMessage) => void) => {
    mocks.context.handler = handler;
    return mocks.unsubscribe;
  },
}));
vi.mock('../chat/SessionActionFeedback', () => ({ showSessionActionFeedback: mocks.feedback }));
import { DictationButton } from './DictationButton';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
const focus = vi.fn();
const activationChange = vi.fn<(requested: boolean) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  flushSolid();
  mocks.post.mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  dispose?.();
  flushSolid();
  dispose = undefined;
  container.remove();
  flushSolid();
  vi.useRealTimers();
});

function reply(
  available = true,
  running = true,
  error?: string,
  state?: DictationRecordingState,
  provider?: DictationProvider
) {
  const message = mocks.post.mock.calls.at(-1)?.[0];
  if (message?.type !== 'dictation/request') throw new Error('Missing dictation request');
  const payload: Extract<ExtensionMessage, { type: 'dictation/result' }>['payload'] = {
    requestId: message.payload.requestId,
    available,
    running,
    state:
      state ??
      (error
        ? 'unknown'
        : message.payload.action === 'start'
          ? 'recording'
          : message.payload.action === 'status' &&
              container.querySelector('button')?.getAttribute('aria-pressed') === 'true'
            ? 'recording'
            : 'idle'),
  };
  if (error) payload.error = error;
  if (provider) payload.provider = provider;
  mocks.context.handler?.({ type: 'dictation/result', payload });
  flushSolid();
}
function button() {
  const result = container.querySelector('button');
  if (!result) throw new Error('Missing dictation button');
  return result;
}
function mount(remote = false) {
  dispose = render(
    () => (
      <DictationButton
        focusComposer={focus}
        remote={remote}
        onActivationChange={activationChange}
      />
    ),
    container
  );
  flushSolid();
}

describe('DictationButton', () => {
  it('labels Hex, preserves focus, and routes start, finish, and cancel to Hex', () => {
    mount();
    flushSolid();
    reply(true, true, undefined, 'idle', 'hex');
    expect(button().getAttribute('aria-label')).toBe('Start Hex dictation');
    button().click();
    flushSolid();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'dictation/request',
      payload: { action: 'start' },
    });
    reply(true, true, undefined, 'recording', 'hex');
    expect(button().getAttribute('aria-label')).toBe('Stop Hex dictation');
    button().click();
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({
      payload: { action: 'stop', provider: 'hex' },
    });
    reply(true, true, undefined, 'processing', 'hex');
    expect(button().disabled).toBe(false);
    button().click();
    flushSolid();
    reply(true, true, undefined, 'recording', 'hex');
    button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({
      payload: { action: 'cancel', provider: 'hex' },
    });
    reply(true, true, undefined, 'idle', 'hex');
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('names Hex in the stopped-app tooltip', () => {
    mount();
    flushSolid();
    reply(true, false, undefined, 'idle', 'hex');
    button().dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(1000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Open Hex to dictate');
    expect(button().disabled).toBe(true);
  });

  it('is hidden without Handy and never probes remote hosts', () => {
    mount(true);
    flushSolid();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBeNull();
    dispose?.();
    flushSolid();
    mount();
    flushSolid();
    reply(false, false);
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the microphone disabled when Handy is installed but stopped', () => {
    mount();
    flushSolid();
    reply(true, false);
    expect(button().disabled).toBe(true);
    expect(
      button().querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(microphoneIcon));
  });

  it('focuses the composer, prevents repeat clicks, and changes icons only after acknowledgement', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'start' } });
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(activationChange).not.toHaveBeenCalled();
    button().click();
    flushSolid();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(activationChange).toHaveBeenLastCalledWith(true);
    expect(
      button().querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(microphoneSpeakingSolidIcon));
    button().click();
    flushSolid();
    expect(activationChange).toHaveBeenCalledTimes(1);
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(activationChange).toHaveBeenLastCalledWith(false);
  });

  it('explains the normal two-click dictation flow in short tooltips', () => {
    mount();
    flushSolid();
    reply();
    button().dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(1_000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Click to dictate. Click again when done.'
    );
    button().click();
    flushSolid();
    reply();
    button().dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(1_000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Click to finish dictation'
    );
  });

  it('preserves mouse focus and supports cancellation with right-click', () => {
    mount();
    flushSolid();
    reply();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button().dispatchEvent(event);
    flushSolid();
    expect(event.defaultPrevented).toBe(true);
    button().click();
    flushSolid();
    reply();
    button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'cancel' } });
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(activationChange.mock.calls.map(([requested]) => requested)).toEqual([true, false]);
  });

  it.each([
    { available: false, running: true, error: undefined },
    { available: true, running: false, error: undefined },
    { available: true, running: true, error: 'Handy is unavailable' },
  ])('clears input feedback when Handy status becomes $available/$running/$error', (status) => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    reply();
    expect(activationChange).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    reply(status.available, status.running, status.error);
    expect(activationChange).toHaveBeenLastCalledWith(false);
  });

  it('clears input feedback on a command timeout and on disposal', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    vi.advanceTimersByTime(25_000);
    flushSolid();
    expect(activationChange).toHaveBeenLastCalledWith(false);
    button().click();
    flushSolid();
    reply();
    expect(activationChange).toHaveBeenLastCalledWith(true);
    dispose?.();
    flushSolid();
    dispose = undefined;
    expect(activationChange).toHaveBeenLastCalledWith(false);
  });

  it('ignores unrelated responses and reports failures without replaying commands', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    mocks.context.handler?.({
      type: 'dictation/result',
      payload: { requestId: 'other', available: true, running: true, state: 'idle' },
    });
    expect(button().disabled).toBe(true);
    reply(true, true, 'CLI failed');
    expect(mocks.feedback).toHaveBeenCalledWith('CLI failed', 'warning');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    button().click();
    flushSolid();
    vi.advanceTimersByTime(25_000);
    flushSolid();
    expect(mocks.feedback).toHaveBeenLastCalledWith(
      expect.stringContaining('Check its recording state'),
      'warning'
    );
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });

  it('refreshes availability and stops all work on unmount', () => {
    mount();
    flushSolid();
    reply(false, false);
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    reply();
    expect(button().disabled).toBe(false);
    vi.advanceTimersByTime(30_000);
    flushSolid();
    reply(true, false);
    expect(button().disabled).toBe(true);
    dispose?.();
    flushSolid();
    dispose = undefined;
    const calls = mocks.post.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    flushSolid();
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    expect(mocks.post).toHaveBeenCalledTimes(calls);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('preserves one mic click during a focus-triggered status probe', () => {
    mount();
    flushSolid();
    reply();
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    button().click();
    flushSolid();
    button().click();
    flushSolid();
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalled();
    reply();
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'start' } });
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('aria-busy')).toBe('false');
    expect(mocks.feedback).not.toHaveBeenCalled();
  });

  it('never disables the next recording because Handy omitted its final idle event', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    reply(true, true, undefined, 'processing');
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    button().dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    vi.advanceTimersByTime(1_000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Click to dictate. Click again when done.'
    );
    button().click();
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'start' } });
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves finish intent if the focus probe discovers cancellation outside Varro', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    reply();
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    button().click();
    flushSolid();
    reply(true, true, undefined, 'idle');
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'stop' } });
    reply(true, true, undefined, 'idle');
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('does not lose a queued click when the read-only probe times out', () => {
    mount();
    flushSolid();
    reply();
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    button().click();
    flushSolid();
    vi.advanceTimersByTime(25_000);
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'start' } });
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(mocks.feedback).not.toHaveBeenCalled();
  });

  it('accepts external idle updates and rejects stale status replies without extra polling', () => {
    mount();
    flushSolid();
    reply();
    button().click();
    flushSolid();
    const start = mocks.post.mock.calls.at(-1)?.[0];
    if (start?.type !== 'dictation/request') throw new Error('Missing start command');
    reply();
    window.dispatchEvent(new Event('focus'));
    flushSolid();
    const status = mocks.post.mock.calls.at(-1)?.[0];
    if (status?.type !== 'dictation/request') throw new Error('Missing status request');
    mocks.context.handler?.({
      type: 'dictation/result',
      payload: {
        requestId: start.payload.requestId,
        available: true,
        running: true,
        state: 'idle',
        revision: 3,
      },
    });
    flushSolid();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    mocks.context.handler?.({
      type: 'dictation/result',
      payload: {
        requestId: status.payload.requestId,
        available: true,
        running: true,
        state: 'recording',
        revision: 2,
      },
    });
    flushSolid();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    const count = mocks.post.mock.calls.length;
    vi.advanceTimersByTime(29_000);
    flushSolid();
    expect(mocks.post).toHaveBeenCalledTimes(count);
    button().click();
    flushSolid();
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'start' } });
  });
});
