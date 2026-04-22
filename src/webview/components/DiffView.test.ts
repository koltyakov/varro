import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { DiffView } from './DiffView';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  delete window.__sendToExtension;
  vi.restoreAllMocks();
});

describe('DiffView', () => {
  it('opens the clicked diff file in VS Code', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        DiffView({
          diffs: [
            {
              file: 'src/webview/components/Chat.tsx',
              before: '',
              after: '',
              additions: 109,
              deletions: 41,
            },
          ],
        }),
      container!
    );

    const button = container?.querySelector('button.diff-view-item-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.textContent).toContain('src/webview/components/Chat.tsx');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/webview/components/Chat.tsx' },
    });
  });
});
