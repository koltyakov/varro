import { createComponent, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import DOMPurify from 'dompurify';
import {
  __resetMarkdownCachesForTests,
  MarkdownRenderer,
  renderHighlightedCodeHtml,
  splitStreamingMarkdownContent,
} from './MarkdownRenderer';
import { setState } from '../lib/state';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function assertInertWithSafeAnchor(root: ParentNode) {
  expect(root.querySelector('script')).toBeNull();
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('style')).toBeNull();

  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on')).toBe(false);
    }
  }

  const anchor = root.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.textContent).toBe('Safe docs');
  expect(anchor?.getAttribute('href')).toBe('https://example.test/docs');
  expect(anchor?.getAttribute('data-external')).toBe('true');
}

beforeEach(() => {
  __resetMarkdownCachesForTests();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MarkdownRenderer', () => {
  it('splits streaming markdown at the last safe paragraph boundary', () => {
    expect(splitStreamingMarkdownContent('First paragraph\n\nSecond paragraph')).toEqual({
      stableContent: 'First paragraph',
      tailContent: 'Second paragraph',
    });

    expect(splitStreamingMarkdownContent('```ts\nconst value = 1;\n\n')).toEqual({
      stableContent: '',
      tailContent: '```ts\nconst value = 1;\n\n',
    });
  });

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

  // Namespace-confusion payloads: these re-parse into a different tree than they
  // serialize from, which is how a sanitize -> serialize -> re-parse pipeline
  // resurrects script. Rendering must not yield executable markup for any of
  // them, and must reach a fixed point (re-rendering the output changes nothing
  // dangerous).
  const mutationXssPayloads: Array<[string, string]> = [
    ['svg/style breakout', '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
    [
      'math/mglyph breakout',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mtext&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    ],
    ['noscript breakout', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    [
      'form/mglyph breakout',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    ],
    ['svg foreignObject breakout', '<svg><foreignObject><p><style><img src=1 onerror=alert(1)>'],
    ['comment breakout', '<svg><!--</svg><img src=1 onerror=alert(1)>-->'],
  ];

  for (const [name, payload] of mutationXssPayloads) {
    it(`does not resurrect script from a ${name} payload`, () => {
      cleanup = render(() => MarkdownRenderer({ content: payload }), container!);

      const html = container?.innerHTML ?? '';
      expect(container?.querySelector('script')).toBeNull();
      expect(container?.querySelector('img')).toBeNull();
      expect(container?.querySelector('style')).toBeNull();
      expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
      expect(html).not.toContain('alert(1)');

      // Parser fixed point: feed the rendered markup straight back into the HTML
      // parser with no sanitizer in between. Re-rendering it through
      // MarkdownRenderer would just re-sanitize and prove nothing — the property
      // under test is that the string we hand to `innerHTML` cannot itself parse
      // into something executable.
      const sink = document.createElement('div');
      sink.innerHTML = html;

      expect(sink.querySelector('script')).toBeNull();
      expect(sink.querySelector('img')).toBeNull();
      expect(sink.querySelector('style')).toBeNull();
      expect(sink.querySelectorAll('*').length).toBe(container?.querySelectorAll('*').length);
      for (const element of Array.from(sink.querySelectorAll('*'))) {
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name.startsWith('on')).toBe(false);
        }
      }
      // Serializing the reparsed tree must not drift either; a tree that
      // re-serializes differently is the signature of a mutation payload.
      expect(sink.innerHTML).toBe(html);
    });
  }

  it('keeps a safe external anchor inert alongside namespace-confusion markup', () => {
    const payload =
      '<a href=" https://example.test/docs ">Safe docs</a><svg></p><style><a id="</style><img src=1 onerror=alert(1)>">';

    cleanup = render(() => MarkdownRenderer({ content: payload }), container!);

    assertInertWithSafeAnchor(container!);

    const sink = document.createElement('div');
    sink.innerHTML = container?.innerHTML ?? '';
    assertInertWithSafeAnchor(sink);
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

  it('does not treat protocol-relative links as local files', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () => MarkdownRenderer({ content: '[External-ish](//example.test/path)' }),
      container!
    );

    const link = container?.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(send).not.toHaveBeenCalled();
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

  it('uses the same copy icon on initial render and after reset', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    cleanup = render(
      () => MarkdownRenderer({ content: '```ts\nconst value = 1;\n```' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const button = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    expect(button).toBeTruthy();
    const initialIcon = button!.innerHTML;

    vi.useFakeTimers();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(button!.innerHTML).not.toBe(initialIcon);

    vi.advanceTimersByTime(1500);
    expect(button!.innerHTML).toBe(initialIcon);
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

  it.each([
    ['go', 'package main\nfunc main() {}'],
    ['rust', 'fn main() { let value = 1; }'],
    ['sql', 'select * from users;'],
    ['java', 'class Main {}'],
    ['cpp', '#include <iostream>\nint main() { return 0; }'],
  ])('highlights common language %s', (lang, source) => {
    expect(renderHighlightedCodeHtml(source, lang)).toContain('hljs-');
  });

  it.each([
    ['js', 'const value = 1;', 'hljs-keyword'],
    ['tsx', 'const node = <div />;', 'hljs-keyword'],
    ['py', 'def greet():\n    pass', 'hljs-keyword'],
    ['html', '<main>hello</main>', 'hljs-tag'],
    ['yml', 'key: value', 'hljs-attr'],
  ])('highlights language alias %s', (lang, source, expectedClass) => {
    expect(renderHighlightedCodeHtml(source, lang)).toContain(expectedClass);
  });

  it('handles explicit plain text languages without highlighting', () => {
    expect(renderHighlightedCodeHtml('plain <text>', 'txt')).toBe('plain &lt;text&gt;');
  });

  it('reuses sanitized html for cached finalized content across remounts', async () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');
    const content = 'Finalized cache test `7mwnc`';

    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);

    cleanup?.();
    cleanup = undefined;

    container = document.createElement('div');
    document.body.appendChild(container);

    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not cache transient sanitization across remounts', async () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');
    const content = 'Streaming cache bypass test `d9q2p`';

    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const callsAfterFirstMount = sanitizeSpy.mock.calls.length;
    expect(callsAfterFirstMount).toBeGreaterThan(0);

    cleanup?.();
    cleanup = undefined;

    container = document.createElement('div');
    document.body.appendChild(container);

    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(sanitizeSpy.mock.calls.length).toBe(callsAfterFirstMount + 1);
  });

  it('renders streaming content in stable and tail segments', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: 'First paragraph\n\nSecond paragraph' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const stableSegment = container?.querySelector('[data-markdown-segment="stable"]');
    const tailSegment = container?.querySelector('[data-markdown-segment="tail"]');

    expect(stableSegment?.innerHTML).toContain('<p>First paragraph</p>');
    expect(tailSegment?.innerHTML).toContain('<p>Second paragraph</p>');
  });

  it('does not reparse the stable streaming segment when only the tail grows', async () => {
    const [content, setContent] = createSignal('First paragraph\n\nSecond');
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const stableSegment = container?.querySelector('[data-markdown-segment="stable"]');
    const initialStableHtml = stableSegment?.innerHTML;
    const initialSanitizeCalls = sanitizeSpy.mock.calls.length;

    setContent('First paragraph\n\nSecond paragraph extended');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('[data-markdown-segment="stable"]')?.innerHTML).toBe(
      initialStableHtml
    );
    expect(sanitizeSpy.mock.calls.length).toBeGreaterThan(initialSanitizeCalls);
    expect(sanitizeSpy.mock.calls.length - initialSanitizeCalls).toBe(1);
  });

  it('skips file-path linkification in the streaming tail', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: 'Stable paragraph\n\n./src/webview/App.tsx' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const stableLinks = container?.querySelectorAll(
      '[data-markdown-segment="stable"] a.file-path-link'
    );
    const tailLinks = container?.querySelectorAll(
      '[data-markdown-segment="tail"] a.file-path-link'
    );

    expect(stableLinks).toHaveLength(0);
    expect(tailLinks).toHaveLength(0);
    expect(container?.textContent).toContain('./src/webview/App.tsx');
  });

  it('defers syntax highlighting for an unclosed streaming fence until the fence closes', async () => {
    let content = 'Before\n\n```ts\nconst value = 1;';

    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    let code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');

    content = 'Before\n\n```ts\nconst value = 1;\n```';
    cleanup?.();
    container!.innerHTML = '';
    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.querySelector('.hljs-number')?.textContent).toBe('1');
  });

  it('defers first-pass highlighting for completed streaming tail fences until idle', async () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal('Stable paragraph\n\nTail');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);

    setContent('Stable paragraph\n\n```ts\nconst value = 1;\n```');
    await vi.advanceTimersByTimeAsync(16);

    let code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');

    await vi.runOnlyPendingTimersAsync();

    code = container?.querySelector('.interactive-result-code-block code');
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
