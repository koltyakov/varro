import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MarkdownRenderer } from './MarkdownRenderer';

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

describe('MarkdownRenderer', () => {
  it('sanitizes unsafe html while keeping safe external links routable', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            'Safe <strong>text</strong><script>alert(1)</script><img src="https://example.test/x.png" onerror="alert(1)" /> [Docs](https://opencode.ai) [Bad](javascript:alert(1))',
        }),
      container!
    );

    expect(container?.querySelector('script')).toBeNull();
    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).not.toContain('alert(1)');

    const links = Array.from(container?.querySelectorAll('a') || []);
    const docsLink = links.find((link) => link.textContent === 'Docs');
    const badLink = links.find((link) => link.textContent === 'Bad');

    expect(docsLink?.getAttribute('data-external')).toBe('true');
    expect(badLink?.hasAttribute('href')).toBe(false);

    docsLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
  });

  it('opens local markdown file links through VS Code', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }),
      container!
    );

    const link = container?.querySelector('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: './src/webview/App.tsx', kind: 'file', line: undefined },
    });
  });
});
