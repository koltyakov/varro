import {
  flush as flushSolid,
  createEffect,
  createComponent,
  createSignal,
  onCleanup,
} from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import DOMPurify from 'dompurify';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  getMermaidThemeConfigForTests,
  hydrateMermaidDiagramsForTests,
  MarkdownRenderer,
  renderCodeBlockHtml,
  renderHighlightedCodeHtml,
  renderMermaidWithColdRetryForTests,
  resetMermaidDiagramsForThemeForTests,
  splitStreamingMarkdownContent,
} from './MarkdownRenderer';
import { setState, setTheme } from '../lib/state';
import { installHighlightWorker, requestHighlight } from '../lib/highlight-worker.test-support';
import { clearDirectSessionReturn, getDirectSessionReturnId } from '../lib/session-navigation';
import { checkIcon, copyIcon, expandIcon, xmarkIcon } from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';
import { client } from '../lib/client';

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
// These existing tokenizer/action tests assume the cited files are valid.
// The real asynchronous validation is covered in MarkdownRenderer.citations.test.tsx.
vi.mock('./markdown-citation-links', () => ({
  MarkdownCitationLinks: class {
    hydrate(root?: HTMLElement) {
      for (const anchor of root?.querySelectorAll<HTMLElement>('a[data-file]') ?? []) {
        anchor.dataset.fileValidated = 'true';
      }
    }
    dispose() {}
  },
}));

beforeAll(installHighlightWorker);

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

function expectStreamingIndicator(root: ParentNode) {
  const indicator = root.querySelector('.streaming-markdown-indicator');
  expect(indicator?.getAttribute('role')).toBe('img');
  expect(indicator?.getAttribute('aria-label')).toBe('Streaming content');
  expect(indicator?.children).toHaveLength(3);
  expect(indicator?.textContent).toBe('');
  return indicator;
}

function dispatchAnchorClick(anchor: HTMLAnchorElement | null | undefined) {
  anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function withoutLinkTooltipAttributes(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const anchor of root.querySelectorAll('a')) {
    anchor.removeAttribute('title');
    anchor.removeAttribute('aria-describedby');
    anchor.removeAttribute('data-file-validated');
  }
  return root.innerHTML;
}

function expectUiIcon(element: Element | null | undefined, source: string, size: number) {
  expect(element).toBeInstanceOf(HTMLSpanElement);
  expect(element?.classList).toContain('ui-icon');
  if (!(element instanceof HTMLSpanElement)) throw new Error('Expected UI icon element');
  expect(element.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(source));
  expect(element.style.getPropertyValue('--ui-icon-width')).toBe(`${size}px`);
  expect(element.style.getPropertyValue('--ui-icon-height')).toBe(`${size}px`);
}

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}

function mount(view: Parameters<typeof render>[0]) {
  cleanup = render(view, container!);
  flushSolid();
}

function unmount() {
  if (!cleanup) throw new Error('Expected a mounted MarkdownRenderer');
  cleanup();
  cleanup = undefined;
  flushSolid();
}

beforeEach(() => {
  __resetMarkdownCachesForTests();
  applyState(storePath('remoteImages', 'off'));
  document.body.className = '';
  showSessionActionFeedbackMock.mockReset();
  mermaidMock.initialize.mockReset();
  mermaidMock.parse.mockReset().mockResolvedValue({ diagramType: 'flowchart' });
  mermaidMock.render.mockReset().mockResolvedValue({ svg: '<svg></svg>' });
  document.body.removeAttribute('style');
  flushSolid();
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
  selectSessionMock.mockReset();
  clearDirectSessionReturn();
  flushSolid();
  applyState(storePath('sessions', []));
  applyState(storePath('serverStatus', { state: 'stopped' }));
  applyState(storePath('activeSessionId', null));
  applyState(
    storePath('editorContext', {
      workspacePath: null,
      workspaceFolders: [],
      activeFile: null,
      selection: null,
      diagnostics: [],
    })
  );
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  delete window.__sendToExtension;
  vi.useRealTimers();
  vi.restoreAllMocks();
  flushSolid();
});

describe('MarkdownRenderer', () => {
  it.each([
    `Use "*" and '*'.`,
    `Use "**" and '**'.`,
    `Use "***" and '***'.`,
    '"*" followed by an unmatched word*',
    '"**" followed by an unmatched word**',
    '*unmatched words followed by "*"',
    '**unmatched words followed by "**"',
    'Use * with spaces and another * here.',
    `Use "_" and '_'.`,
    `Use "__" and '__'.`,
    `Use "___" and '___'.`,
    '"_" followed by an unmatched word_',
    '"__" followed by an unmatched word__',
    '_unmatched words followed by "_"',
    '__unmatched words followed by "__"',
    'Use _ with spaces and another _ here.',
  ])('keeps literal emphasis markers in %s', (content) => {
    container!.innerHTML = __parseMarkdownForTests(content, { cacheByContent: true });

    expect(container!.textContent?.trim()).toBe(content);
    expect(container!.querySelector('em, strong')).toBeNull();
  });

  it.each([
    { content: '*word*', selector: 'em', text: 'word' },
    { content: '*two words*', selector: 'em', text: 'two words' },
    { content: '**bold words**', selector: 'strong', text: 'bold words' },
    { content: `"*" then *word* and '*'`, selector: 'em', text: 'word' },
    { content: `'*word*'`, selector: 'em', text: 'word' },
    { content: `*use "*" and '*' here*`, selector: 'em', text: `use "*" and '*' here` },
    { content: `**use "**" and '**' here**`, selector: 'strong', text: `use "**" and '**' here` },
    { content: '_word_', selector: 'em', text: 'word' },
    { content: '_two words_', selector: 'em', text: 'two words' },
    { content: '__bold words__', selector: 'strong', text: 'bold words' },
    { content: `"_" then _word_ and '_'`, selector: 'em', text: 'word' },
    { content: `'_word_'`, selector: 'em', text: 'word' },
    { content: `_use "_" and '_' here_`, selector: 'em', text: `use "_" and '_' here` },
    { content: `__use "__" and '__' here__`, selector: 'strong', text: `use "__" and '__' here` },
  ])('preserves emphasis in $content', ({ content, selector, text }) => {
    container!.innerHTML = __parseMarkdownForTests(content, { cacheByContent: true });

    expect(container!.querySelectorAll('em, strong')).toHaveLength(1);
    expect(container!.querySelector(selector)?.textContent).toBe(text);
  });

  it.each(['*', '_'])('preserves quoted %s inside inline and fenced code', (marker) => {
    const code = `"${marker}" and '${marker}'`;
    container!.innerHTML = __parseMarkdownForTests(`\`${code}\`\n\n\`\`\`text\n${code}\n\`\`\``, {
      cacheByContent: true,
    });

    const blocks = container!.querySelectorAll('code');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toBe(code);
    expect(blocks[1]?.textContent?.trim()).toBe(code);
  });

  it.each(['*', '_'])(
    'keeps quoted %s literal as a message streams and settles',
    async (marker) => {
      const initial = `Use "${marker}"`;
      const complete = `${initial} and '${marker}'.`;
      const [content, setContent] = createSignal(initial);
      const [streaming, setStreaming] = createSignal(true);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          get forceStreaming() {
            return streaming();
          },
        })
      );

      for (const next of [initial, complete, `${complete}\n\nDone.`]) {
        setContent(next);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        flushSolid();
        expect(container!.textContent).toContain(initial);
        expect(container!.querySelector('em, strong')).toBeNull();
      }

      setStreaming(false);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container!.textContent).toContain(complete);
      expect(container!.querySelector('em, strong')).toBeNull();
    }
  );

  it.each([
    { header: '**#**', values: ['First stage', 'Second stage'], compact: true },
    { header: 'Stage', values: ['**1**', '`2`'], compact: true },
    { header: 'File', values: ['`src/first.ts`', '`src/second.ts`'], compact: false },
  ])('classifies the $header column before mounting the table', ({ header, values, compact }) => {
    const content = [
      `| ${header} | Description |`,
      '| --- | --- |',
      ...values.map((value) => `| ${value} | A description that needs room to wrap. |`),
    ].join('\n');
    container!.innerHTML = __parseMarkdownForTests(content, { cacheByContent: true });
    // Virtual rows can measure this HTML before MarkdownRenderer's onSettled hydration runs.
    expect(container!.querySelector('table')?.classList.contains('table-first-col-compact')).toBe(
      compact
    );
  });

  it.each([false, true])(
    'preserves full inferred paths across lightweight transitions starting at %s',
    async (initialLightweight) => {
      const [lightweight, setLightweight] = createSignal(initialLightweight);
      mount(() =>
        createComponent(MarkdownRenderer, {
          content:
            'See `/repo/src/webview/components/MarkdownRenderer.tsx:100-120`.\n\n' +
            'Also /repo/src/webview/components/MessageList.tsx:200-220.',
          cacheByContent: true,
          get lightweight() {
            return lightweight();
          },
        })
      );
      for (const value of [initialLightweight, !initialLightweight, initialLightweight]) {
        setLightweight(value);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        flushSolid();
        expect(
          [...container!.querySelectorAll('a.file-path-link')].map((link) => link.textContent)
        ).toEqual([
          '/repo/src/webview/components/MarkdownRenderer.tsx:100-120',
          '/repo/src/webview/components/MessageList.tsx:200-220',
        ]);
      }
    }
  );

  it('does not create inline roots after disposal before queued hydration', async () => {
    const warn = vi.spyOn(console, 'warn');
    const [value, setValue] = createSignal(0);
    const mounted = vi.fn();
    const effect = vi.fn();
    const disposed = vi.fn();
    mount(() =>
      MarkdownRenderer({
        content: 'SLOTMARKER',
        inlineSlots: [
          {
            marker: 'SLOTMARKER',
            render: () => {
              mounted();
              createEffect(value, (current) => {
                effect(current);
              });
              onCleanup(disposed);
              return document.createElement('button');
            },
          },
        ],
      })
    );
    expect(mounted).toHaveBeenCalledOnce();
    unmount();
    expect(disposed).toHaveBeenCalledOnce();
    const effectCount = effect.mock.calls.length;
    await Promise.resolve();
    flushSolid();
    setValue(1);
    flushSolid();
    expect(mounted).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledTimes(effectCount);
    expect(disposed).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('appends safe stable prose without replacing nodes or remounting inline slots', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    const [content, setContent] = createSignal('First SLOTONE https://example.test/one\n\nTail');
    const [value, setValue] = createSignal(0);
    const mounted = vi.fn();
    const disposed = vi.fn();
    const effect = vi.fn();
    const inlineSlots = ['SLOTONE', 'SLOTTWO'].map((marker) => ({
      marker,
      render: () => {
        mounted(marker);
        onCleanup(() => disposed(marker));
        const button = document.createElement('button');
        createEffect(value, (current) => {
          effect(marker, current);
          button.textContent = `${marker} ${value}`;
        });
        return button;
      },
    }));
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        inlineSlots,
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    mounted.mockClear();
    disposed.mockClear();
    const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
    const paragraph = stable.firstChild;
    const button = stable.querySelector('button');
    const link = stable.querySelector('a');
    const icon = link?.querySelector('.external-link-icon');
    setContent(
      'First SLOTONE https://example.test/one\n\nSecond SLOTTWO https://example.test/two\n\nTail'
    );
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(stable.firstChild).toBe(paragraph);
    expect(stable.querySelector('button')).toBe(button);
    expect(stable.querySelector('a')).toBe(link);
    expect(link?.querySelector('.external-link-icon')).toBe(icon);
    expect(mounted.mock.calls).toEqual([['SLOTTWO']]);
    expect(disposed).not.toHaveBeenCalled();
    setContent(`${content()}\n\nLast tail`);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(stable.firstChild).toBe(paragraph);
    expect(mounted).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
    effect.mockClear();
    setValue(1);
    flushSolid();
    expect(effect.mock.calls).toEqual([
      ['SLOTONE', 1],
      ['SLOTTWO', 1],
    ]);
    expect(stable.querySelectorAll('.external-link-icon')).toHaveLength(2);
    for (const anchor of stable.querySelectorAll('a')) dispatchAnchorClick(anchor);
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'vscode/open-external', payload: { url: 'https://example.test/one' } },
      { type: 'vscode/open-external', payload: { url: 'https://example.test/two' } },
    ]);
    unmount();
    expect(disposed.mock.calls.map(([marker]) => marker).toSorted()).toEqual([
      'SLOTONE',
      'SLOTTWO',
    ]);
  });

  it('matches full parsing after repeated safe appends and completion', async () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal('First &amp; prose\n\nTail');
    const [complete, setComplete] = createSignal(false);
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        get cacheByContent() {
          return complete();
        },
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
    const first = stable.firstChild;
    for (const paragraph of [
      'See src/example.ts and https://example.test/docs',
      'Literal &lt;script&gt; text',
    ]) {
      setContent(`${content()}\n\n${paragraph}\n\nEnd`);
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(stable.firstChild).toBe(first);
      expect(withoutLinkTooltipAttributes(stable.innerHTML)).toBe(
        withoutLinkTooltipAttributes(
          __parseMarkdownForTests(splitStreamingMarkdownContent(content()).stableContent, {
            cacheByContent: false,
          })
        )
      );
    }
    setComplete(true);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    const tail = container!.querySelector('[data-markdown-segment="tail"]')!;
    expect(withoutLinkTooltipAttributes(stable.innerHTML + tail.innerHTML)).toBe(
      withoutLinkTooltipAttributes(__parseMarkdownForTests(content(), { cacheByContent: true }))
    );
    expect(container!.querySelector('script')).toBeNull();
  });

  it.each([
    ['formatted delta', 'First\n\n**Second**\n\nTail'],
    ['formatted prefix', '**First**\n\nSecond\n\nTail'],
    ['non-append edit', 'Changed\n\nTail'],
  ])('matches normal parsing for %s while retaining unchanged blocks', async (_label, next) => {
    vi.useFakeTimers();
    const initial = _label === 'formatted prefix' ? '**First**\n\nTail' : 'First\n\nTail';
    const [content, setContent] = createSignal(initial);
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
    const first = stable.firstChild;
    setContent(next);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    if (_label === 'non-append edit') expect(stable.firstChild).not.toBe(first);
    else expect(stable.firstChild).toBe(first);
    expect(stable.innerHTML).toBe(
      __parseMarkdownForTests(splitStreamingMarkdownContent(next).stableContent, {
        cacheByContent: false,
      })
    );
  });

  it.each(['workspace', 'render option'])(
    'replaces appended stable DOM after a %s change',
    async (change) => {
      vi.useFakeTimers();
      applyState(storePath('editorContext', 'workspacePath', '/old'));
      const [content, setContent] = createSignal('See src/first.ts\n\nTail');
      const [disablePathLinkify, setDisablePathLinkify] = createSignal(false);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          get disablePathLinkify() {
            return disablePathLinkify();
          },
        })
      );
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
      const first = stable.firstChild;
      setContent('See src/first.ts\n\nSee src/second.ts\n\nTail');
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(stable.firstChild).toBe(first);
      if (change === 'workspace') setState(storePath('editorContext', 'workspacePath', '/new'));
      else setDisablePathLinkify(true);
      flushSolid();
      setContent(`${content()}\n\nEnd`);
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(stable.firstChild).not.toBe(first);
      expect(withoutLinkTooltipAttributes(stable.innerHTML)).toBe(
        withoutLinkTooltipAttributes(
          __parseMarkdownForTests(splitStreamingMarkdownContent(content()).stableContent, {
            cacheByContent: false,
            disablePathLinkify: disablePathLinkify(),
          })
        )
      );
      if (change === 'workspace') {
        expect(stable.querySelector('a')?.getAttribute('href')).toBe('/new/src/first.ts');
      } else {
        expect(stable.querySelector('a')).toBeNull();
      }
    }
  );

  it('replaces inline slot renderers after safe appends and disposes them on fallback', async () => {
    vi.useFakeTimers();
    const mounted = vi.fn();
    const disposed = vi.fn();
    const makeSlot = (label: string) => ({
      marker: 'SLOTMARKER',
      render: () => {
        mounted(label);
        onCleanup(() => disposed(label));
        const button = document.createElement('button');
        button.textContent = label;
        return button;
      },
    });
    const [slots, setSlots] = createSignal([makeSlot('old')]);
    const [content, setContent] = createSignal('SLOTMARKER\n\nTail');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        get inlineSlots() {
          return slots();
        },
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    setContent('SLOTMARKER\n\nMore prose\n\nTail');
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    mounted.mockClear();
    disposed.mockClear();
    setSlots([makeSlot('new')]);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(mounted.mock.calls).toEqual([['new']]);
    expect(disposed.mock.calls).toEqual([['old']]);
    expect(container!.querySelector('button')?.textContent).toBe('new');
    setContent('Replacement **markdown**\n\nTail');
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(disposed.mock.calls).toEqual([['old'], ['new']]);
    expect(container!.querySelector('button')).toBeNull();
  });

  it('does not hydrate a replacement tail after disposal between a frame and its microtask', async () => {
    vi.useFakeTimers();
    const mounted = vi.fn(() => document.createElement('button'));
    const [content, setContent] = createSignal('Initial');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        inlineSlots: [{ marker: 'SLOTMARKER', render: mounted }],
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    setContent('SLOTMARKER');
    flushSolid();
    vi.advanceTimersByTime(16);
    flushSolid();
    expect(container!.textContent).toContain('SLOTMARKER');
    unmount();
    await Promise.resolve();
    flushSolid();
    expect(mounted).not.toHaveBeenCalled();
  });

  it('renders inline and display LaTeX with KaTeX', () => {
    const html = __parseMarkdownForTests(
      [
        'Inline: $\\mathcal{N}(\\mu_t^{(p)},\\Sigma_t^{(p)})$',
        '',
        '$$',
        '\\hat\\mu_t^{(p)}=A_t^{(p)}\\mu_t^{(p)}+b_t^{(p)},\\qquad',
        '\\hat\\Sigma_t^{(p)}=A_t^{(p)}\\Sigma_t^{(p)}(A_t^{(p)})^\\top',
        '$$',
      ].join('\n'),
      { cacheByContent: false }
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(root.querySelectorAll('.katex')).toHaveLength(2);
    expect(root.querySelector('.katex-display')).not.toBeNull();
    expect(root.querySelector('.katex-html [style]')).not.toBeNull();
    expect(root.querySelector('.katex-error')).toBeNull();
  });

  it.each(['$$\nx^2 + y^2 = z^2\n$$', '$$x^2 +\ny^2 = z^2$$', '$$x^2 + y^2 = z^2$$'])(
    'renders display math %j immediately after prose',
    (math) => {
      const root = document.createElement('div');
      root.innerHTML = __parseMarkdownForTests(`The equation is:\n${math}\nAfter.`, {
        cacheByContent: false,
      });

      expect(root.querySelectorAll('.katex-display')).toHaveLength(1);
      expect(root.querySelector('.katex-error')).toBeNull();
      expect(Array.from(root.querySelectorAll('p'), (element) => element.textContent)).toEqual([
        'The equation is:',
        'After.',
      ]);
    }
  );

  it('keeps LaTeX literal inside code spans and fenced code blocks', () => {
    const html = __parseMarkdownForTests(
      ['Inline code: `$x^2$`', '', '```text', '$$y^2$$', '```'].join('\n'),
      { cacheByContent: false }
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(root.querySelector('.katex')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('$x^2$');
    expect(root.querySelector('pre')?.textContent).toContain('$$y^2$$');
  });

  it.each(['It costs $5 and $10.', 'It costs $5.', 'Literal \\$x^2\\$.'])(
    'does not treat currency or escaped dollars as math: %s',
    (content) => {
      const root = document.createElement('div');
      root.innerHTML = __parseMarkdownForTests(content, { cacheByContent: false });

      expect(root.querySelector('.katex')).toBeNull();
      expect(root.textContent?.trim()).toBe(content.replaceAll('\\$', '$'));
      flushSolid();
    }
  );

  it.each([
    '查询出 $\\mathcal{N}(\\mu_t^{(p)},\\Sigma_t^{(p)})$，再变换回全局：',
    '(where $x^2$)',
    'It costs $5 and $10. The variable is $x$.',
  ])('renders inline math alongside punctuation or currency: %s', (content) => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests(content, { cacheByContent: false });

    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(root.querySelector('.katex-error')).toBeNull();
  });

  it.each([
    '：',
    '，',
    '。',
    '；',
    '！',
    '？',
    '、',
    '（',
    '）',
    '【',
    '】',
    '《',
    '》',
    '「',
    '」',
    '『',
    '』',
    '［',
    '］',
    '｛',
    '｝',
    '中',
    '𠀀',
    'あ',
    'ア',
    '한',
  ])('renders inline math next to the CJK boundary %s without spaces', (boundary) => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests(`前文${boundary}$x^2$${boundary}后文`, {
      cacheByContent: false,
    });

    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(root.querySelector('annotation')?.textContent).toBe('x^2');
    expect(root.querySelector('.katex-error')).toBeNull();
    expect(root.textContent).not.toContain('$');
  });

  it('renders the Chinese inline and display formulas from issue 45', () => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests(
      String.raw`下面是一些行内公式：

- 高斯分布：$p(x\mid z)=\mathcal{N}(x;\mu,\Sigma)$
- Softmax：$\operatorname{softmax}(z_i)=\dfrac{e^{z_i}}{\sum_j e^{z_j}}$

行间公式：

$$
p(\mathbf{x}\mid\boldsymbol{\mu},\boldsymbol{\Sigma})
=\frac{1}{(2\pi)^{d/2}|\boldsymbol{\Sigma}|^{1/2}}
\exp\left[-\frac12(\mathbf{x}-\boldsymbol{\mu})^\top
\boldsymbol{\Sigma}^{-1}(\mathbf{x}-\boldsymbol{\mu})\right]
$$`,
      { cacheByContent: false }
    );

    expect(root.querySelectorAll('li .katex')).toHaveLength(2);
    expect(root.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(root.querySelector('.katex-error')).toBeNull();
    expect(root.textContent).not.toContain('$');
  });

  it.each([
    '中文$5，另一个价格$10。',
    '中文\\$x^2\\$。',
    '中文`$x^2$`。',
    'A shell variable foo$bar$',
    'An invalid $x$word',
    'An identifier foo$x$。',
  ])('keeps non-math dollar content literal alongside CJK text: %s', (content) => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests(content, { cacheByContent: false });

    expect(root.querySelector('.katex')).toBeNull();
    expect(root.textContent).toContain('$');
  });

  it('keeps unsafe TeX commands inert without allowing authored styles', () => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests(
      '<span style="position:fixed">Plain</span>\n\n$\\href{javascript:alert(1)}{x}$\n\n$\\includegraphics{https://example.test/image.png}$',
      { cacheByContent: false }
    );

    expect(root.querySelector('a, img, script')).toBeNull();
    expect(root.querySelector('span')?.hasAttribute('style')).toBe(false);
    expect(root.querySelector('.katex-html')).not.toBeNull();
  });

  it('shows invalid TeX without losing the surrounding message', () => {
    const root = document.createElement('div');
    root.innerHTML = __parseMarkdownForTests('Before $\\frac{$ after.', {
      cacheByContent: false,
    });

    expect(root.querySelector('.katex-error')?.textContent).toBe('\\frac{');
    expect(root.textContent).toContain('Before');
    expect(root.textContent).toContain('after.');
  });

  it.each(['$$\nx^2\n\ny^2\n$$', '$$\\left[x\\right)$$', '$\\left[x\\right)$'])(
    'preserves complete math %j during streaming',
    async (math) => {
      mount(() => createComponent(MarkdownRenderer, { content: math, forceStreaming: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();

      expect(container?.querySelectorAll('.katex')).toHaveLength(1);
      expect(container?.querySelector('.katex-error')).toBeNull();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    }
  );

  it('keeps streamed math whole across blank lines and split closing delimiters', async () => {
    vi.useFakeTimers();
    const prefix = 'Stable paragraph.\n\n';
    const [content, setContent] = createSignal(`${prefix}$$x^2`);
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        forceStreaming: true,
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    const stableParagraph = container?.querySelector('p');

    for (const suffix of ['', '\n\n', 'y^2', '$']) {
      setContent(content() + suffix);
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(container?.querySelector('.katex')).toBeNull();
      expect(container?.querySelector('p')).toBe(stableParagraph);
      expectStreamingIndicator(container!);
      expect(container?.textContent).not.toContain('$$');
    }
    setContent(`${content()}$`);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container?.querySelector('annotation')?.textContent).toBe('x^2\n\ny^2');

    setContent(`${content()}\n\nFollowing paragraph.`);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
    const settledMath = container?.querySelector('.katex');
    setContent(`${content()} More text.`);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(container?.querySelector('.katex')).toBe(settledMath);
    expect(container?.querySelector('p')).toBe(stableParagraph);
  });

  it.each([
    { prefix: 'The result is ', chunks: ['$', '\\', 'frac{a', '}{b}'], closer: '$' },
    { prefix: 'The result is ', chunks: ['$$', 'x^2', '$'], closer: '$' },
    { prefix: 'The result is ', chunks: ['$2 +', ' 2'], closer: '$' },
    { prefix: '- ', chunks: ['$', '\\left[', 'x\\right)'], closer: '$' },
    { prefix: 'Price: ', chunks: ['$', '\\text{cost \\$', '5}'], closer: '$' },
    { prefix: 'The equation is:\n', chunks: ['$', '$', '\nx^2\n\ny^2\n', '$'], closer: '$' },
    ...['：', '，', '。', '；', '！', '？', '、', '中', '𠀀', 'あ', 'ア', '한'].map((boundary) => ({
      prefix: `前文${boundary}`,
      chunks: ['$', '\\', 'frac{a', '}{b}'],
      closer: '$后文',
    })),
  ])(
    'hides unfinished formulas with $prefix until the closer arrives',
    async ({ prefix, chunks, closer }) => {
      vi.useFakeTimers();
      const [content, setContent] = createSignal(prefix);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        })
      );

      for (const chunk of chunks) {
        setContent(content() + chunk);
        flushSolid();
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
        expect(container?.querySelector('.katex')).toBeNull();
        expectStreamingIndicator(container!);
        expect(container?.textContent).not.toContain('$');
      }

      setContent(content() + closer);
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(container?.querySelectorAll('.katex')).toHaveLength(1);
      expect(container?.querySelector('.katex-error')).toBeNull();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    }
  );

  it.each([
    'It costs $5 and $10.',
    'It costs $5',
    'Literal \\$x^2',
    'Code: `$x^2`',
    '```latex\n$$\nx^2',
    'A shell variable foo$bar',
    'An invalid $x$word',
    '中文$5，另一个价格$10。',
    '中文\\$x^2',
    '中文`$x^2`',
    'An identifier foo$x$。',
  ])('keeps non-math dollar content visible while streaming: %s', async (content) => {
    mount(() => createComponent(MarkdownRenderer, { content, forceStreaming: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('.katex')).toBeNull();
    expect(container?.textContent).toContain('$');
  });

  it.each([
    'A formula $\\frac{x}',
    'An equation:\n$$\nx^2\n\ny^2',
    '中文：$\\frac{x}',
    '中文$\\frac{x}',
  ])('reveals unmatched math as literal text when streaming ends: %s', async (content) => {
    vi.useFakeTimers();
    const [completed, setCompleted] = createSignal(false);
    mount(() =>
      createComponent(MarkdownRenderer, {
        content,
        get cacheByContent() {
          return completed();
        },
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expectStreamingIndicator(container!);

    setCompleted(true);
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('.katex')).toBeNull();
    expect(container?.textContent).toContain(content.includes('$$') ? '$$' : '$\\frac{x}');
  });

  it('does not let code-fenced math delimiters consume later streaming boundaries', () => {
    const stableContent = '```text\n$$\nx^2\n```';
    expect(splitStreamingMarkdownContent(`${stableContent}\n\nTail`)).toEqual({
      stableContent,
      tailContent: 'Tail',
    });
  });

  it('renders indented text as prose while preserving fenced code blocks', () => {
    const indentedHtml = __parseMarkdownForTests(
      'Failure details\n\n    Error: expected 37\n    Received: 36.71875',
      { cacheByContent: false }
    );
    const fencedHtml = __parseMarkdownForTests('```text\nError: expected 37\n```', {
      cacheByContent: false,
    });

    expect(indentedHtml).not.toContain('interactive-result-code-block');
    expect(indentedHtml).toContain('Error: expected 37');
    expect(fencedHtml).toContain('interactive-result-code-block');
  });

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

  it('renders GFM task lists with non-interactive checkbox icons', () => {
    const html = __parseMarkdownForTests('- [x] Do this\n- [ ] Do that', {
      cacheByContent: false,
    });
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(root.querySelectorAll('li.task-list-item')).toHaveLength(2);
    expect(root.querySelectorAll('input')).toHaveLength(0);
    expect(root.querySelector('.markdown-task-checkbox-checked')?.getAttribute('aria-label')).toBe(
      'Completed task'
    );
    expect(
      root.querySelector('.markdown-task-checkbox-unchecked')?.getAttribute('aria-label')
    ).toBe('Incomplete task');
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
    flushSolid();

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
    flushSolid();

    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it('uses readable VS Code colors for dark Mermaid diagrams', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-background', '#202020');
    flushSolid();
    document.body.style.setProperty('--vscode-editor-foreground', '#eeeeee');
    flushSolid();
    document.body.style.setProperty('--vscode-input-background', '#303030');
    flushSolid();
    document.body.style.setProperty('--vscode-widget-border', '#777777');
    flushSolid();
    document.body.style.setProperty('--vscode-focusBorder', '#55aaff');
    flushSolid();

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
    flushSolid();
    document.body.style.setProperty('--vscode-editor-foreground', '#202020');
    flushSolid();
    document.body.style.setProperty('--vscode-input-background', '#ffffff');
    flushSolid();
    document.body.style.setProperty('--vscode-widget-border', '#b0b0b0');
    flushSolid();
    document.body.style.setProperty('--vscode-focusBorder', '#0066b8');
    flushSolid();

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
    flushSolid();

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
    flushSolid();
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
    mount(() => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }));
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledOnce());
    flushSolid();

    document.body.className = 'vscode-light';
    setTheme('light');
    flushSolid();
    resolveOldRender({ svg: '<svg><text>old theme</text></svg>' });
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    flushSolid();

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

  it('rejects oversized decoded Mermaid source before hydration work', async () => {
    const root = document.createElement('div');
    root.innerHTML = `<div class="mermaid-diagram" data-mermaid-source="${encodeURIComponent('A'.repeat(100_001))}"><div class="mermaid-diagram-status">Rendering diagram...</div><div hidden class="mermaid-diagram-fallback">source</div></div>`;

    await hydrateMermaidDiagramsForTests(root);
    flushSolid();

    const diagram = root.querySelector<HTMLElement>('.mermaid-diagram');
    expect(mermaidMock.initialize).not.toHaveBeenCalled();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(diagram?.dataset.mermaidHydrated).toBe('error');
    expect(diagram?.querySelector('.mermaid-diagram-status')?.textContent).toContain('too large');
    expect(diagram?.querySelector('.mermaid-diagram-fallback')?.hasAttribute('hidden')).toBe(false);
  });

  it('renders imperative Mermaid controls while preserving generated SVG output', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>',
    });
    mount(() => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }));
    await vi.waitFor(() =>
      expect(container?.querySelector('.mermaid-diagram-toolbar')).not.toBeNull()
    );
    flushSolid();

    const copyButton = container?.querySelector<HTMLButtonElement>('button[data-mermaid-copy]');
    const expandButton = container?.querySelector<HTMLButtonElement>('button[data-mermaid-expand]');
    expectUiIcon(copyButton?.firstElementChild, copyIcon, 14);
    expectUiIcon(expandButton?.firstElementChild, expandIcon, 14);
    expect(container?.querySelector('.mermaid-diagram-output > svg path')).not.toBeNull();

    expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    const closeButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close diagram preview"]'
    );
    expectUiIcon(closeButton?.firstElementChild, xmarkIcon, 14);
  });

  it('owns the Mermaid portal, focus and host state only while its preview is open', async () => {
    setTheme('dark');
    flushSolid();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>',
    });
    const send = vi.fn();
    window.__sendToExtension = send;
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'Outside preview';
    container!.append(outsideButton);
    const root = document.createElement('div');
    container!.append(root);
    const bodyChildren = Array.from(document.body.children);
    cleanup = render(
      () => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }),
      root
    );
    flushSolid();
    const expandButton = () => root.querySelector<HTMLButtonElement>('[data-mermaid-expand]')!;
    await vi.waitFor(() => expect(expandButton()).not.toBeNull());
    flushSolid();
    expect(Array.from(document.body.children)).toEqual(bodyChildren);

    const openPreview = async () => {
      expandButton().focus();
      expandButton().click();
      flushSolid();
      await Promise.resolve();
      expect(document.querySelectorAll('.mermaid-preview-overlay')).toHaveLength(1);
      expect(document.body.children.length).toBe(bodyChildren.length + 1);
      expect(document.querySelector('.mermaid-preview-canvas svg path')).not.toBeNull();
      const closeButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="Close diagram preview"]'
      )!;
      expect(document.activeElement).toBe(closeButton);
      outsideButton.focus();
      expect(document.activeElement).toBe(closeButton);
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      closeButton.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(closeButton);
      return closeButton;
    };
    const expectClosed = () => {
      expect(document.querySelector('.mermaid-preview-overlay')).toBeNull();
      expect(Array.from(document.body.children)).toEqual(bodyChildren);
      expect(document.activeElement).toBe(expandButton());
      outsideButton.focus();
      expect(document.activeElement).toBe(outsideButton);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      outsideButton.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    };

    await openPreview();
    flushSolid();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    flushSolid();
    expectClosed();

    (await openPreview()).click();
    flushSolid();
    expectClosed();

    await openPreview();
    flushSolid();
    setTheme('light');
    flushSolid();
    expect(document.querySelector('.mermaid-preview-overlay')).toBeNull();
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
    outsideButton.focus();
    flushSolid();
    expect(document.activeElement).toBe(outsideButton);
    await vi.waitFor(() => expect(expandButton()).not.toBeNull());
    flushSolid();

    // Keep the return target mounted when the entire Markdown instance is disposed.
    outsideButton.focus();
    flushSolid();
    expandButton().click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close diagram preview');
    unmount();
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
    expect(document.activeElement).toBe(outsideButton);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    outsideButton.dispatchEvent(escape);
    flushSolid();
    expect(escape.defaultPrevented).toBe(false);
    expect(
      send.mock.calls.filter(([message]) => message.type === 'vscode/mermaid-preview')
    ).toEqual(
      [true, false, true, false, true, false, true, false].map((open) => [
        { type: 'vscode/mermaid-preview', payload: { open } },
      ])
    );
  });

  it('mounts Mermaid output without executable or foreign HTML content', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: `<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div onclick="alert(1)">unsafe</div></foreignObject><path d="M0 0h10v10z"></path></svg>`,
    });
    mount(() => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }));
    await vi.waitFor(() =>
      expect(container?.querySelector('.mermaid-diagram-output > svg path')).not.toBeNull()
    );
    flushSolid();

    const output = container?.querySelector('.mermaid-diagram-output');
    expect(output?.querySelector('script, foreignObject')).toBeNull();
    expect(output?.querySelector('svg')?.hasAttribute('onload')).toBe(false);

    container
      ?.querySelector<HTMLButtonElement>('button[data-mermaid-expand]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    const preview = document.body.querySelector('.mermaid-preview-canvas');
    expect(preview?.querySelector('script, foreignObject')).toBeNull();
    expect(preview?.querySelector('svg')?.hasAttribute('onload')).toBe(false);
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

  it.each(['\n', '\r\n'])(
    'keeps loose and nested lists in one streaming block with %j newlines',
    async (newline) => {
      const [content, setContent] = createSignal(`Introduction.${newline}${newline}1. First item.`);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          cacheByContent: false,
        })
      );
      for (const delta of [
        `${newline}${newline}2`,
        '.',
        ' Second item.',
        `${newline}${newline}   Another paragraph in the second item.`,
        `${newline}${newline}   - Nested item.`,
        `${newline}${newline}3. Third item.`,
        `${newline}${newline}Following paragraph.`,
      ]) {
        setContent((previous) => previous + delta);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        flushSolid();
        expect(container!.querySelectorAll('ol')).toHaveLength(1);
        expect(container!.querySelector('ol > li')?.textContent?.trim()).toBe('First item.');
      }
      expect(container!.querySelectorAll('ol > li')).toHaveLength(3);
      expect(container!.querySelector('ol > li:nth-child(2) > ul > li')?.textContent).toBe(
        'Nested item.'
      );
      expect(container!.querySelector('[data-markdown-segment="tail"]')?.textContent?.trim()).toBe(
        'Following paragraph.'
      );
    }
  );

  it('sanitizes html while blocking remote images and keeping external links routable', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    mount(() =>
      MarkdownRenderer({
        content:
          'Safe <strong>text</strong><script>alert(1)</script><img src="https://example.test/x.png" onerror="alert(1)" /> [Docs](https://opencode.ai) [Bad](javascript:alert(1))',
      })
    );

    expect(container?.querySelector('script')).toBeNull();
    expect(container?.querySelector('img:not(.external-link-icon)')).toBeNull();
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
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
  });

  it.each(['Docs', '**Docs**', '`Docs`', 'Docs &amp; examples'])(
    'shows the URL in a custom tooltip after 400 ms for %s',
    async (label) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn');
      const href = 'https://example.test/docs?one=1&two=2';
      mount(() =>
        MarkdownRenderer({ content: `[${label}](${href} "Old title")`, cacheByContent: true })
      );
      const link = container!.querySelector('a')!;
      expect(link.hasAttribute('title')).toBe(false);
      link.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(399);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      const tooltip = document.querySelector('[role="tooltip"]')!;
      expect(tooltip.textContent).toBe(href);
      expect(tooltip.classList.contains('themed-tooltip')).toBe(true);
      expect(link.getAttribute('aria-describedby')).toBe(tooltip.id);
      link.dispatchEvent(new MouseEvent('mouseleave'));
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('disposes replaced link tooltips and pending hover timers without reactive warnings', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn');
    const [content, setContent] = createSignal('[First](https://example.test/first)');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        cacheByContent: true,
      })
    );
    const first = container!.querySelector('a')!;
    first.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'https://example.test/first'
    );

    setContent('[Second](https://example.test/second)');
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(first.hasAttribute('aria-describedby')).toBe(false);
    const second = container!.querySelector('a')!;
    second.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'https://example.test/second'
    );
    second.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    second.dispatchEvent(new MouseEvent('mouseenter'));
    unmount();
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(second.hasAttribute('aria-describedby')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      '`src/test/development-compatibility.test.ts`',
      '/repo/src/test/development-compatibility.test.ts',
    ],
    [
      'src/test/development-compatibility.test.ts',
      '/repo/src/test/development-compatibility.test.ts',
    ],
    [
      '[Test file](./src/test/development-compatibility.test.ts)',
      '/repo/src/test/development-compatibility.test.ts',
    ],
    ['`src/App.tsx:12-15`', '/repo/src/App.tsx (line 12-15)'],
    ['`C:\\work\\project\\App.tsx`', 'C:/work/project/App.tsx'],
  ])('uses the same 400 ms custom tooltip for file link %s', async (content, expected) => {
    vi.useFakeTimers();
    applyState(storePath('editorContext', 'workspacePath', '/repo'));
    mount(() => MarkdownRenderer({ content, cacheByContent: true }));
    const link = container!.querySelector('a')!;
    expect(link.hasAttribute('title')).toBe(false);
    link.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(399);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(expected);
    link.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('uses a custom tooltip for session-reference links too', async () => {
    vi.useFakeTimers();
    applyState(
      storePath('sessions', [
        {
          id: 'ses_reference123',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Reference session',
          version: '1',
          time: { created: 0, updated: 0 },
        },
      ])
    );
    mount(() =>
      MarkdownRenderer({ content: 'Open session:ses_reference123', cacheByContent: true })
    );
    const link = container!.querySelector('a')!;
    expect(link.hasAttribute('title')).toBe(false);
    link.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(399);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Open session ses_reference123'
    );
  });

  it('does not add URL tooltips to URL labels or unsafe links', async () => {
    vi.useFakeTimers();
    mount(() =>
      MarkdownRenderer({
        content:
          'https://example.test/docs [https://example.test/docs](https://example.test/docs) ' +
          '[Unsafe](javascript:alert) [http://example.test/docs](http://example.test/docs)',
        cacheByContent: true,
      })
    );
    for (const link of container!.querySelectorAll('a')) {
      expect(link.hasAttribute('aria-describedby')).toBe(false);
      link.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
    }
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('cancels a link tooltip on early leave and hides it on click without changing navigation', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    mount(() =>
      MarkdownRenderer({ content: '[Docs](https://example.test/docs)', cacheByContent: true })
    );
    const link = container!.querySelector('a')!;
    link.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(200);
    flushSolid();
    link.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    link.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(400);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    dispatchAnchorClick(link);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://example.test/docs' },
    });
  });

  it.each([200, 400])(
    'disposes link tooltips on content replacement after %i ms',
    async (delay) => {
      vi.useFakeTimers();
      const [content, setContent] = createSignal('[Docs](https://example.test/old)');
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          cacheByContent: true,
        })
      );
      const oldLink = container!.querySelector('a')!;
      oldLink.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(delay);
      flushSolid();
      setContent('[New docs](https://example.test/new)');
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(oldLink.hasAttribute('aria-describedby')).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      container!.querySelector('a')!.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(400);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'https://example.test/new'
      );
      cleanup!();
      cleanup = undefined;
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
  );

  it('hydrates tooltips for completed streaming links in stable and tail segments', async () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal('See [Docs](https://example.test');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    expect(container!.querySelector('a')).toBeNull();
    setContent('See [Docs](https://example.test/docs)\n\n[More](https://example.test/more)');
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    const links = container!.querySelectorAll('a');
    expect(links).toHaveLength(2);
    for (const link of links) {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(400);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        link.getAttribute('href')
      );
      link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
  });

  it.each([
    ['`claude-agent-acp`', 'code'],
    ['**claude-agent-acp**', 'strong'],
    ['*claude-agent-acp*', 'em'],
    ['**`claude-agent-acp`**', 'strong code'],
  ])('preserves formatting when decorating a link labeled %s', (label, selector) => {
    mount(() => MarkdownRenderer({ content: `[${label}](https://example.test)` }));

    const link = container?.querySelector('a.external-link');
    const formattedLabel = link?.querySelector(selector);
    expect(link?.textContent).toBe('claude-agent-acp');
    expect(link?.getAttribute('aria-label')).toBe('claude-agent-acp');
    expect(formattedLabel?.textContent).toBe('claude-agent-acp');
    expect(formattedLabel?.querySelector('.link-leading-label')?.textContent).toBe('c');
    expect(
      formattedLabel?.querySelector('.link-leading-content > .external-link-icon')
    ).not.toBeNull();
    expect(link?.querySelectorAll('.external-link-icon')).toHaveLength(1);
  });

  it('renders linked badge markdown as user-clicked text links', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro) [![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)',
      })
    );

    expect(container?.querySelector('img:not(.external-link-icon)')).toBeNull();
    const link = Array.from(container?.querySelectorAll('a') || []).find((item) =>
      item.textContent?.includes('Visual Studio Marketplace')
    );
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(link?.textContent).toContain('Visual Studio Marketplace');
  });

  it('renders remote content images as text without resource elements', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '![Screenshot](https://example.test/screenshot.png) [![Linked screenshot](https://example.test/linked-screenshot.png)](https://example.test/details)',
      })
    );

    expect(container?.querySelector('.markdown-image-frame')).toBeNull();
    expect(container?.querySelector('img:not(.external-link-icon)')).toBeNull();
    expect(container?.textContent).toContain('Screenshot');
    expect(container?.textContent).toContain('Linked screenshot');
  });

  it('blocks compact remote icons, portraits, and raw images', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '![App icon](https://example.test/assets/app.png) ![Author portrait](https://example.test/people/author.jpg) <img src="https://example.test/custom.png" width="48" height="48" alt="Custom mark">',
      })
    );

    expect(container?.querySelectorAll('.markdown-image-frame')).toHaveLength(0);
    expect(container?.querySelectorAll('img:not(.external-link-icon)')).toHaveLength(0);
    expect(container?.textContent).toContain('App icon');
    expect(container?.textContent).toContain('Author portrait');
  });

  it('offers click-to-load placeholders only for generated Markdown image tokens', () => {
    const warn = vi.spyOn(console, 'warn');
    applyState(storePath('remoteImages', 'ask'));
    mount(() =>
      MarkdownRenderer({
        content: [
          '![Chart](https://images.test/chart.png)',
          '<img src="https://images.test/raw.png">',
          '<span data-varro-generated data-remote-image="https%3A%2F%2Fimages.test%2Fforged.png" alt="Forged">Forged</span>',
        ].join('\n\n'),
        cacheByContent: true,
      })
    );
    expect(container?.querySelectorAll('[data-remote-image]')).toHaveLength(1);
    expect(container?.querySelector('.remote-markdown-image-host')?.textContent).toBe(
      'images.test'
    );
    expect(container?.querySelector('[data-remote-image-load]')?.textContent).toBe('Load image');
    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toContain('Forged');
    expect(warn).not.toHaveBeenCalled();
  });

  it('changes image presentation without reparsing or fetching Markdown', () => {
    mount(() =>
      MarkdownRenderer({
        content: '![Chart](https://images.test/chart.png)',
        cacheByContent: true,
      })
    );
    const host = container?.querySelector('[data-remote-image]');
    expect(container?.querySelector('button')).toBeNull();
    applyState(storePath('remoteImages', 'ask'));
    expect(container?.querySelector('[data-remote-image]')).toBe(host);
    expect(container?.querySelector('.rendered-markdown')?.classList).toContain(
      'remote-images-enabled'
    );
    expect(container?.querySelector('[data-remote-image-load]')?.textContent).toBe('Load image');
    applyState(storePath('remoteImages', 'off'));
    expect(container?.querySelector('button, img')).toBeNull();
    expect(container?.textContent?.trim()).toBe('Chart');
  });

  it.each([
    'artifacts/status-slot-explanation/44px-activity-row.png',
    '/workspace/screenshots/example.png',
    'file:///workspace/screenshots/example.png',
    'screenshots/example%20image.png',
  ])('reserves inline local images even with remote images off: %s', (source) => {
    const warn = vi.spyOn(console, 'warn');
    mount(() =>
      MarkdownRenderer({ content: `![Local screenshot](${source})`, directory: '/workspace' })
    );
    expect(container?.querySelectorAll('[data-local-image]')).toHaveLength(1);
    expect(container?.querySelector('.local-markdown-image')).not.toBeNull();
    expect(container?.textContent).toContain('Local screenshot');
    expect(container?.querySelector('[data-remote-image]')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not hydrate forged local image attributes', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '<span data-varro-generated data-local-image="secret.png" alt="Forged">Forged</span>',
      })
    );
    expect(container?.querySelector('[data-local-image]')).toBeNull();
    expect(container?.textContent).toContain('Forged');
  });

  it('removes images with unsafe or unsupported URL schemes', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '![Insecure](http://images.test/image.png) ![Embedded](data:image/png;base64,AA==) <img src="javascript:alert(1)" alt="Bad">',
      })
    );

    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toContain('Insecure');
    expect(container?.querySelector('[data-local-image], [data-remote-image]')).toBeNull();
  });

  it('strips dangerous attributes from allowed html', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '<a href="https://example.test" onclick="alert(1)" style="color:red">Link</a><svg><path d="M0 0" onload="alert(1)" /></svg>',
      })
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

  it('keeps raw HTML controls inert while preserving generated code copy controls', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const content = [
      '<div hidden class="interactive-result-code-block" data-lang="txt"><code>forged secret</code><button type="button" class="code-block-copy-btn" data-copy data-copy-text="forged%20secret">Forged copy</button><span data-mermaid-source="graph%20TD"></span><a data-file="{&quot;path&quot;:&quot;/private&quot;}">Forged file</a></div>',
      '',
      '```txt',
      'trusted code',
      '```',
    ].join('\n');

    mount(() => MarkdownRenderer({ content, cacheByContent: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const rawControl = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Forged copy'
    );
    expect(rawControl?.closest('[hidden]')).not.toBeNull();
    flushSolid();
    expect(rawControl?.hasAttribute('data-copy')).toBe(false);
    expect(rawControl?.hasAttribute('data-copy-text')).toBe(false);
    expect(container?.querySelector('[data-mermaid-source="graph%20TD"]')).toBeNull();
    expect(container?.querySelector('[data-file*="private"]')).toBeNull();
    expect(container?.querySelector('[data-varro-generated]')).toBeNull();

    rawControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(writeText).not.toHaveBeenCalled();

    const generatedControl = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    generatedControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(writeText).toHaveBeenCalledWith('trusted code');
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
      mount(() => MarkdownRenderer({ content: payload }));

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
          flushSolid();
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

    mount(() => MarkdownRenderer({ content: payload }));

    assertInertWithSafeAnchor(container!);

    const sink = document.createElement('div');
    sink.innerHTML = container?.innerHTML ?? '';
    assertInertWithSafeAnchor(sink);
  });

  it('opens local markdown file links through VS Code', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);

    dispatchAnchorClick(link);
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: './src/webview/App.tsx',
        kind: 'file',
        exact: true,
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
    flushSolid();
  });

  it.each([
    ['/other/dap/dashboard.sql#L68', '/other/dap/dashboard.sql', 68],
    [
      '/repo/reports/Varro%20startup%20performance.md#L10-L12',
      '/repo/reports/Varro startup performance.md',
      10,
      12,
    ],
    [
      './reports/Varro%20startup%20performance.md#L10-L12',
      './reports/Varro startup performance.md',
      10,
      12,
    ],
    ['./reports/literal%2520name.md#L10', './reports/literal%20name.md', 10],
    ['./reports/caf%C3%A9.md#L10', './reports/café.md', 10],
    ['./reports/notes%23L12.md#L10', './reports/notes#L12.md', 10],
    ['./reports/literal%3A12#L10', './reports/literal:12', 10],
    ['./reports/100%.md#L10', './reports/100%.md', 10],
    ['file:///repo/reports/literal%2520name.md#L10', '/repo/reports/literal%20name.md', 10],
    ['C:/repo/reports/Varro%20startup.md#L10', 'C:/repo/reports/Varro startup.md', 10],
    ['./src/query.py#L91', './src/query.py', 91],
    ['./src/query.py#L91-L105', './src/query.py', 91, 105],
    ['./src/query.py#L91-105', './src/query.py', 91, 105],
    ['C:/work/query.py#L91', 'C:/work/query.py', 91],
    ['file:///other/dashboard.sql#L68', '/other/dashboard.sql', 68],
  ])('opens the file and line in Markdown target %s', (href, path, line, endLine?: number) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [
          { name: 'repo', path: '/repo' },
          { name: 'other', path: '/other' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    mount(() => MarkdownRenderer({ content: `[Open query](${href})`, cacheByContent: true }));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.dataset.file).toBe(JSON.stringify({ path, line, endLine }));
    const absolutePath = path.replace(/^\.\//, '/repo/');
    flushSolid();
    if (!path.startsWith('C:'))
      expect(link?.getAttribute('href')).toBe(
        `${absolutePath}:${line}${endLine ? `-${endLine}` : ''}`
      );
    flushSolid();
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
      varroFilePath: absolutePath,
      webviewSection: 'varroFileLink',
    });
    dispatchAnchorClick(link);
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path, line, endLine, kind: 'file', exact: true, requestId: expect.any(Number) },
    });
    const requestId = send.mock.calls[0]![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
    flushSolid();
  });

  it.each([
    '[startup performance report](/repo/reports/Varro%20startup%20performance.md)',
    '<a href="/repo/reports/Varro%20startup%20performance.md">startup performance report</a>',
    '[startup performance report](file:///repo/reports/Varro%20startup%20performance.md)',
  ])('decodes report link %s and consumes its native host click', (content) => {
    const send = vi.fn();
    const hostClick = vi.fn();
    window.__sendToExtension = send;
    mount(() => MarkdownRenderer({ content }));
    const link = container!.querySelector<HTMLAnchorElement>('a')!;
    const path = '/repo/reports/Varro startup performance.md';
    expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
      varroFilePath: path,
    });
    document.addEventListener('click', hostClick);
    flushSolid();
    try {
      dispatchAnchorClick(link);
      flushSolid();
      expect(send).toHaveBeenCalledWith({
        type: 'vscode/open',
        payload: { path, kind: 'file', exact: true, requestId: expect.any(Number) },
      });
      expect(hostClick).not.toHaveBeenCalled();
      const requestId = send.mock.lastCall![0].payload.requestId;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
        })
      );
      flushSolid();
    } finally {
      document.removeEventListener('click', hostClick);
      flushSolid();
    }
  });

  it.each([false, true])(
    'keeps multi-root citation targets instead of resolving code labels with cacheByContent=%s',
    async (cacheByContent) => {
      const primary = '/projects/wmg2-dsc/amplify';
      const sibling = '/projects/df-data-pipelines';
      const citations = [
        {
          label: 'dap/SwDmdDeliveryDaily/sql/dsp_optimization_dashboard.sql',
          path: `${sibling}/dap/SwDmdDeliveryDaily/sql/dsp_optimization_dashboard.sql`,
          line: 68,
        },
        {
          label: 'sw_dmd_delivery_daily_meta.sql:32',
          path: `${sibling}/dap/SwDmdDeliveryDaily/elt_config/sw_dmd_delivery_daily_meta.sql`,
          line: 32,
        },
        {
          label: 'amplify/dwh/model/dashboard/query.py:91',
          path: `${primary}/dwh/model/dashboard/query.py`,
          line: 91,
        },
      ];
      const send = vi.fn();
      window.__sendToExtension = send;
      applyState(
        storePath('editorContext', {
          workspacePath: primary,
          workspaceFolders: [
            { name: 'amplify', path: primary },
            { name: 'df-data-pipelines', path: sibling },
          ],
        })
      );
      mount(() =>
        MarkdownRenderer({
          content: citations
            .map(({ label, path, line }) => `[\`${label}\`](${path}#L${line})`)
            .join('\n\n'),
          cacheByContent,
        })
      );

      const links = container!.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
      expect(links).toHaveLength(citations.length);
      for (const [index, { path, line }] of citations.entries()) {
        const link = links[index]!;
        expect(link.dataset.file).toBe(JSON.stringify({ path, line }));
        expect(link.getAttribute('href')).toBe(`${path}:${line}`);
        expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
          varroFilePath: path,
        });
        link.dispatchEvent(new MouseEvent('mouseenter'));
        flushSolid();
        await vi.waitFor(() =>
          expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
            `${path} (line ${line})`
          )
        );
        flushSolid();
        link.dispatchEvent(new MouseEvent('mouseleave'));
        flushSolid();
        dispatchAnchorClick(link);
        flushSolid();
        expect(send).toHaveBeenLastCalledWith({
          type: 'vscode/open',
          payload: { path, line, kind: 'file', exact: true, requestId: expect.any(Number) },
        });
        const requestId = send.mock.lastCall![0].payload.requestId;
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
          })
        );
        flushSolid();
      }
    }
  );

  it('opens line fragments on raw HTML file anchors', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    mount(() => MarkdownRenderer({ content: '<a href="/other/query.py#L91-L105">Open query</a>' }));

    dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/other/query.py',
        line: 91,
        endLine: 105,
        kind: 'file',
        exact: true,
        requestId: expect.any(Number),
      },
    });
    const requestId = send.mock.calls[0]![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
    flushSolid();
  });

  it.each([
    '/repo/query.py#section',
    '/repo/query.py#L0',
    '/repo/query.py#L91-other',
    '/repo/query.py?view=source#L91',
    '//example.test/query.py#L91',
    '#L91',
  ])('does not treat unsupported fragment target %s as a file', (href) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    mount(() => MarkdownRenderer({ content: `[Open query](${href})` }));

    const link = container?.querySelector<HTMLAnchorElement>('a');
    expect(link?.hasAttribute('href')).toBe(false);
    dispatchAnchorClick(link);
    flushSolid();
    expect(send).not.toHaveBeenCalled();
  });

  it('links file references with parenthesized line numbers', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() => MarkdownRenderer({ content: 'Review go.mod (line 3).', cacheByContent: true }));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('go.mod (line 3)');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);

    dispatchAnchorClick(link);
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: 'go.mod',
        line: 3,
        kind: 'file',
        exact: true,
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
    flushSolid();
  });

  it.each([
    'perceiver_lang_io.py (line 710-744)',
    '`models/perceiver_lang_io.py:710-744`',
    '[Source](models/perceiver_lang_io.py#L710-L744)',
    '<a href="models/perceiver_lang_io.py#L710-L744">Source</a>',
  ])('preserves the relative reference and range in %s', (content) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(storePath('editorContext', 'workspacePath', '/other-workspace'));
    applyState(storePath('activeSessionId', 'different-session'));
    applyState(
      storePath('sessions', [
        {
          id: 'owner-session',
          projectID: 'project',
          directory: '/repo/packages/app',
          title: 'Nested session',
          version: '1',
          time: { created: 0, updated: 0 },
        },
      ])
    );
    mount(() => MarkdownRenderer({ content, sessionID: 'owner-session', cacheByContent: true }));
    const link = container!.querySelector<HTMLAnchorElement>('a')!;
    expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath).toBe(
      content.startsWith('perceiver')
        ? '/repo/packages/app/perceiver_lang_io.py'
        : '/repo/packages/app/models/perceiver_lang_io.py'
    );
    flushSolid();
    dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: content.startsWith('perceiver')
          ? 'perceiver_lang_io.py'
          : 'models/perceiver_lang_io.py',
        line: 710,
        endLine: 744,
        kind: 'file',
        exact: true,
        sessionID: 'owner-session',
        directory: '/repo/packages/app',
        requestId: expect.any(Number),
      },
    });
    flushSolid();
    const requestId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
    flushSolid();
  });

  it.each(['/repo', '/repo/packages/app', '/worktrees/feature', '/scratch/no-project'])(
    'uses the supplied modal session directory %s without relying on the session list',
    (directory) => {
      const send = vi.fn();
      window.__sendToExtension = send;
      applyState(storePath('activeSessionId', 'other'));
      applyState(storePath('editorContext', 'workspacePath', '/other'));
      mount(() =>
        MarkdownRenderer({
          content: '`app.ts`',
          sessionID: 'modal-session',
          directory,
        })
      );
      dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
      flushSolid();
      expect(send).toHaveBeenCalledWith({
        type: 'vscode/open',
        payload: {
          path: 'app.ts',
          sessionID: 'modal-session',
          directory,
          kind: 'file',
          exact: true,
          requestId: expect.any(Number),
        },
      });
      const requestId = send.mock.lastCall![0].payload.requestId;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
        })
      );
      flushSolid();
    }
  );

  it.each([
    '`src/app.ts:10-12`',
    'src/app.ts (line 10-12)',
    '[Source](src/app.ts#L10-L12)',
    '<a href="src/app.ts#L10-L12">Source</a>',
  ])('scopes cached link metadata to each session directory for %s', async (content) => {
    vi.useFakeTimers();
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    applyState(storePath('activeSessionId', 'other'));
    applyState(storePath('editorContext', 'workspacePath', '/other-workspace'));
    for (const directory of ['/repo/packages/app', '/worktrees/feature', '/repo/packages/app']) {
      mount(() =>
        MarkdownRenderer({
          content,
          sessionID: 'owner-session',
          directory,
          cacheByContent: true,
        })
      );
      const link = container!.querySelector<HTMLAnchorElement>('a')!;
      expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath).toBe(
        `${directory}/src/app.ts`
      );
      if (link.classList.contains('file-path-link')) {
        expect(link.getAttribute('href')).toBe(`${directory}/src/app.ts:10-12`);
        link.dispatchEvent(new MouseEvent('mouseenter'));
        flushSolid();
        await vi.advanceTimersByTimeAsync(400);
        flushSolid();
        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
          `${directory}/src/app.ts (line 10-12)`
        );
        link.dispatchEvent(new MouseEvent('mouseleave'));
        flushSolid();
      }
      flushSolid();
      unmount();
    }
    expect(sanitize).toHaveBeenCalledTimes(2);
  });

  it('preserves absolute link metadata when a session directory is supplied', () => {
    mount(() =>
      MarkdownRenderer({
        content: '`/shared/src/app.ts:10-12`',
        sessionID: 'owner-session',
        directory: '/repo/packages/app',
        cacheByContent: true,
      })
    );
    const link = container!.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('href')).toBe('/shared/src/app.ts:10-12');
    expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath).toBe(
      '/shared/src/app.ts'
    );
  });

  it('updates stable and tail link metadata when the owning session directory changes', async () => {
    const [directory, setDirectory] = createSignal('/repo/packages/app');
    const content = '`src/stable.ts`\n\n`src/tail.ts`';
    mount(() =>
      createComponent(MarkdownRenderer, {
        content,
        sessionID: 'owner-session',
        get directory() {
          return directory();
        },
      })
    );
    const linkPaths = () =>
      Array.from(container!.querySelectorAll('a')).map(
        (link) => JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath
      );
    expect(linkPaths()).toEqual([
      '/repo/packages/app/src/stable.ts',
      '/repo/packages/app/src/tail.ts',
    ]);
    setDirectory('/worktrees/feature');
    flushSolid();
    await vi.waitFor(() =>
      expect(linkPaths()).toEqual([
        '/worktrees/feature/src/stable.ts',
        '/worktrees/feature/src/tail.ts',
      ])
    );
    flushSolid();
  });

  it('keeps an ambiguous link clickable after cancelling the file picker', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    mount(() => MarkdownRenderer({ content: '`shared.ts`' }));
    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    dispatchAnchorClick(link);
    flushSolid();
    const requestId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'cancelled' } },
      })
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(link?.classList.contains('is-unavailable')).toBe(false);
    expect(link?.hasAttribute('href')).toBe(true);
    expect(showSessionActionFeedbackMock).not.toHaveBeenCalled();
    dispatchAnchorClick(link);
    flushSolid();
    expect(send).toHaveBeenCalledTimes(2);
    const retryId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId: retryId, status: 'opened' } },
      })
    );
    flushSolid();
  });

  it('disables a missing file link and shows warning feedback', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    mount(() => MarkdownRenderer({ content: '`missing-file.ts`', cacheByContent: true }));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    dispatchAnchorClick(link);
    flushSolid();
    // SAFETY: The fixture provides the { payload: { requestId: number } } fields read by this statement.
    const requestId = (send.mock.calls[0]![0] as { payload: { requestId: number } }).payload
      .requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'unavailable' } },
      })
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(link?.classList.contains('is-unavailable')).toBe(true);
    expect(link?.getAttribute('aria-disabled')).toBe('true');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.hasAttribute('title')).toBe(false);
    link?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'File not found: missing-file.ts'
      )
    );
    flushSolid();
    link?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'File not found: missing-file.ts',
      'warning'
    );

    dispatchAnchorClick(link);
    flushSolid();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('warns when a file-path-link payload fails to parse', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    link!.dataset.file = '{invalid';

    dispatchAnchorClick(link);
    flushSolid();

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

  it.each([
    'a.session-reference-link',
    '.session-reference-link .link-leading-label',
    '.session-reference-link .session-reference-icon',
  ])('selects a workspace session when clicking %s in Markdown', (target) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(storePath('activeSessionId', 'ses_origin123'));
    applyState(
      storePath('sessions', [
        {
          id: 'ses_found123',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Permission request states',
          version: '1',
          time: { created: 0, updated: 0 },
        },
      ])
    );

    mount(() =>
      MarkdownRenderer({
        content: 'Session session:ses_found123 and session:ses_missing456. `session:ses_found123`',
        cacheByContent: true,
      })
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.session-reference-link');
    expect(link?.textContent).toBe('Permission request states');
    expect(link?.getAttribute('href')).toBe('#session/ses_found123');
    expect(link?.dataset.sessionId).toBe('ses_found123');
    expect(link?.querySelector('.session-reference-icon')).not.toBeNull();
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Permission request states',
      webviewSection: 'varroLink',
    });
    expect(link?.querySelector('.link-leading-content')?.textContent).toBe('Permission');
    expect(link?.querySelector('.link-leading-label')?.textContent).toBe('Permission');
    expect(container?.textContent).toContain('session:ses_missing456');
    expect(container?.querySelector('code a')).toBeNull();

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const element = container!.querySelector(target);
    expect(element).not.toBeNull();
    element!.dispatchEvent(click);
    flushSolid();
    expect(click.defaultPrevented).toBe(true);
    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('ses_found123', {
      directory: '/repo',
    });
    expect(getDirectSessionReturnId('ses_found123')).toBe('ses_origin123');
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves an unloaded cross-project ID and opens it in its own project window', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    const reference = {
      id: 'ses_external123',
      title: 'Review release',
      directory: '/projects/other',
      external: true,
    };
    const lookup = vi.spyOn(client.varro.session, 'reference').mockResolvedValue(reference);
    const open = vi.spyOn(client.varro.session, 'openReference').mockResolvedValue();
    applyState(
      storePath('serverStatus', { state: 'running', url: 'http://localhost/markdown-references' })
    );
    applyState(storePath('activeSessionId', 'ses_origin'));
    mount(() =>
      MarkdownRenderer({ content: 'Check this too ses_external123', cacheByContent: true })
    );
    await vi.waitFor(() =>
      expect(container?.querySelector('a.session-reference-link')?.textContent).toBe(
        'Review release · other'
      )
    );
    flushSolid();
    const link = container?.querySelector<HTMLAnchorElement>('a.session-reference-link');
    expect(lookup).toHaveBeenCalledExactlyOnceWith('ses_external123');
    expect(link?.dataset.sessionDirectory).toBe('/projects/other');
    expect(link?.dataset.sessionExternal).toBe('true');
    dispatchAnchorClick(link);
    flushSolid();
    expect(open).toHaveBeenCalledExactlyOnceWith('ses_external123');
    expect(selectSessionMock).not.toHaveBeenCalled();
    expect(getDirectSessionReturnId('ses_external123')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('updates session references when a matching workspace session is discovered', async () => {
    const content = 'Open ses_discovered123';
    mount(() => MarkdownRenderer({ content, cacheByContent: true }));

    expect(container?.querySelector('a.session-reference-link')).toBeNull();
    expect(container?.textContent).toContain('ses_discovered123');

    applyState(
      storePath('sessions', [
        {
          id: 'ses_discovered123',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Discovered session',
          version: '1',
          time: { created: 0, updated: 0 },
        },
      ])
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('a.session-reference-link')?.textContent).toBe(
      'Discovered session'
    );
  });

  it('invalidates finalized multi-reference Markdown after renaming and removing sessions', async () => {
    applyState(
      storePath(
        'sessions',
        ['first', 'second'].map((name) => ({
          id: `ses_${name}`,
          projectID: 'project-1',
          directory: '/repo',
          title: name,
          version: '1',
          time: { created: 0, updated: 0 },
        }))
      )
    );
    const content = 'Open ses_first and session:ses_second.';
    mount(() => MarkdownRenderer({ content, cacheByContent: true }));
    expect(container?.querySelectorAll('a.session-reference-link')).toHaveLength(2);

    applyState(storePath('sessions', 0, 'title', 'Renamed first'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    flushSolid();
    expect(container?.querySelector('[data-session-id="ses_first"]')?.textContent).toBe(
      'Renamed first'
    );
    expect(container?.querySelector('[data-session-id="ses_second"]')?.getAttribute('href')).toBe(
      '#session/ses_second'
    );

    applyState(storePath('sessions', []));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    flushSolid();
    expect(container?.querySelector('a.session-reference-link')).toBeNull();
    expect(container?.textContent).toContain(content);
  });

  it('does not treat protocol-relative links as local files', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    mount(() => MarkdownRenderer({ content: '[External-ish](//example.test/path)' }));

    const link = container?.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);

    dispatchAnchorClick(link);
    flushSolid();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['https://example.test/docs', 'http://localhost:3000', 'http://app.above-all.test/docs'])(
    'makes the external link %s actionable',
    (url) => {
      const send = vi.fn();
      window.__sendToExtension = send;

      mount(() =>
        MarkdownRenderer({
          content: `[Docs](${url}) ${url}\n\n| Component | URL |\n| --- | --- |\n| App | ${url} |`,
          cacheByContent: true,
        })
      );

      const links = Array.from(container?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(link.getAttribute('data-external')).toBe('true');
        expect(link.getAttribute('href')).toBe(url);
        expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}')).toEqual({
          preventDefaultContextMenuItems: true,
          varroLinkText: link.textContent,
          webviewSection: 'varroExternalLink',
          varroLinkUrl: url,
        });
        expect(link.querySelector('.external-link-icon')).toBeInstanceOf(HTMLImageElement);
        dispatchAnchorClick(link);
        flushSolid();
        expect(send).toHaveBeenLastCalledWith({
          type: 'vscode/open-external',
          payload: { url },
        });
      }
      expect(send).toHaveBeenCalledTimes(3);
    }
  );

  it.each(['http://ingest.above-all.test/', 'https://example.test/docs'])(
    'does not forward handled clicks on %s to the VS Code webview host',
    (url) => {
      const send = vi.fn();
      window.__sendToExtension = send;
      mount(() =>
        MarkdownRenderer({
          content: `[Docs](${url}) ${url}\n\n| URL |\n| --- |\n| ${url} |`,
          cacheByContent: true,
        })
      );

      // VS Code's window listener forwards anchor clicks even when defaultPrevented is true.
      const hostLinkHandler = vi.fn();
      window.addEventListener('click', hostLinkHandler);
      flushSolid();
      try {
        const links = container!.querySelectorAll<HTMLAnchorElement>('a.external-link');
        expect(links).toHaveLength(3);
        for (const link of links) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true });
          link.querySelector('.link-leading-label')!.dispatchEvent(event);
          flushSolid();
          expect(event.defaultPrevented).toBe(true);
        }
        expect(send.mock.calls).toEqual(
          Array.from({ length: 3 }, () => [{ type: 'vscode/open-external', payload: { url } }])
        );
        expect(hostLinkHandler).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('click', hostLinkHandler);
        flushSolid();
      }
    }
  );

  it('re-renders workspace-relative links when the workspace changes', async () => {
    mount(() => MarkdownRenderer({ content: '[Open file](./src/webview/App.tsx)' }));

    expect(container?.querySelector('a.file-path-link')?.getAttribute('href')).toBe(
      './src/webview/App.tsx'
    );

    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const link = container?.querySelector('a.file-path-link');
    expect(link?.getAttribute('href')).toBe('/repo/src/webview/App.tsx');
    expect(link?.getAttribute('data-file')).toBe(JSON.stringify({ path: './src/webview/App.tsx' }));
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Open file',
      webviewSection: 'varroFileLink',
      varroFilePath: '/repo/src/webview/App.tsx',
    });
  });

  it.each([
    'A link opening `/repo/packages/app/src/app.ts` can therefore copy and display `/other-workspace/src/app.ts`.',
    '- A link opening `/repo/packages/app/src/app.ts` can therefore copy and display `/other-workspace/src/app.ts`.',
    'For example, `/repo/packages/app/src/app.ts` and `/other-workspace/src/app.ts` are different paths.',
    'The reference `/repo/packages/app/src/app.ts` becomes `/other-workspace/src/app.ts`.',
    '| Example |\n| --- |\n| Suppose `/repo/packages/app/src/app.ts` resolves to `/other-workspace/src/app.ts`. |',
  ])('preserves illustrative inline-code paths in %s', (content) => {
    container!.innerHTML = __parseMarkdownForTests(content, { cacheByContent: true });

    expect([...container!.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      '/repo/packages/app/src/app.ts',
      '/other-workspace/src/app.ts',
    ]);
    expect(container!.querySelector('a.file-path-link')).toBeNull();
    expect(container!.querySelector('[data-inferred-code-path]')).toBeNull();
  });

  it('limits illustrative prose to its block and preserves explicit Markdown links', () => {
    container!.innerHTML = __parseMarkdownForTests(
      'For example, `/repo/packages/app/src/app.ts` could display `/other-workspace/src/app.ts`. ' +
        'See [`src/app.ts`](src/app.ts#L10-L12).\n\n' +
        'Updated `src/examples/app.ts` and `src/other/app.ts`.',
      { cacheByContent: true }
    );

    const links = [...container!.querySelectorAll<HTMLAnchorElement>('a.file-path-link')];
    expect(links.map((link) => link.textContent)).toEqual([
      'app.ts (line 10-12)',
      'src/examples/app.ts',
      'src/other/app.ts',
    ]);
    expect(links.map((link) => JSON.parse(link.dataset.file!))).toEqual([
      { path: 'src/app.ts', line: 10, endLine: 12 },
      { path: 'src/examples/app.ts' },
      { path: 'src/other/app.ts' },
    ]);
    expect(container!.querySelectorAll('code')).toHaveLength(2);
  });

  it('strips inline code backticks from symbol labels of file links', () => {
    container!.innerHTML = __parseMarkdownForTests(
      '- [`preprocess()`](src/utils.py:12): normalizes inputs',
      { cacheByContent: true }
    );

    const link = container!.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('preprocess()');
    expect(JSON.parse(link!.dataset.file!)).toEqual({ path: 'src/utils.py', line: 12 });
  });

  it('keeps the screenshot example filename as code during streaming and after completion', async () => {
    const [content, setContent] = createSignal(
      'The new regressions pass, including the two `app.ts` example paths'
    );
    const [streaming, setStreaming] = createSignal(true);
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        get forceStreaming() {
          return streaming();
        },
      })
    );

    for (const complete of [false, true]) {
      if (complete) {
        setContent(
          'The new regressions pass, including the two `app.ts` example paths and ordinary references that should stay clickable. ' +
            'All 341 renderer tests pass, and both type checks are clean.'
        );
        flushSolid();
        setStreaming(false);
        flushSolid();
      }
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container!.querySelector('code')?.textContent).toBe('app.ts');
      expect(container!.querySelector('a.file-path-link')).toBeNull();
    }
  });

  it.each([
    '`src/first/app.ts:10-12` and `src/second/app.ts:20-22`',
    'You can open `src/first/app.ts:10-12` and `src/second/app.ts:20-22`.',
    'src/first/app.ts:10-12 and src/second/app.ts:20-22',
  ])('retains full inferred path text and ranges in %s', (content) => {
    container!.innerHTML = __parseMarkdownForTests(content, { cacheByContent: true });

    const links = [...container!.querySelectorAll<HTMLAnchorElement>('a.file-path-link')];
    expect(links.map((link) => link.textContent)).toEqual([
      'src/first/app.ts:10-12',
      'src/second/app.ts:20-22',
    ]);
    expect(links.map((link) => JSON.parse(link.dataset.file!))).toEqual([
      { path: 'src/first/app.ts', line: 10, endLine: 12 },
      { path: 'src/second/app.ts', line: 20, endLine: 22 },
    ]);
  });

  it('links file-only inline code but not ordinary inline or fenced code', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      MarkdownRenderer({
        content: '`spotlight` `src/shared/protocol.ts`\n\n```txt\nsrc/webview/App.tsx\n```',
        cacheByContent: true,
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(1);
    expect(link?.textContent).toBe('src/shared/protocol.ts');
    expect(link?.querySelector('code')).toBeNull();
    expect(link?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(link?.querySelector('.link-leading-label')?.textContent).toBe('src/shared/protocol.ts');
    expect(container?.querySelector('pre a.file-path-link')).toBeNull();
    expect(container?.textContent).toContain('spotlight');

    dispatchAnchorClick(link);
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: 'src/shared/protocol.ts',
        line: undefined,
        kind: 'file',
        exact: true,
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
    flushSolid();
  });

  it('does not linkify dotted API identifiers as files', () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      MarkdownRenderer({
        content:
          'Use workspace.fs, files.exclude, and search.exclude directly, including `workspace.fs` in code.',
        cacheByContent: true,
      })
    );

    expect(container?.querySelector('a.file-path-link')).toBeNull();
    expect(container?.textContent).toContain('workspace.fs');
    expect(container?.textContent).toContain('files.exclude');
    expect(container?.textContent).toContain('search.exclude');
    expect(container?.querySelector('code')?.textContent).toBe('workspace.fs');
  });

  it.each([
    {
      content: '`src/shared/protocol.ts`',
      label: 'src/shared/protocol.ts',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: 'Review src/shared/protocol.ts.',
      label: 'src/shared/protocol.ts',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '`src/shared/protocol.ts:12-15`',
      label: 'src/shared/protocol.ts:12-15',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '[src/shared/protocol.ts](./src/shared/protocol.ts:12)',
      label: 'protocol.ts (line 12)',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '`C:\\repo\\src\\App.tsx:12`',
      label: 'C:\\repo\\src\\App.tsx:12',
      path: 'C:/repo/src/App.tsx',
    },
    { content: '[Project folder](src)', label: 'Project folder', path: '/repo/src' },
    { content: '[Project folder](src/)', label: 'Project folder', path: '/repo/src' },
    { content: '[Project folder](./src)', label: 'Project folder', path: '/repo/src' },
    { content: '[Project folder](.)', label: 'Project folder', path: '/repo' },
    { content: '[Project folder](/repo/src/)', label: 'Project folder', path: '/repo/src' },
    { content: '[Project folder](file:///repo/src/)', label: 'Project folder', path: '/repo/src' },
    {
      content: '[Project folder](file:///repo/folder%20with%20spaces/)',
      label: 'Project folder',
      path: '/repo/folder with spaces',
    },
    {
      content: '[Project folder](file:///C:/repo/src/)',
      label: 'Project folder',
      path: 'C:/repo/src',
    },
    {
      content: '[Local file](file:///repo/README.md)',
      label: 'Local file',
      path: '/repo/README.md',
    },
  ])('provides a native copy-path target for $content', ({ content, label, path }) => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    mount(() => MarkdownRenderer({ content, cacheByContent: true }));

    const link = container!.querySelector('a.file-path-link');
    expect(link?.textContent).toBe(label);
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: label,
      webviewSection: 'varroFileLink',
      varroFilePath: path,
    });
  });

  it('linkifies only text nodes and leaves path-looking attributes unchanged', () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    const html = __parseMarkdownForTests(
      '<span title="src/webview/App.tsx" aria-label="docs/guide.md">Metadata</span> and src/shared/protocol.ts.',
      { cacheByContent: false }
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    const metadata = root.querySelector('span[title]');
    expect(metadata?.getAttribute('title')).toBe('src/webview/App.tsx');
    expect(metadata?.getAttribute('aria-label')).toBe('docs/guide.md');
    const links = root.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe('src/shared/protocol.ts');
    expect(links[0]?.title).toBe('/repo/src/shared/protocol.ts');
  });

  it('derives native copy-path context from the target instead of untrusted HTML attributes', () => {
    mount(() =>
      MarkdownRenderer({
        content:
          '<a href="/repo/src/safe.ts" data-vscode-context=\'{"webviewSection":"varroFileLink","varroFilePath":"/other/file.ts"}\'>Safe</a>',
        cacheByContent: true,
      })
    );

    const link = container!.querySelector('a');
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Safe',
      webviewSection: 'varroFileLink',
      varroFilePath: '/repo/src/safe.ts',
    });
  });

  it('sanitizes copied code payloads before writing to the clipboard', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const oversized = 'A'.repeat(25_000);
    mount(() => MarkdownRenderer({ content: '```txt\nplaceholder\n```' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const button = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    button!.dataset.copyText = `line%201%0D%0Aline%202%00${encodeURIComponent(oversized)}`;
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

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

    mount(() => MarkdownRenderer({ content: '```ts\nconst value = 1;\n```' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const button = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    expect(button).toBeTruthy();
    expectUiIcon(button?.firstElementChild, copyIcon, 14);

    vi.useFakeTimers();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expectUiIcon(button?.firstElementChild, checkIcon, 14);

    vi.advanceTimersByTime(1500);
    flushSolid();
    expectUiIcon(button?.firstElementChild, copyIcon, 14);
  });

  it('renders fenced code blocks with syntax highlight spans when the language is known', async () => {
    mount(() => MarkdownRenderer({ content: '```ts\nconst value = 1;\n```' }));
    await vi.waitFor(() => expect(container?.querySelector('.hljs-keyword')).not.toBeNull());
    flushSolid();

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
  ])('highlights common language %s', async (lang, source) => {
    await requestHighlight(source, lang);
    flushSolid();
    expect(renderHighlightedCodeHtml(source, lang)).toContain('hljs-');
    flushSolid();
  });

  it.each([
    ['js', 'const value = 1;', 'hljs-keyword'],
    ['tsx', 'const node = <div />;', 'hljs-keyword'],
    ['py', 'def greet():\n    pass', 'hljs-keyword'],
    ['html', '<main>hello</main>', 'hljs-tag'],
    ['yml', 'key: value', 'hljs-attr'],
  ])('highlights language alias %s', async (lang, source, expectedClass) => {
    await requestHighlight(source, lang);
    flushSolid();
    expect(renderHighlightedCodeHtml(source, lang)).toContain(expectedClass);
    flushSolid();
  });

  it('handles explicit plain text languages without highlighting', () => {
    expect(renderHighlightedCodeHtml('plain <text>', 'txt')).toBe('plain &lt;text&gt;');
    flushSolid();
  });

  it('reuses sanitized html for cached finalized content across remounts', async () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');
    const content = 'Finalized cache test `7mwnc`';

    mount(() => MarkdownRenderer({ content, cacheByContent: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);

    cleanup?.();
    flushSolid();
    cleanup = undefined;

    container = document.createElement('div');
    document.body.appendChild(container);

    mount(() => MarkdownRenderer({ content, cacheByContent: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
  });

  it('separates finalized markdown cache entries by render options', async () => {
    await requestHighlight('const value = 1;', 'ts');
    flushSolid();
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

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

  it('separates code block cache entries by highlighting mode', async () => {
    await requestHighlight('const value = 1;', 'ts');
    flushSolid();
    const params = { text: 'const value = 1;', lang: 'ts' };
    expect(renderCodeBlockHtml({ ...params, disableHighlighting: true })).not.toContain(
      'hljs-keyword'
    );
    flushSolid();
    expect(renderCodeBlockHtml(params)).toContain('hljs-keyword');
    flushSolid();
  });

  it('does not cache a pending code block as a completed highlighted block', async () => {
    const params = { text: 'const pendingCacheValue = 2;', lang: 'ts' };
    expect(renderCodeBlockHtml(params)).toContain('data-highlight-lang');
    flushSolid();
    await requestHighlight(params.text, params.lang);
    flushSolid();
    const completed = renderCodeBlockHtml(params);
    flushSolid();
    expect(completed).toContain('hljs-keyword');
    expect(completed).not.toContain('data-highlight-lang');
    expect(renderCodeBlockHtml(params)).toBe(completed);
    flushSolid();
  });

  it('does not cache transient sanitization across remounts', async () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');
    const content = 'Streaming cache bypass test `d9q2p`';

    mount(() => MarkdownRenderer({ content }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const callsAfterFirstMount = sanitizeSpy.mock.calls.length;
    expect(callsAfterFirstMount).toBeGreaterThan(0);

    cleanup?.();
    flushSolid();
    cleanup = undefined;

    container = document.createElement('div');
    document.body.appendChild(container);

    mount(() => MarkdownRenderer({ content }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(sanitizeSpy.mock.calls.length).toBe(callsAfterFirstMount + 1);
  });

  it('renders streaming content in stable and tail segments', async () => {
    mount(() => MarkdownRenderer({ content: 'First paragraph\n\nSecond paragraph' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const stableSegment = container?.querySelector('[data-markdown-segment="stable"]');
    const tailSegment = container?.querySelector('[data-markdown-segment="tail"]');

    expect(stableSegment?.innerHTML).toContain('<p>First paragraph</p>');
    expect(tailSegment?.innerHTML).toContain('<p>Second paragraph</p>');
  });

  it('reserves an incomplete streaming table until its delimiter row is complete', async () => {
    const [content, setContent] = createSignal('Status follows.\n\n| No.');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.textContent).toContain('Status follows.');
    expect(container?.textContent).toContain('No.');
    expect(
      container?.querySelector('.streaming-markdown-pending')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(container?.querySelector('table')).toBeNull();

    setContent('Status follows.\n\n| No. | Area | State | Lead | Action |\n|---|---|---|---');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).toContain('Action');
    expect(container?.querySelector('.streaming-markdown-pending')).not.toBeNull();
    expect(container?.querySelector('table')).toBeNull();

    setContent('Status follows.\n\n| No. | Area | State | Lead | Action |\n|---|---|---|---|---|');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('Action');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });

  it('holds the active streaming table body row until its line completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const [content, setContent] = createSignal(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Act'
    );
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        get cacheByContent() {
          return completed();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n| Next | ' +
        'Still streaming a long description. '.repeat(30)
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container?.querySelector('tbody')?.textContent).toContain('Renderer');
    expect(container?.textContent).not.toContain('Still streaming');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent('Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('tbody')?.textContent).toContain('Renderer');
    expect(container?.querySelector('tbody')?.textContent).toContain('Active');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n| Final | Done |'
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(1);

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container?.querySelector('tbody')?.textContent).toContain('Done');
  });

  it('renders a complete streaming table without trailing pipes', async () => {
    mount(() => MarkdownRenderer({ content: 'Status follows.\n\n| Name | State\n| --- | ---' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('State');
  });

  it('counts escaped pipes as table cell content while streaming', async () => {
    mount(() =>
      MarkdownRenderer({ content: 'Status follows.\n\n| Name \\| Alias | State\n| --- | ---' })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('Name | Alias');
  });

  it('counts pipes after an even backslash run as table separators', async () => {
    mount(() =>
      MarkdownRenderer({
        content: 'Status follows.\n\n| Path \\\\| State | Owner\n| --- | --- | ---',
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('table')).not.toBeNull();
  });

  it('holds incomplete streaming block delimiters', async () => {
    const [content, setContent] = createSignal('Stable text.\n\n## ');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('h2')).toBeNull();
    expect(container?.querySelector('.streaming-markdown-pending')?.textContent.trim()).toBe('##');

    setContent('Stable text.\n\n## 40. Delivery\n\n```ts\nconst ready = true;\n``');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('h2')?.textContent).toBe('40. Delivery');
    expect(container?.querySelector('code')?.textContent?.trim()).toBe('const ready = true;');
    expect(container?.querySelector('.streaming-markdown-pending')?.textContent).toBe('``');

    setContent('Stable text.\n\n## 40. Delivery\n\n```ts\nconst ready = true;\n```');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('code')?.textContent?.trim()).toBe('const ready = true;');
  });

  it('paints an active ordered-list item while it streams', async () => {
    const base = 'Scope protects attention.';
    const [content, setContent] = createSignal(`${base}\n\n6`);
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        forceStreaming: true,
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.textContent).toContain('6');

    setContent(`${base}\n\n6.`);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const marker = container?.querySelector('.streaming-markdown-pending');
    expect(marker?.textContent).toBe('6.');
    expect(marker?.getAttribute('aria-hidden')).toBeNull();
    expect(marker?.classList).not.toContain('streaming-markdown-pending-hidden');

    setContent(`${base}\n\n6. A bounded task identifies`);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('ol li')?.textContent).toBe('A bounded task identifies');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(`${base}\n\n6. A bounded task identifies\n`);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('ol li')?.textContent).toBe('A bounded task identifies');
  });

  it('does not reparse the stable streaming segment when only the tail grows', async () => {
    const [content, setContent] = createSignal('First paragraph\n\nSecond');
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');

    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const stableSegment = container?.querySelector('[data-markdown-segment="stable"]');
    const initialStableHtml = stableSegment?.innerHTML;
    const initialSanitizeCalls = sanitizeSpy.mock.calls.length;

    setContent('First paragraph\n\nSecond paragraph extended');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('[data-markdown-segment="stable"]')?.innerHTML).toBe(
      initialStableHtml
    );
    expect(sanitizeSpy.mock.calls.length).toBeGreaterThan(initialSanitizeCalls);
    expect(sanitizeSpy.mock.calls.length - initialSanitizeCalls).toBe(1);
  });

  it('linkifies complete file references in the streaming tail', async () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    mount(() => MarkdownRenderer({ content: 'Stable paragraph\n\n`./src/webview/App.tsx`' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const stableLinks = container?.querySelectorAll(
      '[data-markdown-segment="stable"] a.file-path-link'
    );
    const tailLinks = container?.querySelectorAll(
      '[data-markdown-segment="tail"] a.file-path-link'
    );

    expect(stableLinks).toHaveLength(0);
    expect(tailLinks).toHaveLength(1);
    expect(tailLinks?.[0]?.textContent).toBe('./src/webview/App.tsx');
    expect(tailLinks?.[0]?.getAttribute('href')).toBe('/repo/src/webview/App.tsx');
  });

  it('reserves an unclosed inline-code suffix without linking it', async () => {
    const [content, setContent] = createSignal(
      'The related tests are in `src/webview/components/Markdown'
    );
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const paragraph = container?.querySelector('[data-markdown-segment="tail"] p');
    expect(paragraph?.textContent).not.toContain('src/webview/components/Markdown');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).not.toContain('MarkdownRenderer.test.ts');
    expect(container?.querySelector('.streaming-markdown-pending')).not.toBeNull();

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts`');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('src/webview/components/MarkdownRenderer.test.ts');
    expect(link?.getAttribute('href')).toBe(
      '/repo/src/webview/components/MarkdownRenderer.test.ts'
    );
    expect(container?.textContent).toContain('src/webview/components/MarkdownRenderer.test.ts');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });

  it.each([
    { name: 'a bullet list', prefix: 'Two corrections:\n\n- ', visibleItems: 0, pendingItems: 0 },
    {
      name: 'a numbered list',
      prefix: 'Two corrections:\n\n3. ',
      visibleItems: 0,
      pendingItems: 1,
    },
    {
      name: 'a later bullet',
      prefix: 'Two corrections:\n\n- First visible item.\n- ',
      visibleItems: 1,
      pendingItems: 1,
    },
  ])(
    'shows an indicator in $name while its inline code is unfinished',
    async ({ prefix, visibleItems, pendingItems }) => {
      const [content, setContent] = createSignal(`${prefix}\`Open as Edi`);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        })
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();

      // The pending block shows dots without painting an orphan list marker.
      const paintedItems = () =>
        Array.from(container!.querySelectorAll('li')).filter(
          (item) => !item.closest('.streaming-markdown-pending-block')
        );
      expectStreamingIndicator(container!);
      expect(container?.textContent).not.toContain('`Open as Edi');
      expect(paintedItems()).toHaveLength(pendingItems);

      setContent(`${content()}tor\` is not a model-change event.`);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container?.querySelector('.streaming-markdown-pending-block')).toBeNull();
      expect(paintedItems()).toHaveLength(visibleItems + 1);
      expect(container?.querySelector('li:last-child code')?.textContent).toBe('Open as Editor');
    }
  );

  it.each(['- ', '* ', '-'])(
    'does not paint an empty trailing %j bullet before its content arrives',
    async (marker) => {
      const [content, setContent] = createSignal(`Two corrections:\n\n${marker}`);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        })
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();

      // An empty item paints an orphan marker and gives the paragraph list spacing that
      // disappears again when the item's first token is still hidden.
      const visibleItems = () =>
        Array.from(container!.querySelectorAll('li')).filter(
          (item) => !item.closest('.streaming-markdown-pending-block')
        );
      expect(visibleItems()).toHaveLength(0);
      expect(
        container?.querySelector('[data-markdown-tail-tag]')?.getAttribute('data-markdown-tail-tag')
      ).toBe('');

      setContent(`Two corrections:\n\n- \`Open as Edi`);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(visibleItems()).toHaveLength(0);
      expectStreamingIndicator(container!);
      expect(
        container?.querySelector('[data-markdown-tail-tag]')?.getAttribute('data-markdown-tail-tag')
      ).toBe('ul');
      expect(container?.querySelector('p.streaming-markdown-pending-list')).not.toBeNull();

      setContent(`Two corrections:\n\n- \`Open as Editor\` is not a model-change event.`);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(visibleItems()).toHaveLength(1);
      expect(visibleItems()[0]?.querySelector('code')?.textContent).toBe('Open as Editor');
    }
  );

  // ses_dfde9136fffeaRG6Zgn3qN4oED: a stream paused at these exact boundaries turned the
  // preceding nested item into a setext heading or painted an empty item or quotation.
  const transientMarkerSamples = (root: HTMLElement) => {
    const visible = (element: Element) =>
      !element.closest('.streaming-markdown-pending-block, .streaming-markdown-pending-hidden');
    const visibleText = (element: Element) => {
      // SAFETY: cloneNode preserves the node type of the source Element.
      const copy = element.cloneNode(true) as Element;
      for (const hidden of copy.querySelectorAll(
        '.streaming-markdown-pending-block, .streaming-markdown-pending-hidden'
      ))
        hidden.remove();
      return copy.textContent?.trim() ?? '';
    };
    return [
      ...Array.from(root.querySelectorAll('li :is(h1, h2, h3, h4, h5, h6)'))
        .filter(visible)
        .map((heading) => `heading in item: ${heading.outerHTML}`),
      ...Array.from(root.querySelectorAll('blockquote :is(h1, h2, h3, h4, h5, h6)'))
        .filter(visible)
        .map((heading) => `heading in quotation: ${heading.outerHTML}`),
      ...Array.from(root.querySelectorAll('li'))
        .filter((item) => visible(item) && !visibleText(item))
        .map((item) => `empty item: ${item.parentElement?.outerHTML}`),
      ...Array.from(root.querySelectorAll('blockquote'))
        .filter((quote) => visible(quote) && !visibleText(quote))
        .map((quote) => `empty quotation: ${quote.outerHTML}`),
      ...Array.from(root.querySelectorAll('p'))
        .filter((paragraph) => visible(paragraph) && /^-{1,2}$/.test(visibleText(paragraph)))
        .map((paragraph) => `partial rule: ${paragraph.outerHTML}`),
    ];
  };
  const nestedListSample = [
    '### Nested lists',
    '',
    '- Workspace',
    '  - Source files',
    '    - Components',
    '      - Message list',
    '      - Input field',
    '    - Utilities',
    '      - Parsing',
  ].join('\n');
  const quotedListSample = [
    '> A short quotation can occupy one line.',
    '',
    '> A longer quotation may wrap across several lines depending on the available width.',
    '>',
    '> A second paragraph belongs to the same quotation.',
    '>',
    '> - A quoted list item.',
    '> - Another quoted list item with **emphasis**.',
    '',
    '### Nested quotation',
    '',
    '> The outer quotation begins here.',
    '>',
    '> > The inner quotation adds another level.',
    '> >',
    '> > This paragraph remains inside the inner quotation.',
  ].join('\n');
  const ruleSample = [
    'All names, measurements, and results below are fictional test data.',
    '',
    '---',
    '',
    '## 1. Basic text formatting',
  ].join('\n');

  it.each([
    { name: 'a four-space nested bullet', sample: nestedListSample, boundary: '\n    -' },
    { name: 'a six-space nested bullet', sample: nestedListSample, boundary: '\n      -' },
    { name: 'a quoted bullet', sample: quotedListSample, boundary: '\n> -' },
    { name: 'a new quotation', sample: quotedListSample, boundary: '\n\n>' },
    { name: 'a nested quotation', sample: quotedListSample, boundary: '\n> >' },
    { name: 'a thematic break', sample: ruleSample, boundary: '\n\n--' },
  ])(
    'does not paint transient structure when a stream pauses at $name',
    async ({ sample, boundary }) => {
      const prefixes: string[] = [];
      for (let index = sample.indexOf(boundary); index >= 0;) {
        const end = index + boundary.length;
        prefixes.push(sample.slice(0, end), `${sample.slice(0, end)} `);
        index = sample.indexOf(boundary, end);
      }
      expect(prefixes.length).toBeGreaterThan(0);
      const [content, setContent] = createSignal('Starting...');
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        })
      );

      const findings: string[] = [];
      for (const prefix of [...prefixes, sample]) {
        setContent(`Starting...\n\n${prefix}`);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        flushSolid();
        findings.push(
          ...transientMarkerSamples(container!).map(
            (finding) => `${JSON.stringify(prefix)}: ${finding}`
          )
        );
      }
      expect(findings).toEqual([]);
    }
  );

  it.each([
    {
      name: 'a genuine setext heading',
      content: 'Starting...\n\nSettled title\n---',
      selector: 'h2',
      text: 'Settled title',
    },
    {
      name: 'a complete thematic break',
      content: 'Starting...\n\nAbove the rule.\n\n---',
      selector: 'hr',
      text: '',
    },
    {
      name: 'a nested bullet inside an open code fence',
      content: 'Starting...\n\n```md\n- Workspace\n  - Source files\n    -',
      selector: 'pre code',
      text: '- Workspace\n  - Source files\n    -',
    },
    {
      name: 'a quotation marker inside an open code fence',
      content: 'Starting...\n\n```md\n> The outer quotation begins here.\n>\n> >',
      selector: 'pre code',
      text: '> The outer quotation begins here.\n>\n> >',
    },
    {
      // Indented code blocks are disabled, so deep indentation is prose once content arrives.
      name: 'deeply indented marker text after a paragraph break',
      content: 'Starting...\n\nIndented sample:\n\n    - literal',
      selector: '[data-markdown-segment="tail"] p',
      text: '- literal',
    },
    {
      name: 'an escaped nested marker',
      content: 'Starting...\n\n- Workspace\n  - Source files\n    \\-',
      selector: 'li li',
      text: 'Source files\n-',
    },
    {
      name: 'a genuine nested setext heading',
      content: 'Starting...\n\n- Workspace\n  - Source files\n    ---',
      selector: 'li li h2',
      text: 'Source files',
    },
    {
      name: 'a genuine quoted setext heading',
      content: 'Starting...\n\n> Quoted title\n> ---',
      selector: 'blockquote h2',
      text: 'Quoted title',
    },
    {
      name: 'a quoted ordered item',
      content: 'Starting...\n\n> 1. First quoted step',
      selector: 'blockquote ol li',
      text: 'First quoted step',
    },
    {
      name: 'a quoted bullet item',
      content: 'Starting...\n\n> - A quoted list item.',
      selector: 'blockquote ul li',
      text: 'A quoted list item.',
    },
    {
      name: 'a quotation continued after a blank quoted line',
      content: 'Starting...\n\n> First paragraph.\n>\n> Second paragraph.',
      selector: 'blockquote p:last-child',
      text: 'Second paragraph.',
    },
  ])('keeps $name visible while streaming', async ({ content, selector, text }) => {
    mount(() => createComponent(MarkdownRenderer, { content, forceStreaming: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    const element = container?.querySelector(selector);
    expect(element, container?.innerHTML).not.toBeNull();
    expect(element?.textContent?.trim()).toBe(text);
  });

  it('defers a deeply indented bare marker only while it is the streaming line', async () => {
    // Indented code blocks are disabled: settled `    -` is prose, never literal code. Streaming
    // defers that one trailing marker until its content or line break arrives.
    const content = 'Starting...\n\nIndented sample:\n\n    -';
    const [streaming, setStreaming] = createSignal(true);
    const [text, setText] = createSignal(content);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return text();
          },
          get forceStreaming() {
            return streaming();
          },
        }),
      container!
    );
    const settle = async () => {
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
    };
    await settle();
    expect(container?.querySelector('pre')).toBeNull();
    expect(transientMarkerSamples(container!)).toEqual([]);
    expect(
      container?.querySelector('[data-markdown-segment="tail"] .streaming-markdown-pending-hidden')
        ?.textContent
    ).toBe('    -');

    setText(`${content}\n`);
    await settle();
    expect(container?.querySelector('[data-markdown-segment="tail"] p')?.textContent?.trim()).toBe(
      '-'
    );

    setText(content);
    setStreaming(false);
    await settle();
    expect(container?.querySelector('pre')).toBeNull();
    expect(
      Array.from(container!.querySelectorAll('p')).at(-1)?.textContent?.trim(),
      container?.innerHTML
    ).toBe('-');
  });

  it.each([
    { delimiter: '`', chunks: ['npm', ' run', ' test'] },
    { delimiter: '``', chunks: ['npm', ' `run`', ' test', '`'] },
  ])(
    'holds unfinished $delimiter inline code until its matching closer arrives',
    async ({ delimiter, chunks }) => {
      const prefix = 'Stable paragraph.\n\n- Passed `npm run lint`, now run ';
      const [content, setContent] = createSignal(`${prefix}${delimiter}`);
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        })
      );

      for (const chunk of ['', ...chunks]) {
        setContent(content() + chunk);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        flushSolid();
        expectStreamingIndicator(container!);
        expect(Array.from(container!.querySelectorAll('code'), (code) => code.textContent)).toEqual(
          ['npm run lint']
        );
      }

      // The double-backtick case receives the first closing backtick in a separate delta.
      setContent(`${content()}\` now.`);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
      expect(Array.from(container!.querySelectorAll('code'), (code) => code.textContent)).toEqual([
        'npm run lint',
        delimiter.length === 2 ? 'npm `run` test' : 'npm run test',
      ]);
      expect(container?.querySelector('li')?.textContent).toContain(' now.');
    }
  );

  it.each(['<', '</', '<details', '</details', '<span title="more'])(
    'hides an unfinished HTML tag %s until streaming settles',
    async (tag) => {
      const [completed, setCompleted] = createSignal(false);
      mount(() =>
        createComponent(MarkdownRenderer, {
          content: `Stable paragraph.\n\n${tag}`,
          get cacheByContent() {
            return completed();
          },
        })
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container?.textContent).not.toContain(tag);
      expect(container?.textContent).toContain('Stable paragraph.');
      setCompleted(true);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    }
  );

  it.each(['a < 3', '\\<details', '`<details`', '```html\n<details'])(
    'preserves literal HTML-like content %s during streaming',
    async (content) => {
      mount(() => createComponent(MarkdownRenderer, { content, forceStreaming: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
      expect(container?.textContent).toContain(content === 'a < 3' ? 'a < 3' : '<details');
    }
  );

  it('keeps explicitly escaped HTML visible while the tag is incomplete', async () => {
    mount(() =>
      createComponent(MarkdownRenderer, {
        content: 'Literal <details',
        forceStreaming: true,
        escapeHtml: true,
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).toBe('Literal <details\n');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });

  it('holds unfinished inline code at the start of an ordered-list item', async () => {
    const [content, setContent] = createSignal('1. `npm run test');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('`npm run test');

    setContent(`${content()}\``);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('ol li code')?.textContent).toBe('npm run test');
  });

  it('reveals an unmatched backtick suffix when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    mount(() =>
      createComponent(MarkdownRenderer, {
        content: 'Malformed `inline content',
        get cacheByContent() {
          return completed();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expectStreamingIndicator(container!);

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('code')).toBeNull();
    expect(container?.textContent).toContain('Malformed `inline content');
  });

  it('reserves an unfinished Markdown link until its destination closes', async () => {
    const [content, setContent] = createSignal(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation'
    );
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.textContent).not.toContain('the renderer implementation');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation]'
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).not.toContain('the renderer implementation');
    expectStreamingIndicator(container!);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/'
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).not.toContain('src/webview/components/');

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test'
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.textContent).toContain('the renderer implementation');
    expect(container?.textContent).not.toContain('its test');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(1);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test suite](src/webview/components/MarkdownRenderer.test.ts)'
    );
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[1]?.textContent).toBe('its test suite');
    expect(links?.[1]?.getAttribute('href')).toBe(
      '/repo/src/webview/components/MarkdownRenderer.test.ts'
    );
  });

  it('reserves trailing bare paths and linkifies them when complete', async () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
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
      mount(() =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        })
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();

      expect(container?.textContent).not.toContain(testCase.partial);
      expectStreamingIndicator(container!);
      expect(container?.querySelector('a.file-path-link')).toBeNull();

      setContent(`Bare path: ${testCase.complete} `);
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      flushSolid();

      const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
      expect(link?.textContent).toBe(testCase.complete);
      expect(link?.getAttribute('href')).toBe(testCase.title);
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

      unmount();
      container!.innerHTML = '';
    }
  });

  it('holds a trailing bare URL until a streaming boundary arrives', async () => {
    const [content, setContent] = createSignal('Docs: https://example.test/reference/Mark');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('https://example.test/reference/Mark');
    expect(container?.querySelector('a[href^="https://example.test"]')).toBeNull();

    setContent('Docs: https://example.test/reference/Markdown ');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(
      container?.querySelector<HTMLAnchorElement>('a[href^="https://example.test"]')?.href
    ).toBe('https://example.test/reference/Markdown');
  });

  it('holds a trailing bare filename once its extension starts', async () => {
    const [content, setContent] = createSignal('File: MarkdownRenderer.t');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('MarkdownRenderer.t');
    expect(container?.querySelector('a.file-path-link')).toBeNull();

    setContent('File: MarkdownRenderer.tsx ');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('a.file-path-link')?.textContent).toBe('MarkdownRenderer.tsx');
  });

  it('links Windows paths while reserving a trailing URL', async () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    const content =
      'Windows: `C:\\work\\project\\App.tsx` and [open it](C:\\work\\project\\App.tsx)\n\nURL: https://example.test/folder/App';

    mount(() => MarkdownRenderer({ content }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[0]?.textContent).toBe('C:\\work\\project\\App.tsx');
    expect(links?.[0]?.dataset.file).toBe(JSON.stringify({ path: 'C:/work/project/App.tsx' }));
    expect(links?.[1]?.textContent).toBe('open it');
    expect(links?.[1]?.dataset.file).toBe(JSON.stringify({ path: 'C:/work/project/App.tsx' }));
    expect(container?.textContent).not.toContain('https://example.test/folder/App');
    expectStreamingIndicator(container!);
  });

  it('does not hold escaped backticks or content inside a streaming fence', async () => {
    const content = [
      'An escaped \\`backtick remains visible.',
      '',
      '```ts',
      'const path = `src/webview/components/Markdown',
    ].join('\n');

    mount(() => MarkdownRenderer({ content }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.textContent).toContain('An escaped `backtick remains visible.');
    expect(container?.textContent).toContain('src/webview/components/Markdown');
    expect(container?.querySelector('.interactive-result-code-block')).not.toBeNull();
  });

  it('shows unmatched inline code when the response is already complete', async () => {
    mount(() => MarkdownRenderer({ content: 'Malformed `inline content', cacheByContent: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(container?.textContent).toContain('Malformed `inline content');
  });

  it('linkifies mixed-text file references when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content =
      '- Core protocol: `src/shared/protocol.ts` - shared contracts\n- Start with `docs/onboarding-verification.md` for onboarding.';
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      createComponent(MarkdownRenderer, {
        content,
        get cacheByContent() {
          return completed();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    const streamingLinks = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(streamingLinks).toHaveLength(2);
    expect(streamingLinks?.[0]?.textContent).toBe('src/shared/protocol.ts');
    expect(streamingLinks?.[1]?.textContent).toBe('docs/onboarding-verification.md');

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[0]?.textContent).toBe('src/shared/protocol.ts');
    expect(links?.[0]?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
    expect(links?.[1]?.textContent).toBe('docs/onboarding-verification.md');
    expect(links?.[1]?.getAttribute('href')).toBe('/repo/docs/onboarding-verification.md');
    expect(container?.querySelectorAll('.file-path-icon')).toHaveLength(2);
    expect(links?.[0]).toBe(streamingLinks?.[0]);
    expect(links?.[1]).toBe(streamingLinks?.[1]);
  });

  it('tracks tail block type without restyling stable content on every text append', async () => {
    const [content, setContent] = createSignal('Stable paragraph.\n\nLive paragraph.');
    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        cacheByContent: false,
      })
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    flushSolid();
    const stable = container!.querySelector<HTMLElement>('[data-markdown-segment="stable"]')!;
    const first = stable.firstElementChild;
    expect(stable.dataset.markdownTailTag).toBe('p');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(stable, { attributes: true, attributeFilter: ['data-markdown-tail-tag'] });
    flushSolid();
    try {
      setContent('Stable paragraph.\n\nLive paragraph. More text.');
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      flushSolid();
      expect(stable.firstElementChild).toBe(first);
      expect(mutations).toHaveLength(0);
      for (const [tail, tag] of [
        ['- A list item', 'ul'],
        ['1. An ordered item', 'ol'],
        ['# Heading', 'h1'],
      ]) {
        setContent(`Stable paragraph.\n\n${tail}`);
        flushSolid();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        flushSolid();
        expect(stable.dataset.markdownTailTag).toBe(tag);
      }
      setContent('');
      flushSolid();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      flushSolid();
      expect(stable.dataset.markdownTailTag).toBe('');
    } finally {
      observer.disconnect();
    }
  });

  it('preserves stable markdown DOM when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content = 'Stable paragraph.\n\nReview `src/shared/protocol.ts`.';
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      createComponent(MarkdownRenderer, {
        content,
        get cacheByContent() {
          return completed();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const stableSegment = container?.querySelector<HTMLElement>('[data-markdown-segment="stable"]');
    const stableParagraph = stableSegment?.firstElementChild;
    const streamingLink = container?.querySelector('a.file-path-link');
    expect(stableParagraph?.textContent).toBe('Stable paragraph.');
    expect(streamingLink?.textContent).toBe('src/shared/protocol.ts');

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expect(stableSegment?.firstElementChild).toBe(stableParagraph);
    expect(stableSegment?.style.display).toBe('contents');
    expect(container?.querySelector('a.file-path-link')).toBe(streamingLink);
  });

  it('does not revert final rendering when completion briefly regresses', async () => {
    const [completed, setCompleted] = createSignal(false);
    const content = 'Stable paragraph.\n\nReview `src/shared/protocol.ts`.';
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      createComponent(MarkdownRenderer, {
        content,
        get cacheByContent() {
          return completed();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    const streamingLink = container?.querySelector('a.file-path-link');
    expect(streamingLink?.textContent).toBe('src/shared/protocol.ts');

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    const finalLink = container?.querySelector('a.file-path-link');
    expect(finalLink).toBe(streamingLink);

    setCompleted(false);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('a.file-path-link')).toBe(finalLink);

    setCompleted(true);
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();
    expect(container?.querySelector('a.file-path-link')).toBe(finalLink);
  });

  it('returns to pending rendering when an explicit live buffer follows finalization', async () => {
    const [content, setContent] = createSignal('Final response.');
    const [forceStreaming, setForceStreaming] = createSignal(false);

    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
        cacheByContent: true,
        get forceStreaming() {
          return forceStreaming();
        },
      })
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    setForceStreaming(true);
    flushSolid();
    setContent('Files: `src/webview/components/MarkdownRenderer');
    flushSolid();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('MarkdownRenderer');
    expect(container?.querySelector('a.file-path-link')).toBeNull();
  });

  it('canonicalizes explicit path labels containing inline-code backticks', () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      MarkdownRenderer({
        content: '[`src/shared/protocol.ts`](./src/shared/protocol.ts)',
        cacheByContent: true,
      })
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('protocol.ts');
    expect(link?.textContent).not.toContain('`');
    expect(link?.querySelector('code')).toBeNull();
    expect(link?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
  });

  it('renders the target session file formats as isolated canonical links', () => {
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    const content = [
      '- Type declaration: [`src/webview/global.d.ts`](src/webview/global.d.ts) - browser globals',
      '- Main readme: [`README.md`](README.md) - project overview',
      '- License file: `LICENSE` - repository license',
      '- Git ignore rules → **`.gitignore`**',
      '- Docker image recipe: [`scripts/opencode-compatibility/Dockerfile`](scripts/opencode-compatibility/Dockerfile)',
      '- Main stylesheet: [`src/webview/index.css`](src/webview/index.css)',
    ].join('\n');

    mount(() => MarkdownRenderer({ content, cacheByContent: true }));

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
    applyState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );

    mount(() =>
      MarkdownRenderer({
        content: 'Type declaration: \\`src/webview/global.d.ts\\` - browser globals',
        cacheByContent: true,
      })
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('src/webview/global.d.ts');
    expect(container?.textContent).not.toContain('`');
    expect(link?.getAttribute('href')).toBe('/repo/src/webview/global.d.ts');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);
  });

  it('defers syntax highlighting for an unclosed streaming fence until the fence closes', async () => {
    let content = 'Before\n\n```ts\nconst value = 1;';

    mount(() => MarkdownRenderer({ content }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    let code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');

    content = 'Before\n\n```ts\nconst value = 1;\n```';
    cleanup?.();
    flushSolid();
    container!.innerHTML = '';
    mount(() => MarkdownRenderer({ content }));
    await vi.waitFor(() => expect(container?.querySelector('.hljs-keyword')).not.toBeNull());
    flushSolid();

    code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.querySelector('.hljs-number')?.textContent).toBe('1');
  });

  it('defers first-pass highlighting for completed streaming tail fences to the worker', async () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal('Stable paragraph\n\nTail');

    mount(() =>
      createComponent(MarkdownRenderer, {
        get content() {
          return content();
        },
      })
    );
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();

    setContent('Stable paragraph\n\n```ts\nconst value = 1;\n```');
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();

    let code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');

    await vi.advanceTimersByTimeAsync(100);
    flushSolid();

    code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.querySelector('.hljs-number')?.textContent).toBe('1');
  });

  it('falls back to escaped plain code when the language is unknown', async () => {
    mount(() => MarkdownRenderer({ content: '```definitely-not-a-lang\nconst value = 1;\n```' }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    flushSolid();

    const code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.classList.contains('hljs')).toBe(true);
    expect(code?.querySelector('[class^="hljs-"]')).toBeNull();
    expect(code?.textContent).toBe('const value = 1;');
  });
});
