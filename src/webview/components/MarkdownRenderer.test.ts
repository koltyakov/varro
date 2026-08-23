import { createComponent, createSignal } from 'solid-js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import DOMPurify from 'dompurify';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  getMermaidThemeConfigForTests,
  MarkdownRenderer,
  renderCodeBlockHtml,
  renderHighlightedCodeHtml,
  renderMermaidWithColdRetryForTests,
  resetMermaidDiagramsForThemeForTests,
  splitStreamingMarkdownContent,
} from './MarkdownRenderer';
import { setState, setTheme } from '../lib/state';
import { loadCodeHighlighter } from '../lib/code-highlighter';
import { checkIcon, copyIcon, expandIcon, xmarkIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}

declare global {
  interface Window {
    __sendToExtension?: (message: TestRuntimeValue) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
const selectSessionMock = vi.hoisted(() => vi.fn());
const showSessionActionFeedbackMock = vi.hoisted(() => vi.fn());
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => ({ diagramType: 'flowchart' })),
  render: vi.fn(async () => ({ svg: '<svg></svg>' })),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise markdown action integration with useOpenCode and feedback modules. */
vi.mock('../hooks/useOpenCode', () => ({
  selectSession: selectSessionMock,
}));
vi.mock('./chat/SessionActionFeedback', () => ({
  showSessionActionFeedback: showSessionActionFeedbackMock,
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

beforeAll(() => loadCodeHighlighter());

function assertInertWithSafeAnchor(root: ParentNode) {
  expect(root.querySelector('script')).toBeNull();
  expect(root.querySelector('img:not(.external-link-icon)')).toBeNull();
  expect(root.querySelector('style')).toBeNull();

  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on')).toBe(false);
    }
  }

  const anchor = root.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.textContent).toBe('Safe docs');
  expect(anchor?.getAttribute('aria-label')).toBe('Safe docs');
  expect(anchor?.getAttribute('href')).toBe('https://example.test/docs');
  expect(anchor?.getAttribute('data-external')).toBe('true');
}

function dispatchAnchorClick(anchor: HTMLAnchorElement | null | undefined) {
  anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function expectUiIcon(element: Element | null | undefined, source: string, size: number) {
  expect(element).toBeInstanceOf(HTMLSpanElement);
  expect(element?.classList).toContain('ui-icon');
  if (!(element instanceof HTMLSpanElement)) throw new Error('Expected UI icon element');
  expect(element.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(source));
  expect(element.style.getPropertyValue('--ui-icon-width')).toBe(`${size}px`);
  expect(element.style.getPropertyValue('--ui-icon-height')).toBe(`${size}px`);
}

beforeEach(() => {
  __resetMarkdownCachesForTests();
  document.body.className = '';
  showSessionActionFeedbackMock.mockReset();
  mermaidMock.initialize.mockReset();
  mermaidMock.parse.mockReset().mockResolvedValue({ diagramType: 'flowchart' });
  mermaidMock.render.mockReset().mockResolvedValue({ svg: '<svg></svg>' });
  document.body.removeAttribute('style');
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
  selectSessionMock.mockReset();
  setState('sessions', []);
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
  it('renders raw HTML as text when HTML escaping is requested', () => {
    const html = __parseMarkdownForTests('**Review** <button type="button">Run</button>', {
      cacheByContent: true,
      escapeHtml: true,
    });
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('Review <button type="button">Run</button>');
  });

  it('does not reuse rendered Markdown for colliding content hashes', () => {
    const first = 'OcbLqTZb]B8V*RyFHEyj';
    const second = 'GifJgLaGm0`PdPJEHDaw';

    const firstHtml = __parseMarkdownForTests(first, { cacheByContent: true });
    const secondHtml = __parseMarkdownForTests(second, { cacheByContent: true });

    expect(secondHtml).not.toBe(firstHtml);
    expect(secondHtml).toContain('GifJgLaGm0`PdPJEHDaw');
  });

  it('retries a valid Mermaid diagram after a cold render failure', async () => {
    const mermaid = {
      initialize: vi.fn(),
      parse: vi.fn(() => Promise.resolve({ diagramType: 'flowchart' })),
      render: vi
        .fn()
        .mockRejectedValueOnce(new Error('cold layout failure'))
        .mockResolvedValueOnce({ svg: '<svg></svg>' }),
    };

    // SAFETY: The fixture provides the never fields read by this statement.
    await expect(
      renderMermaidWithColdRetryForTests(mermaid as never, 'flowchart TD\n  A --> B', {
        theme: 'base',
      })
    ).resolves.toEqual({ svg: '<svg></svg>' });

    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.parse).toHaveBeenCalledOnce();
  });

  it('does not retry Mermaid source that fails validation', async () => {
    const firstError = new Error('parse failure');
    const mermaid = {
      initialize: vi.fn(),
      parse: vi.fn(() => Promise.reject(new Error('invalid syntax'))),
      render: vi.fn(() => Promise.reject(firstError)),
    };

    // SAFETY: The fixture provides the never fields read by this statement.
    await expect(
      renderMermaidWithColdRetryForTests(mermaid as never, 'flowchart TD\n  A -->|', {
        theme: 'base',
      })
    ).rejects.toBe(firstError);

    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it('uses readable VS Code colors for dark Mermaid diagrams', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-background', '#202020');
    document.body.style.setProperty('--vscode-editor-foreground', '#eeeeee');
    document.body.style.setProperty('--vscode-input-background', '#303030');
    document.body.style.setProperty('--vscode-widget-border', '#777777');
    document.body.style.setProperty('--vscode-focusBorder', '#55aaff');

    const config = getMermaidThemeConfigForTests();

    expect(config.darkMode).toBe(true);
    expect(config.htmlLabels).toBe(false);
    expect(config.themeVariables).toMatchObject({
      background: '#202020',
      primaryColor: 'rgb(59, 59, 59)',
      primaryTextColor: '#eeeeee',
      lineColor: 'rgb(193, 193, 193)',
      actorLineColor: 'rgb(193, 193, 193)',
      signalTextColor: '#eeeeee',
      activationBorderColor: '#55aaff',
    });
  });

  it('uses restrained neutral fills for light Mermaid diagrams', () => {
    document.body.className = 'vscode-light';
    document.body.style.setProperty('--vscode-editor-background', '#ffffff');
    document.body.style.setProperty('--vscode-editor-foreground', '#202020');
    document.body.style.setProperty('--vscode-input-background', '#ffffff');
    document.body.style.setProperty('--vscode-widget-border', '#b0b0b0');
    document.body.style.setProperty('--vscode-focusBorder', '#0066b8');

    const config = getMermaidThemeConfigForTests();

    expect(config.darkMode).toBe(false);
    expect(config.themeVariables).toMatchObject({
      background: '#ffffff',
      primaryColor: 'rgb(242, 242, 242)',
      secondaryColor: 'rgb(233, 233, 233)',
      tertiaryColor: 'rgb(248, 248, 248)',
      primaryTextColor: '#202020',
      lineColor: 'rgb(103, 103, 103)',
      actorBkg: 'rgb(242, 242, 242)',
      edgeLabelBackground: '#ffffff',
      activationBorderColor: '#0066b8',
    });
  });

  it('invalidates completed Mermaid SVGs when the theme changes', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="mermaid-diagram" data-mermaid-source="graph%20TD" data-mermaid-hydrated="complete">
        <div class="mermaid-diagram-toolbar"></div>
        <div class="mermaid-diagram-output"><svg></svg></div>
        <div hidden class="mermaid-diagram-fallback"></div>
      </div>
    `;
    const diagram = root.querySelector<HTMLElement>('.mermaid-diagram')!;

    resetMermaidDiagramsForThemeForTests(root);

    expect(diagram.dataset.mermaidHydrated).toBeUndefined();
    expect(diagram.querySelector('.mermaid-diagram-output')).toBeNull();
    expect(diagram.querySelector('.mermaid-diagram-toolbar')).toBeNull();
    expect(diagram.querySelector('.mermaid-diagram-status')?.textContent).toContain(
      'Rendering diagram...'
    );
    expect(diagram.querySelector('.mermaid-diagram-fallback')?.hasAttribute('hidden')).toBe(true);
  });

  it('does not mount an in-flight Mermaid render from the previous theme', async () => {
    setTheme('dark');
    document.body.className = 'vscode-dark';
    let resolveOldRender!: (value: { svg: string }) => void;
    mermaidMock.render
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            resolveOldRender = resolve;
          })
      )
      .mockResolvedValueOnce({ svg: '<svg><text>new theme</text></svg>' });
    cleanup = render(
      () => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }),
      container!
    );
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledOnce());

    document.body.className = 'vscode-light';
    setTheme('light');
    resolveOldRender({ svg: '<svg><text>old theme</text></svg>' });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));

    expect(container?.querySelector('.mermaid-diagram-output')?.textContent).toBe('new theme');
  });

  it('emits a Mermaid hydration target only for Mermaid code fences', () => {
    const mermaidHtml = __parseMarkdownForTests('```mermaid\ngraph TD\n  A --> B\n```', {
      cacheByContent: false,
    });
    const regularHtml = __parseMarkdownForTests('```ts\nconst value = 1;\n```', {
      cacheByContent: false,
    });

    expect(mermaidHtml).toContain('class="mermaid-diagram"');
    expect(mermaidHtml).toContain('data-mermaid-source=');
    const parsed = document.createElement('div');
    parsed.innerHTML = mermaidHtml;
    expect(parsed.querySelector('.mermaid-diagram-fallback')?.hasAttribute('hidden')).toBe(true);
    expect(mermaidHtml).toContain('graph TD');
    expect(regularHtml).not.toContain('data-mermaid-source');
  });

  it('keeps an incomplete streaming Mermaid fence as a placeholder', () => {
    const html = __parseMarkdownForTests('```mermaid\nflowchart TD\n  A -->|', {
      cacheByContent: false,
      disableCodeHighlighting: true,
    });

    expect(html).toContain('mermaid-diagram-pending');
    expect(html).toContain('Rendering diagram...');
    expect(html).not.toContain('data-mermaid-source');
    expect(html).not.toContain('flowchart TD');
  });

  it('hydrates completed Mermaid fences when lightweight rendering disables highlighting', () => {
    const html = __parseMarkdownForTests('```mermaid\nflowchart TD\n  A --> B\n```', {
      cacheByContent: false,
      disableCodeHighlighting: true,
      allowMermaidHydration: true,
    });

    expect(html).toContain('data-mermaid-source=');
    expect(html).not.toContain('mermaid-diagram-pending');
  });

  it('renders imperative Mermaid controls while preserving generated SVG output', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>',
    });
    cleanup = render(
      () => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }),
      container!
    );
    await vi.waitFor(() =>
      expect(container?.querySelector('.mermaid-diagram-toolbar')).not.toBeNull()
    );

    const copyButton = container?.querySelector<HTMLButtonElement>('button[data-mermaid-copy]');
    const expandButton = container?.querySelector<HTMLButtonElement>('button[data-mermaid-expand]');
    expectUiIcon(copyButton?.firstElementChild, copyIcon, 14);
    expectUiIcon(expandButton?.firstElementChild, expandIcon, 14);
    expect(container?.querySelector('.mermaid-diagram-output > svg path')).not.toBeNull();

    expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const closeButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close diagram preview"]'
    );
    expectUiIcon(closeButton?.firstElementChild, xmarkIcon, 14);
  });

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

  it('sanitizes html while keeping safe external links and images routable', () => {
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
    const image = container?.querySelector<HTMLImageElement>('img:not(.external-link-icon)');
    expect(image?.getAttribute('src')).toBe('https://example.test/x.png');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(image?.hasAttribute('onerror')).toBe(false);
    expect(container?.textContent).not.toContain('alert(1)');

    const links = Array.from(container?.querySelectorAll('a') || []);
    const docsLink = links.find((link) => link.textContent === 'Docs');
    const badLink = links.find((link) => link.textContent === 'Bad');

    expect(docsLink?.getAttribute('data-external')).toBe('true');
    expect(docsLink?.classList).toContain('external-link');
    expect(docsLink?.firstElementChild?.classList).toContain('link-leading-content');
    expect(docsLink?.firstElementChild?.firstElementChild?.classList).toContain(
      'external-link-icon'
    );
    expect(docsLink?.querySelector('.link-leading-label')?.textContent).toBe('D');
    expect(docsLink?.querySelector('.external-link-icon')).toBeInstanceOf(HTMLImageElement);
    expect(badLink?.hasAttribute('href')).toBe(false);
    expect(badLink?.querySelector('.external-link-icon')).toBeNull();

    dispatchAnchorClick(docsLink);

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
  });

  it('renders linked badge markdown as images', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro) [![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)',
        }),
      container!
    );

    const images = Array.from(
      container?.querySelectorAll<HTMLImageElement>('img:not(.external-link-icon)') || []
    );
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute('src')).toBe(
      'https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4'
    );
    expect(images[0]?.getAttribute('alt')).toBe('Visual Studio Marketplace');
    expect(images[0]?.getAttribute('loading')).toBe('lazy');

    const link = images[0]?.closest('a');
    expect(link?.getAttribute('aria-label')).toBe('Visual Studio Marketplace');
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(link?.querySelector('.external-link-icon')).toBeNull();
  });

  it('removes images with non-HTTPS sources', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '![Local](file:///tmp/image.png) <img src="data:image/png;base64,AA==" alt="Embedded"> <img src="javascript:alert(1)" alt="Bad">',
        }),
      container!
    );

    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toContain('Local');
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
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(link?.firstElementChild?.firstElementChild?.classList).toContain('external-link-icon');
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
      // MarkdownRenderer would just re-sanitize and prove nothing - the property
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

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);

    dispatchAnchorClick(link);

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/repo/src/webview/App.tsx',
        kind: 'file',
        line: undefined,
        requestId: expect.any(Number),
      },
    });
    // SAFETY: The fixture provides the { payload: { requestId: number } } fields read by this statement.
    const requestId = (send.mock.calls[0]![0] as { payload: { requestId: number } }).payload
      .requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
  });

  it('links file references with parenthesized line numbers', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () => MarkdownRenderer({ content: 'Review go.mod (line 3).', cacheByContent: true }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('go.mod (line 3)');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);

    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/go.mod', line: 3, kind: 'file', requestId: expect.any(Number) },
    });
    // SAFETY: The fixture provides the { payload: { requestId: number } } fields read by this statement.
    const requestId = (send.mock.calls[0]![0] as { payload: { requestId: number } }).payload
      .requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
  });

  it('disables a missing file link and shows warning feedback', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    cleanup = render(
      () => MarkdownRenderer({ content: '`missing-file.ts`', cacheByContent: true }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    dispatchAnchorClick(link);
    // SAFETY: The fixture provides the { payload: { requestId: number } } fields read by this statement.
    const requestId = (send.mock.calls[0]![0] as { payload: { requestId: number } }).payload
      .requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'unavailable' } },
      })
    );
    await Promise.resolve();

    expect(link?.classList.contains('is-unavailable')).toBe(true);
    expect(link?.getAttribute('aria-disabled')).toBe('true');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.title).toBe('File not found: missing-file.ts');
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'File not found: missing-file.ts',
      'warning'
    );

    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('warns when a file-path-link payload fails to parse', () => {
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

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    link!.dataset.file = '{invalid';

    dispatchAnchorClick(link);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'log',
      payload: {
        msg: 'markdown file-path-link payload parse',
        error: expect.any(String),
        level: 'warn',
      },
    });
  });

  it('links workspace session IDs using their session titles', () => {
    setState('sessions', [
      {
        id: 'ses_found123',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Permission request states',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);

    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            'Session session:ses_found123 and session:ses_missing456. `session:ses_found123`',
          cacheByContent: true,
        }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.session-reference-link');
    expect(link?.textContent).toBe('Permission request states');
    expect(link?.getAttribute('href')).toBe('#session/ses_found123');
    expect(link?.dataset.sessionId).toBe('ses_found123');
    expect(link?.querySelector('.session-reference-icon')).not.toBeNull();
    expect(link?.querySelector('.link-leading-content')?.textContent).toBe('Permission');
    expect(link?.querySelector('.link-leading-label')?.textContent).toBe('Permission');
    expect(container?.textContent).toContain('session:ses_missing456');
    expect(container?.querySelector('code a')).toBeNull();

    dispatchAnchorClick(link);
    expect(selectSessionMock).toHaveBeenCalledWith('ses_found123');
  });

  it('updates session references when a matching workspace session is discovered', async () => {
    const content = 'Open ses_discovered123';
    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);

    expect(container?.querySelector('a.session-reference-link')).toBeNull();
    expect(container?.textContent).toContain('ses_discovered123');

    setState('sessions', [
      {
        id: 'ses_discovered123',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Discovered session',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('a.session-reference-link')?.textContent).toBe(
      'Discovered session'
    );
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

    dispatchAnchorClick(link);
    expect(send).not.toHaveBeenCalled();
  });

  it('makes only HTTPS external links actionable', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '[Secure](https://example.test/docs) [Insecure](http://example.test/docs)',
        }),
      container!
    );

    const links = Array.from(container?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
    const secure = links.find((link) => link.textContent === 'Secure');
    const insecure = links.find((link) => link.textContent === 'Insecure');
    expect(secure?.getAttribute('data-external')).toBe('true');
    expect(secure?.getAttribute('href')).toBe('https://example.test/docs');
    expect(secure?.querySelector('.external-link-icon')).toBeInstanceOf(HTMLImageElement);
    expect(insecure?.hasAttribute('data-external')).toBe(false);
    expect(insecure?.hasAttribute('href')).toBe(false);
    expect(insecure?.querySelector('.external-link-icon')).toBeNull();

    dispatchAnchorClick(insecure);
    expect(send).not.toHaveBeenCalled();
    dispatchAnchorClick(secure);
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://example.test/docs' },
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

  it('links file-only inline code but not ordinary inline or fenced code', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '`spotlight` `src/shared/protocol.ts`\n\n```txt\nsrc/webview/App.tsx\n```',
          cacheByContent: true,
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(1);
    expect(link?.textContent).toBe('protocol.ts');
    expect(link?.querySelector('code')).toBeNull();
    expect(link?.title).toBe('/repo/src/shared/protocol.ts');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(link?.querySelector('.link-leading-label')?.textContent).toBe('protocol.ts');
    expect(container?.querySelector('pre a.file-path-link')).toBeNull();
    expect(container?.textContent).toContain('spotlight');

    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/repo/src/shared/protocol.ts',
        line: undefined,
        kind: 'file',
        requestId: expect.any(Number),
      },
    });
    // SAFETY: The fixture provides the { payload: { requestId: number } } fields read by this statement.
    const requestId = (send.mock.calls[0]![0] as { payload: { requestId: number } }).payload
      .requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
  });

  it('does not linkify dotted API identifiers as files', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            'Use workspace.fs, files.exclude, and search.exclude directly, including `workspace.fs` in code.',
          cacheByContent: true,
        }),
      container!
    );

    expect(container?.querySelector('a.file-path-link')).toBeNull();
    expect(container?.textContent).toContain('workspace.fs');
    expect(container?.textContent).toContain('files.exclude');
    expect(container?.textContent).toContain('search.exclude');
    expect(container?.querySelector('code')?.textContent).toBe('workspace.fs');
  });

  it('sanitizes copied code payloads before writing to the clipboard', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
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
    const copied = writeText.mock.calls[0]?.[0];
    if (copied === undefined) throw new Error('Expected clipboard text');
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
    expectUiIcon(button?.firstElementChild, copyIcon, 14);

    vi.useFakeTimers();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expectUiIcon(button?.firstElementChild, checkIcon, 14);

    vi.advanceTimersByTime(1500);
    expectUiIcon(button?.firstElementChild, copyIcon, 14);
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

  it('separates finalized markdown cache entries by render options', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const pathContent = 'See (./src/example.ts)';
    const withoutPathLinks = __parseMarkdownForTests(pathContent, {
      cacheByContent: true,
      disablePathLinkify: true,
    });
    const withPathLinks = __parseMarkdownForTests(pathContent, {
      cacheByContent: true,
      disablePathLinkify: false,
    });
    expect(withoutPathLinks).not.toContain('file-path-link');
    expect(withPathLinks).toContain('file-path-link');

    const codeContent = '```ts\nconst value = 1;\n```';
    const withoutHighlighting = __parseMarkdownForTests(codeContent, {
      cacheByContent: true,
      disableCodeHighlighting: true,
    });
    const withHighlighting = __parseMarkdownForTests(codeContent, {
      cacheByContent: true,
      disableCodeHighlighting: false,
    });
    expect(withoutHighlighting).not.toContain('hljs-keyword');
    expect(withHighlighting).toContain('hljs-keyword');
  });

  it('separates code block cache entries by highlighting mode', () => {
    const params = { text: 'const value = 1;', lang: 'ts' };
    expect(renderCodeBlockHtml({ ...params, disableHighlighting: true })).not.toContain(
      'hljs-keyword'
    );
    expect(renderCodeBlockHtml(params)).toContain('hljs-keyword');
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

  it('linkifies complete file references in the streaming tail', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    cleanup = render(
      () => MarkdownRenderer({ content: 'Stable paragraph\n\n`./src/webview/App.tsx`' }),
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
    expect(tailLinks).toHaveLength(1);
    expect(tailLinks?.[0]?.textContent).toBe('App.tsx');
    expect(tailLinks?.[0]?.getAttribute('title')).toBe('/repo/src/webview/App.tsx');
  });

  it('holds an unclosed inline-code suffix until its delimiter arrives', async () => {
    const [content, setContent] = createSignal(
      'The related tests are in `src/webview/components/Markdown'
    );
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

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

    const paragraph = container?.querySelector('[data-markdown-segment="tail"] p');
    expect(paragraph?.textContent).toBe('The related tests are in ');
    expect(container?.textContent).not.toContain('src/webview/components/Markdown');

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('[data-markdown-segment="tail"] p')).toBe(paragraph);
    expect(container?.textContent).not.toContain('MarkdownRenderer.test.ts');

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts`');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('MarkdownRenderer.test.ts');
    expect(link?.title).toBe('/repo/src/webview/components/MarkdownRenderer.test.ts');
    expect(container?.textContent).not.toContain('src/webview/components/');
  });

  it('holds an unfinished Markdown link until its destination closes', async () => {
    const [content, setContent] = createSignal(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation'
    );
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

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

    expect(container?.textContent?.trimEnd()).toBe(
      'Explicit local links use standard Markdown syntax. Open'
    );
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation]'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent?.trimEnd()).toBe(
      'Explicit local links use standard Markdown syntax. Open'
    );

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent?.trimEnd()).toBe(
      'Explicit local links use standard Markdown syntax. Open'
    );

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent?.trimEnd()).toBe(
      'Explicit local links use standard Markdown syntax. Open the renderer implementation or'
    );
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(1);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test suite](src/webview/components/MarkdownRenderer.test.ts)'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[1]?.textContent).toBe('its test suite');
    expect(links?.[1]?.title).toBe('/repo/src/webview/components/MarkdownRenderer.test.ts');
  });

  it('holds and linkifies trailing bare paths across path styles', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    const cases = [
      {
        partial: 'packages/client/components/FileTypeIcon',
        complete: 'packages/client/components/FileTypeIcon.tsx',
        title: '/repo/packages/client/components/FileTypeIcon.tsx',
      },
      {
        partial: '../shared/components/FileTypeIcon',
        complete: '../shared/components/FileTypeIcon.tsx',
        title: '/repo/../shared/components/FileTypeIcon.tsx',
      },
      {
        partial: '/opt/project/components/FileTypeIcon',
        complete: '/opt/project/components/FileTypeIcon.tsx',
        title: '/opt/project/components/FileTypeIcon.tsx',
      },
      {
        partial: String.raw`packages\client\components\FileTypeIcon`,
        complete: String.raw`packages\client\components\FileTypeIcon.tsx`,
        title: '/repo/packages/client/components/FileTypeIcon.tsx',
      },
      {
        partial: String.raw`C:\work\project\components\FileTypeIcon`,
        complete: String.raw`C:\work\project\components\FileTypeIcon.tsx`,
        title: 'C:/work/project/components/FileTypeIcon.tsx',
      },
    ];

    for (const testCase of cases) {
      const [content, setContent] = createSignal(`Bare path: ${testCase.partial}`);
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

      expect(container?.textContent?.trimEnd()).toBe('Bare path:');

      setContent(`Bare path: ${testCase.complete}`);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

      const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
      expect(link?.textContent).toBe('FileTypeIcon.tsx');
      expect(link?.title).toBe(testCase.title);

      cleanup();
      cleanup = undefined;
      container!.innerHTML = '';
    }
  });

  it('links Windows paths in inline code without withholding URLs', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    const content =
      'Windows: `C:\\work\\project\\App.tsx` and [open it](C:\\work\\project\\App.tsx)\n\nURL: https://example.test/folder/App';

    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[0]?.textContent).toBe('App.tsx');
    expect(links?.[0]?.title).toBe('C:/work/project/App.tsx');
    expect(links?.[1]?.textContent).toBe('open it');
    expect(links?.[1]?.title).toBe('C:/work/project/App.tsx');
    expect(container?.textContent).toContain('https://example.test/folder/App');
  });

  it('does not hold escaped backticks or content inside a streaming fence', async () => {
    const content = [
      'An escaped \\`backtick remains visible.',
      '',
      '```ts',
      'const path = `src/webview/components/Markdown',
    ].join('\n');

    cleanup = render(() => MarkdownRenderer({ content }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.textContent).toContain('An escaped `backtick remains visible.');
    expect(container?.textContent).toContain('src/webview/components/Markdown');
    expect(container?.querySelector('.interactive-result-code-block')).not.toBeNull();
  });

  it('shows unmatched inline code when the response is already complete', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: 'Malformed `inline content', cacheByContent: true }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.textContent).toContain('Malformed `inline content');
  });

  it('linkifies mixed-text file references when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content =
      '- Core protocol: `src/shared/protocol.ts` - shared contracts\n- Start with `docs/onboarding-verification.md` for onboarding.';
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content,
          get cacheByContent() {
            return completed();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const streamingLinks = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(streamingLinks).toHaveLength(2);
    expect(streamingLinks?.[0]?.textContent).toBe('protocol.ts');
    expect(streamingLinks?.[1]?.textContent).toBe('onboarding-verification.md');

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[0]?.textContent).toBe('protocol.ts');
    expect(links?.[0]?.title).toBe('/repo/src/shared/protocol.ts');
    expect(links?.[1]?.textContent).toBe('onboarding-verification.md');
    expect(links?.[1]?.title).toBe('/repo/docs/onboarding-verification.md');
    expect(container?.querySelectorAll('.file-path-icon')).toHaveLength(2);
    expect(links?.[0]).toBe(streamingLinks?.[0]);
    expect(links?.[1]).toBe(streamingLinks?.[1]);
  });

  it('preserves stable markdown DOM when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content = 'Stable paragraph.\n\nReview `src/shared/protocol.ts`.';
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content,
          get cacheByContent() {
            return completed();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const stableSegment = container?.querySelector<HTMLElement>('[data-markdown-segment="stable"]');
    const stableParagraph = stableSegment?.firstElementChild;
    const streamingLink = container?.querySelector('a.file-path-link');
    expect(stableParagraph?.textContent).toBe('Stable paragraph.');
    expect(streamingLink?.textContent).toBe('protocol.ts');

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(stableSegment?.firstElementChild).toBe(stableParagraph);
    expect(stableSegment?.style.display).toBe('contents');
    expect(container?.querySelector('a.file-path-link')).toBe(streamingLink);
  });

  it('does not revert final rendering when completion briefly regresses', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content = 'Stable paragraph.\n\nReview `src/shared/protocol.ts`.';
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content,
          get cacheByContent() {
            return completed();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const streamingLink = container?.querySelector('a.file-path-link');
    expect(streamingLink?.textContent).toBe('protocol.ts');

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const finalLink = container?.querySelector('a.file-path-link');
    expect(finalLink).toBe(streamingLink);

    setCompleted(false);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('a.file-path-link')).toBe(finalLink);

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('a.file-path-link')).toBe(finalLink);
  });

  it('canonicalizes explicit path labels containing inline-code backticks', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '[`src/shared/protocol.ts`](./src/shared/protocol.ts)',
          cacheByContent: true,
        }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('protocol.ts');
    expect(link?.textContent).not.toContain('`');
    expect(link?.querySelector('code')).toBeNull();
    expect(link?.title).toBe('/repo/src/shared/protocol.ts');
  });

  it('renders the target session file formats as isolated canonical links', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    const content = [
      '- Type declaration: [`src/webview/global.d.ts`](src/webview/global.d.ts) - browser globals',
      '- Main readme: [`README.md`](README.md) - project overview',
      '- License file: `LICENSE` - repository license',
      '- Git ignore rules → **`.gitignore`**',
      '- Docker image recipe: [`scripts/opencode-compatibility/Dockerfile`](scripts/opencode-compatibility/Dockerfile)',
      '- Main stylesheet: [`src/webview/index.css`](src/webview/index.css)',
    ].join('\n');

    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);

    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link') ?? []
    );
    expect(links.map((link) => link.textContent)).toEqual([
      'global.d.ts',
      'README.md',
      'LICENSE',
      '.gitignore',
      'Dockerfile',
      'index.css',
    ]);
    expect(links.every((link) => link.querySelector('code') === null)).toBe(true);
    expect(links.every((link) => link.querySelector('.file-path-icon') !== null)).toBe(true);
    expect(links.every((link) => link.querySelector('a') === null)).toBe(true);
    expect(container?.textContent).not.toContain('`');
  });

  it('removes escaped backticks around plain file references', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(
      () =>
        MarkdownRenderer({
          content: 'Type declaration: \\`src/webview/global.d.ts\\` - browser globals',
          cacheByContent: true,
        }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('global.d.ts');
    expect(container?.textContent).not.toContain('`');
    expect(link?.title).toBe('/repo/src/webview/global.d.ts');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);
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
