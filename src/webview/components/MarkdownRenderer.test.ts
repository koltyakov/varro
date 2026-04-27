import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MarkdownRenderer } from './MarkdownRenderer';
import { setState } from '../lib/state';

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
  setState('editorContext', {
    workspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
  });
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

  it('strips dangerous attributes from allowed html', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '<a href="https://example.test" onclick="alert(1)" style="color:red">Link</a><svg><path d="M0 0" onload="alert(1)" /></svg>',
        }),
      container!
    );

    const link = container?.querySelector('a');
    const path = container?.querySelector('path');

    expect(link?.hasAttribute('onclick')).toBe(false);
    expect(link?.hasAttribute('style')).toBe(false);
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(path?.hasAttribute('onload')).toBe(false);
  });

  it('opens local markdown file links through VS Code', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }),
      container!
    );

    const link = container?.querySelector('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src/webview/App.tsx', kind: 'file', line: undefined },
    });
  });

  it('re-renders workspace-relative links when the workspace changes', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }),
      container!
    );

    expect(container?.querySelector('a.file-path-link')?.getAttribute('href')).toBe(
      './src/webview/App.tsx'
    );

    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const link = container?.querySelector('a.file-path-link');
    expect(link?.getAttribute('href')).toBe('/repo/src/webview/App.tsx');
    expect(link?.getAttribute('data-file')).toContain('/repo/src/webview/App.tsx');
  });

  it('does not linkify file-like text inside code blocks or inline code', async () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '`./src/webview/App.tsx`\n\n```txt\n./src/webview/App.tsx\n```',
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);
    expect(container?.querySelectorAll('code')).not.toHaveLength(0);
  });

  it('sanitizes copied code payloads before writing to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const oversized = 'A'.repeat(25_000);
    cleanup = render(() => MarkdownRenderer({ content: '```txt\nplaceholder\n```' }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const button = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    button!.dataset.copyText = `line%201%0D%0Aline%202%00${encodeURIComponent(oversized)}`;
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toBe(`line 1\nline 2${'A'.repeat(19_987)}`);
    expect(copied).toHaveLength(20_000);
    expect(copied.includes('\u0000')).toBe(false);
  });

  it('renders fenced code blocks with syntax highlight spans when the language is known', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: '```ts\nconst value = 1;\n```' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.querySelector('.hljs-number')?.textContent).toBe('1');
  });

  it('falls back to escaped plain code when the language is unknown', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: '```definitely-not-a-lang\nconst value = 1;\n```' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');
  });
});
