import { ErrorBoundary, Show, Suspense, createSignal, lazy } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postMessage } from '../../lib/bridge';
import { SettingsPanelBoundary } from './SettingsPanelBoundary';

// oxlint-disable-next-line anti-slop/no-module-mocking -- Capture extension messages without installing a webview host.
vi.mock('../../lib/bridge', () => ({ postMessage: vi.fn(() => true) }));

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.mocked(postMessage).mockClear();
});

describe('SettingsPanelBoundary', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://example.test/ModelsPanel-old.js',
    'Importing a module script failed.',
    'error loading dynamically imported module: https://example.test/ModelsPanel-old.js',
    'Unable to preload CSS for https://example.test/ModelsPanel-old.css',
  ])('contains a lazy import failure without disposing chat: %s', async (message) => {
    const [open, setOpen] = createSignal(true);
    const outerFallback = vi.fn(() => 'Whole chat failed');
    const LazyPanel = lazy(() => Promise.reject(new TypeError(message)));
    cleanup = render(
      () => (
        <ErrorBoundary fallback={outerFallback}>
          <input aria-label="Draft" value="Keep this draft" />
          <Show when={open()}>
            <SettingsPanelBoundary
              name="Models"
              panelClass="models-panel"
              onClose={() => setOpen(false)}
            >
              <Suspense fallback="Loading models">
                <LazyPanel />
              </Suspense>
            </SettingsPanelBoundary>
          </Show>
        </ErrorBoundary>
      ),
      document.body
    );
    const draft = document.body.querySelector('input');
    expect(document.body.textContent).toContain('Loading models');
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'Models could not load'
      );
    });
    expect(document.body.querySelector('.models-panel')?.textContent).toContain(
      'updated or reinstalled'
    );
    expect(outerFallback).not.toHaveBeenCalled();
    expect(document.body.querySelector('input')).toBe(draft);
    expect(draft?.value).toBe('Keep this draft');
    const back = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Back to chat'
    );
    back?.click();
    expect(open()).toBe(false);
    expect(document.body.querySelector('.models-panel')).toBeNull();
    expect(document.body.querySelector('input')).toBe(draft);

    // Browsers can cache a rejected import. Reopening must remain contained too.
    setOpen(true);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Models could not load');
    });
    expect(outerFallback).not.toHaveBeenCalled();
  });

  it('preserves runtime error details and reloads only when requested', () => {
    const error = new Error('Invalid model catalog');
    function BrokenPanel(): never {
      throw error;
    }
    cleanup = render(
      () => (
        <SettingsPanelBoundary name="Models" panelClass="models-panel" onClose={vi.fn()}>
          <BrokenPanel />
        </SettingsPanelBoundary>
      ),
      document.body
    );
    expect(document.body.textContent).toContain('Invalid model catalog');
    expect(document.body.textContent).not.toContain('updated or reinstalled');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'log',
      payload: {
        msg: 'settings-panel:Models',
        error: error.stack,
        level: 'error',
      },
    });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'webview/reload' });
    const reload = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Reload sidebar'
    );
    reload?.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'webview/reload' });
  });
});
