import { createComponent, createEffect, createSignal, onCleanup } from 'solid-js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
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

beforeEach(() => {
  __resetMarkdownCachesForTests();
  setState('remoteImages', 'off');
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
  clearDirectSessionReturn();
  setState('sessions', []);
  setState('activeSessionId', null);
  setState('editorContext', {
    workspacePath: null,
    workspaceFolders: [],
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            get forceStreaming() {
              return streaming();
            },
          }),
        container!
      );

      for (const next of [initial, complete, `${complete}\n\nDone.`]) {
        setContent(next);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        expect(container!.textContent).toContain(initial);
        expect(container!.querySelector('em, strong')).toBeNull();
      }

      setStreaming(false);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
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
    // Virtual rows can measure this HTML before MarkdownRenderer's onMount hydration runs.
    expect(container!.querySelector('table')?.classList.contains('table-first-col-compact')).toBe(
      compact
    );
  });

  it.each([false, true])(
    'preserves compact file links across lightweight transitions starting at %s',
    async (initialLightweight) => {
      const [lightweight, setLightweight] = createSignal(initialLightweight);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            content:
              'See `/repo/src/webview/components/MarkdownRenderer.tsx:100-120`.\n\n' +
              'Also /repo/src/webview/components/MessageList.tsx:200-220.',
            cacheByContent: true,
            get lightweight() {
              return lightweight();
            },
          }),
        container!
      );
      for (const value of [initialLightweight, !initialLightweight, initialLightweight]) {
        setLightweight(value);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        expect(
          [...container!.querySelectorAll('a.file-path-link')].map((link) => link.textContent)
        ).toEqual(['MarkdownRenderer.tsx (line 100-120)', 'MessageList.tsx (line 200-220)']);
        expect(container!.textContent).not.toContain('/repo/src/webview/components/');
      }
    }
  );

  it('does not create inline roots after disposal before queued hydration', async () => {
    const [value, setValue] = createSignal(0);
    const mounted = vi.fn();
    const effect = vi.fn();
    const disposed = vi.fn();
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: 'SLOTMARKER',
          inlineSlots: [
            {
              marker: 'SLOTMARKER',
              render: () => {
                mounted();
                createEffect(() => effect(value()));
                onCleanup(disposed);
                return document.createElement('button');
              },
            },
          ],
        }),
      container!
    );
    expect(mounted).toHaveBeenCalledOnce();
    cleanup();
    cleanup = undefined;
    expect(disposed).toHaveBeenCalledOnce();
    const effectCount = effect.mock.calls.length;
    await Promise.resolve();
    setValue(1);
    expect(mounted).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledTimes(effectCount);
    expect(disposed).toHaveBeenCalledOnce();
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
        createEffect(() => {
          effect(marker, value());
          button.textContent = `${marker} ${value()}`;
        });
        return button;
      },
    }));
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          inlineSlots,
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);
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
    await vi.advanceTimersByTimeAsync(16);
    expect(stable.firstChild).toBe(paragraph);
    expect(stable.querySelector('button')).toBe(button);
    expect(stable.querySelector('a')).toBe(link);
    expect(link?.querySelector('.external-link-icon')).toBe(icon);
    expect(mounted.mock.calls).toEqual([['SLOTTWO']]);
    expect(disposed).not.toHaveBeenCalled();
    setContent(`${content()}\n\nLast tail`);
    await vi.advanceTimersByTimeAsync(16);
    expect(stable.firstChild).toBe(paragraph);
    expect(mounted).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
    effect.mockClear();
    setValue(1);
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
    cleanup();
    cleanup = undefined;
    expect(disposed.mock.calls).toEqual([['SLOTONE'], ['SLOTTWO']]);
  });

  it('matches full parsing after repeated safe appends and completion', async () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal('First &amp; prose\n\nTail');
    const [complete, setComplete] = createSignal(false);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          get cacheByContent() {
            return complete();
          },
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);
    const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
    const first = stable.firstChild;
    for (const paragraph of [
      'See src/example.ts and https://example.test/docs',
      'Literal &lt;script&gt; text',
    ]) {
      setContent(`${content()}\n\n${paragraph}\n\nEnd`);
      await vi.advanceTimersByTimeAsync(16);
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
    await vi.advanceTimersByTimeAsync(16);
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
    const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
    const first = stable.firstChild;
    setContent(next);
    await vi.advanceTimersByTimeAsync(16);
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
      setState('editorContext', 'workspacePath', '/old');
      const [content, setContent] = createSignal('See src/first.ts\n\nTail');
      const [disablePathLinkify, setDisablePathLinkify] = createSignal(false);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            get disablePathLinkify() {
              return disablePathLinkify();
            },
          }),
        container!
      );
      await vi.advanceTimersByTimeAsync(16);
      const stable = container!.querySelector('[data-markdown-segment="stable"]')!;
      const first = stable.firstChild;
      setContent('See src/first.ts\n\nSee src/second.ts\n\nTail');
      await vi.advanceTimersByTimeAsync(16);
      expect(stable.firstChild).toBe(first);
      if (change === 'workspace') setState('editorContext', 'workspacePath', '/new');
      else setDisablePathLinkify(true);
      setContent(`${content()}\n\nEnd`);
      await vi.advanceTimersByTimeAsync(16);
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
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          get inlineSlots() {
            return slots();
          },
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);
    setContent('SLOTMARKER\n\nMore prose\n\nTail');
    await vi.advanceTimersByTimeAsync(16);
    mounted.mockClear();
    disposed.mockClear();
    setSlots([makeSlot('new')]);
    await Promise.resolve();
    expect(mounted.mock.calls).toEqual([['new']]);
    expect(disposed.mock.calls).toEqual([['old']]);
    expect(container!.querySelector('button')?.textContent).toBe('new');
    setContent('Replacement **markdown**\n\nTail');
    await vi.advanceTimersByTimeAsync(16);
    expect(disposed.mock.calls).toEqual([['old'], ['new']]);
    expect(container!.querySelector('button')).toBeNull();
  });

  it('does not hydrate a replacement tail after disposal between a frame and its microtask', async () => {
    vi.useFakeTimers();
    const mounted = vi.fn(() => document.createElement('button'));
    const [content, setContent] = createSignal('Initial');
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          inlineSlots: [{ marker: 'SLOTMARKER', render: mounted }],
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);
    setContent('SLOTMARKER');
    vi.advanceTimersByTime(16);
    expect(container!.textContent).toContain('SLOTMARKER');
    cleanup();
    cleanup = undefined;
    await Promise.resolve();
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
      cleanup = render(
        () => createComponent(MarkdownRenderer, { content: math, forceStreaming: true }),
        container!
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

      expect(container?.querySelectorAll('.katex')).toHaveLength(1);
      expect(container?.querySelector('.katex-error')).toBeNull();
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    }
  );

  it('keeps streamed math whole across blank lines and split closing delimiters', async () => {
    vi.useFakeTimers();
    const prefix = 'Stable paragraph.\n\n';
    const [content, setContent] = createSignal(`${prefix}$$x^2`);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        }),
      container!
    );
    await vi.advanceTimersByTimeAsync(16);
    const stableParagraph = container?.querySelector('p');

    for (const suffix of ['', '\n\n', 'y^2', '$']) {
      setContent(content() + suffix);
      await vi.advanceTimersByTimeAsync(16);
      expect(container?.querySelector('.katex')).toBeNull();
      expect(container?.querySelector('p')).toBe(stableParagraph);
      expectStreamingIndicator(container!);
      expect(container?.textContent).not.toContain('$$');
    }
    setContent(`${content()}$`);
    await vi.advanceTimersByTimeAsync(16);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container?.querySelector('annotation')?.textContent).toBe('x^2\n\ny^2');

    setContent(`${content()}\n\nFollowing paragraph.`);
    await vi.advanceTimersByTimeAsync(16);
    expect(container?.querySelectorAll('.katex-display')).toHaveLength(1);
    const settledMath = container?.querySelector('.katex');
    setContent(`${content()} More text.`);
    await vi.advanceTimersByTimeAsync(16);
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            forceStreaming: true,
          }),
        container!
      );

      for (const chunk of chunks) {
        setContent(content() + chunk);
        await vi.advanceTimersByTimeAsync(16);
        expect(container?.querySelector('.katex')).toBeNull();
        expectStreamingIndicator(container!);
        expect(container?.textContent).not.toContain('$');
      }

      setContent(content() + closer);
      await vi.advanceTimersByTimeAsync(16);
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
    cleanup = render(
      () => createComponent(MarkdownRenderer, { content, forceStreaming: true }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
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
    await vi.advanceTimersByTimeAsync(16);
    expectStreamingIndicator(container!);

    setCompleted(true);
    await vi.advanceTimersByTimeAsync(16);
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

  it('rejects oversized decoded Mermaid source before hydration work', async () => {
    const root = document.createElement('div');
    root.innerHTML = `<div class="mermaid-diagram" data-mermaid-source="${encodeURIComponent('A'.repeat(100_001))}"><div class="mermaid-diagram-status">Rendering diagram...</div><div hidden class="mermaid-diagram-fallback">source</div></div>`;

    await hydrateMermaidDiagramsForTests(root);

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

  it('owns the Mermaid portal, focus and host state only while its preview is open', async () => {
    setTheme('dark');
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
    const expandButton = () => root.querySelector<HTMLButtonElement>('[data-mermaid-expand]')!;
    await vi.waitFor(() => expect(expandButton()).not.toBeNull());
    expect(Array.from(document.body.children)).toEqual(bodyChildren);

    const openPreview = async () => {
      expandButton().focus();
      expandButton().click();
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
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expectClosed();

    (await openPreview()).click();
    expectClosed();

    await openPreview();
    setTheme('light');
    expect(document.querySelector('.mermaid-preview-overlay')).toBeNull();
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);
    await vi.waitFor(() => expect(expandButton()).not.toBeNull());

    // Keep the return target mounted when the entire Markdown instance is disposed.
    outsideButton.focus();
    expandButton().click();
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close diagram preview');
    cleanup();
    cleanup = undefined;
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
    expect(document.activeElement).toBe(outsideButton);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    outsideButton.dispatchEvent(escape);
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
    cleanup = render(
      () => MarkdownRenderer({ content: '```mermaid\ngraph TD\n  A --> B\n```' }),
      container!
    );
    await vi.waitFor(() =>
      expect(container?.querySelector('.mermaid-diagram-output > svg path')).not.toBeNull()
    );

    const output = container?.querySelector('.mermaid-diagram-output');
    expect(output?.querySelector('script, foreignObject')).toBeNull();
    expect(output?.querySelector('svg')?.hasAttribute('onload')).toBe(false);

    container
      ?.querySelector<HTMLButtonElement>('button[data-mermaid-expand]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            cacheByContent: false,
          }),
        container!
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
        await new Promise((resolve) => requestAnimationFrame(resolve));
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

    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            'Safe <strong>text</strong><script>alert(1)</script><img src="https://example.test/x.png" onerror="alert(1)" /> [Docs](https://opencode.ai) [Bad](javascript:alert(1))',
        }),
      container!
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

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://opencode.ai' },
    });
  });

  it.each(['Docs', '**Docs**', '`Docs`', 'Docs &amp; examples'])(
    'shows the URL in a custom tooltip after 400 ms for %s',
    async (label) => {
      vi.useFakeTimers();
      const href = 'https://example.test/docs?one=1&two=2';
      cleanup = render(
        () =>
          MarkdownRenderer({ content: `[${label}](${href} "Old title")`, cacheByContent: true }),
        container!
      );
      const link = container!.querySelector('a')!;
      expect(link.hasAttribute('title')).toBe(false);
      link.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(399);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const tooltip = document.querySelector('[role="tooltip"]')!;
      expect(tooltip.textContent).toBe(href);
      expect(tooltip.classList.contains('themed-tooltip')).toBe(true);
      expect(link.getAttribute('aria-describedby')).toBe(tooltip.id);
      link.dispatchEvent(new MouseEvent('mouseleave'));
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
  );

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
    setState('editorContext', 'workspacePath', '/repo');
    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);
    const link = container!.querySelector('a')!;
    expect(link.hasAttribute('title')).toBe(false);
    link.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(399);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(expected);
    link.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('uses a custom tooltip for session-reference links too', async () => {
    vi.useFakeTimers();
    setState('sessions', [
      {
        id: 'ses_reference123',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Reference session',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    cleanup = render(
      () => MarkdownRenderer({ content: 'Open session:ses_reference123', cacheByContent: true }),
      container!
    );
    const link = container!.querySelector('a')!;
    expect(link.hasAttribute('title')).toBe(false);
    link.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(399);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Open session ses_reference123'
    );
  });

  it('does not add URL tooltips to URL labels or unsafe links', async () => {
    vi.useFakeTimers();
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            'https://example.test/docs [https://example.test/docs](https://example.test/docs) ' +
            '[Unsafe](javascript:alert) [http://example.test/docs](http://example.test/docs)',
          cacheByContent: true,
        }),
      container!
    );
    for (const link of container!.querySelectorAll('a')) {
      expect(link.hasAttribute('aria-describedby')).toBe(false);
      link.dispatchEvent(new MouseEvent('mouseenter'));
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('cancels a link tooltip on early leave and hides it on click without changing navigation', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(
      () =>
        MarkdownRenderer({ content: '[Docs](https://example.test/docs)', cacheByContent: true }),
      container!
    );
    const link = container!.querySelector('a')!;
    link.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(200);
    link.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    link.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    dispatchAnchorClick(link);
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            cacheByContent: true,
          }),
        container!
      );
      const oldLink = container!.querySelector('a')!;
      oldLink.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(delay);
      setContent('[New docs](https://example.test/new)');
      await vi.advanceTimersByTimeAsync(16);
      expect(oldLink.hasAttribute('aria-describedby')).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      container!.querySelector('a')!.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(400);
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
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    expect(container!.querySelector('a')).toBeNull();
    setContent('See [Docs](https://example.test/docs)\n\n[More](https://example.test/more)');
    await vi.advanceTimersByTimeAsync(16);
    const links = container!.querySelectorAll('a');
    expect(links).toHaveLength(2);
    for (const link of links) {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        link.getAttribute('href')
      );
      link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
  });

  it.each([
    ['`claude-agent-acp`', 'code'],
    ['**claude-agent-acp**', 'strong'],
    ['*claude-agent-acp*', 'em'],
    ['**`claude-agent-acp`**', 'strong code'],
  ])('preserves formatting when decorating a link labeled %s', (label, selector) => {
    cleanup = render(
      () => MarkdownRenderer({ content: `[${label}](https://example.test)` }),
      container!
    );

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
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '[![Visual Studio Marketplace](https://badgen.net/vs-marketplace/v/koltyakov.varro?color=0078d4)](https://marketplace.visualstudio.com/items?itemName=koltyakov.varro) [![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](https://github.com/koltyakov/varro/blob/main/LICENSE)',
        }),
      container!
    );

    expect(container?.querySelector('img:not(.external-link-icon)')).toBeNull();
    const link = Array.from(container?.querySelectorAll('a') || []).find((item) =>
      item.textContent?.includes('Visual Studio Marketplace')
    );
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(link?.textContent).toContain('Visual Studio Marketplace');
  });

  it('renders remote content images as text without resource elements', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '![Screenshot](https://example.test/screenshot.png) [![Linked screenshot](https://example.test/linked-screenshot.png)](https://example.test/details)',
        }),
      container!
    );

    expect(container?.querySelector('.markdown-image-frame')).toBeNull();
    expect(container?.querySelector('img:not(.external-link-icon)')).toBeNull();
    expect(container?.textContent).toContain('Screenshot');
    expect(container?.textContent).toContain('Linked screenshot');
  });

  it('blocks compact remote icons, portraits, and raw images', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '![App icon](https://example.test/assets/app.png) ![Author portrait](https://example.test/people/author.jpg) <img src="https://example.test/custom.png" width="48" height="48" alt="Custom mark">',
        }),
      container!
    );

    expect(container?.querySelectorAll('.markdown-image-frame')).toHaveLength(0);
    expect(container?.querySelectorAll('img:not(.external-link-icon)')).toHaveLength(0);
    expect(container?.textContent).toContain('App icon');
    expect(container?.textContent).toContain('Author portrait');
  });

  it('offers click-to-load placeholders only for generated Markdown image tokens', () => {
    setState('remoteImages', 'ask');
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: [
            '![Chart](https://images.test/chart.png)',
            '<img src="https://images.test/raw.png">',
            '<span data-varro-generated data-remote-image="https%3A%2F%2Fimages.test%2Fforged.png" alt="Forged">Forged</span>',
          ].join('\n\n'),
          cacheByContent: true,
        }),
      container!
    );
    expect(container?.querySelectorAll('[data-remote-image]')).toHaveLength(1);
    expect(container?.querySelector('.remote-markdown-image-host')?.textContent).toBe(
      'images.test'
    );
    expect(container?.querySelector('[data-remote-image-load]')?.textContent).toBe('Load image');
    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toContain('Forged');
  });

  it('changes image presentation without reparsing or fetching Markdown', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '![Chart](https://images.test/chart.png)',
          cacheByContent: true,
        }),
      container!
    );
    const host = container?.querySelector('[data-remote-image]');
    expect(container?.querySelector('button')).toBeNull();
    setState('remoteImages', 'ask');
    expect(container?.querySelector('[data-remote-image]')).toBe(host);
    expect(container?.querySelector('.rendered-markdown')?.classList).toContain(
      'remote-images-enabled'
    );
    expect(container?.querySelector('[data-remote-image-load]')?.textContent).toBe('Load image');
    setState('remoteImages', 'off');
    expect(container?.querySelector('button, img')).toBeNull();
    expect(container?.textContent?.trim()).toBe('Chart');
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

    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const rawControl = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Forged copy'
    );
    expect(rawControl?.closest('[hidden]')).not.toBeNull();
    expect(rawControl?.hasAttribute('data-copy')).toBe(false);
    expect(rawControl?.hasAttribute('data-copy-text')).toBe(false);
    expect(container?.querySelector('[data-mermaid-source="graph%20TD"]')).toBeNull();
    expect(container?.querySelector('[data-file*="private"]')).toBeNull();
    expect(container?.querySelector('[data-varro-generated]')).toBeNull();

    rawControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).not.toHaveBeenCalled();

    const generatedControl = container?.querySelector<HTMLButtonElement>('button[data-copy]');
    generatedControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
        path: './src/webview/App.tsx',
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

  it.each([
    ['/other/dap/dashboard.sql#L68', '/other/dap/dashboard.sql', 68],
    ['./src/query.py#L91', './src/query.py', 91],
    ['./src/query.py#L91-L105', './src/query.py', 91, 105],
    ['./src/query.py#L91-105', './src/query.py', 91, 105],
    ['C:/work/query.py#L91', 'C:/work/query.py', 91],
    ['file:///other/dashboard.sql#L68', '/other/dashboard.sql', 68],
  ])('opens the file and line in Markdown target %s', (href, path, line, endLine?: number) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', {
      workspacePath: '/repo',
      workspaceFolders: [
        { name: 'repo', path: '/repo' },
        { name: 'other', path: '/other' },
      ],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    cleanup = render(
      () => MarkdownRenderer({ content: `[Open query](${href})`, cacheByContent: true }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.dataset.file).toBe(JSON.stringify({ path, line, endLine }));
    const absolutePath = path.replace(/^\.\//, '/repo/');
    if (!path.startsWith('C:'))
      expect(link?.getAttribute('href')).toBe(
        `${absolutePath}:${line}${endLine ? `-${endLine}` : ''}`
      );
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
      varroFilePath: absolutePath,
      webviewSection: 'varroFileLink',
    });
    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path, line, endLine, kind: 'file', requestId: expect.any(Number) },
    });
    const requestId = send.mock.calls[0]![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
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
      setState('editorContext', {
        workspacePath: primary,
        workspaceFolders: [
          { name: 'amplify', path: primary },
          { name: 'df-data-pipelines', path: sibling },
        ],
      });
      cleanup = render(
        () =>
          MarkdownRenderer({
            content: citations
              .map(({ label, path, line }) => `[\`${label}\`](${path}#L${line})`)
              .join('\n\n'),
            cacheByContent,
          }),
        container!
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
        await vi.waitFor(() =>
          expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
            `${path} (line ${line})`
          )
        );
        link.dispatchEvent(new MouseEvent('mouseleave'));
        dispatchAnchorClick(link);
        expect(send).toHaveBeenLastCalledWith({
          type: 'vscode/open',
          payload: { path, line, kind: 'file', requestId: expect.any(Number) },
        });
        const requestId = send.mock.lastCall![0].payload.requestId;
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
          })
        );
      }
    }
  );

  it('opens line fragments on raw HTML file anchors', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(
      () => MarkdownRenderer({ content: '<a href="/other/query.py#L91-L105">Open query</a>' }),
      container!
    );

    dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: '/other/query.py',
        line: 91,
        endLine: 105,
        kind: 'file',
        requestId: expect.any(Number),
      },
    });
    const requestId = send.mock.calls[0]![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
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
    cleanup = render(() => MarkdownRenderer({ content: `[Open query](${href})` }), container!);

    const link = container?.querySelector<HTMLAnchorElement>('a');
    expect(link?.hasAttribute('href')).toBe(false);
    dispatchAnchorClick(link);
    expect(send).not.toHaveBeenCalled();
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
      payload: { path: 'go.mod', line: 3, kind: 'file', requestId: expect.any(Number) },
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

  it.each([
    'perceiver_lang_io.py (line 710-744)',
    '`models/perceiver_lang_io.py:710-744`',
    '[Source](models/perceiver_lang_io.py#L710-L744)',
    '<a href="models/perceiver_lang_io.py#L710-L744">Source</a>',
  ])('preserves the relative reference and range in %s', (content) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('editorContext', 'workspacePath', '/other-workspace');
    setState('activeSessionId', 'different-session');
    setState('sessions', [
      {
        id: 'owner-session',
        projectID: 'project',
        directory: '/repo/packages/app',
        title: 'Nested session',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    cleanup = render(
      () => MarkdownRenderer({ content, sessionID: 'owner-session', cacheByContent: true }),
      container!
    );
    const link = container!.querySelector<HTMLAnchorElement>('a')!;
    expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath).toBe(
      content.startsWith('perceiver')
        ? '/repo/packages/app/perceiver_lang_io.py'
        : '/repo/packages/app/models/perceiver_lang_io.py'
    );
    dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: content.startsWith('perceiver')
          ? 'perceiver_lang_io.py'
          : 'models/perceiver_lang_io.py',
        line: 710,
        endLine: 744,
        kind: 'file',
        sessionID: 'owner-session',
        directory: '/repo/packages/app',
        requestId: expect.any(Number),
      },
    });
    const requestId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
      })
    );
  });

  it.each(['/repo', '/repo/packages/app', '/worktrees/feature', '/scratch/no-project'])(
    'uses the supplied modal session directory %s without relying on the session list',
    (directory) => {
      const send = vi.fn();
      window.__sendToExtension = send;
      setState('activeSessionId', 'other');
      setState('editorContext', 'workspacePath', '/other');
      cleanup = render(
        () =>
          MarkdownRenderer({
            content: '`app.ts`',
            sessionID: 'modal-session',
            directory,
          }),
        container!
      );
      dispatchAnchorClick(container?.querySelector<HTMLAnchorElement>('a'));
      expect(send).toHaveBeenCalledWith({
        type: 'vscode/open',
        payload: {
          path: 'app.ts',
          sessionID: 'modal-session',
          directory,
          kind: 'file',
          requestId: expect.any(Number),
        },
      });
      const requestId = send.mock.lastCall![0].payload.requestId;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'vscode/open-result', payload: { requestId, status: 'opened' } },
        })
      );
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
    setState('activeSessionId', 'other');
    setState('editorContext', 'workspacePath', '/other-workspace');
    for (const directory of ['/repo/packages/app', '/worktrees/feature', '/repo/packages/app']) {
      cleanup = render(
        () =>
          MarkdownRenderer({
            content,
            sessionID: 'owner-session',
            directory,
            cacheByContent: true,
          }),
        container!
      );
      const link = container!.querySelector<HTMLAnchorElement>('a')!;
      expect(JSON.parse(link.getAttribute('data-vscode-context') ?? '{}').varroFilePath).toBe(
        `${directory}/src/app.ts`
      );
      if (link.classList.contains('file-path-link')) {
        expect(link.getAttribute('href')).toBe(`${directory}/src/app.ts:10-12`);
        link.dispatchEvent(new MouseEvent('mouseenter'));
        await vi.advanceTimersByTimeAsync(400);
        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
          `${directory}/src/app.ts (line 10-12)`
        );
        link.dispatchEvent(new MouseEvent('mouseleave'));
      }
      cleanup();
      cleanup = undefined;
    }
    expect(sanitize).toHaveBeenCalledTimes(2);
  });

  it('preserves absolute link metadata when a session directory is supplied', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: '`/shared/src/app.ts:10-12`',
          sessionID: 'owner-session',
          directory: '/repo/packages/app',
          cacheByContent: true,
        }),
      container!
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
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content,
          sessionID: 'owner-session',
          get directory() {
            return directory();
          },
        }),
      container!
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
    await vi.waitFor(() =>
      expect(linkPaths()).toEqual([
        '/worktrees/feature/src/stable.ts',
        '/worktrees/feature/src/tail.ts',
      ])
    );
  });

  it('keeps an ambiguous link clickable after cancelling the file picker', async () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    cleanup = render(() => MarkdownRenderer({ content: '`shared.ts`' }), container!);
    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    dispatchAnchorClick(link);
    const requestId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId, status: 'cancelled' } },
      })
    );
    await Promise.resolve();
    expect(link?.classList.contains('is-unavailable')).toBe(false);
    expect(link?.hasAttribute('href')).toBe(true);
    expect(showSessionActionFeedbackMock).not.toHaveBeenCalled();
    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledTimes(2);
    const retryId = send.mock.lastCall![0].payload.requestId;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'vscode/open-result', payload: { requestId: retryId, status: 'opened' } },
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
    expect(link?.hasAttribute('title')).toBe(false);
    link?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'File not found: missing-file.ts'
      )
    );
    link?.dispatchEvent(new MouseEvent('mouseleave'));
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

  it.each([
    'a.session-reference-link',
    '.session-reference-link .link-leading-label',
    '.session-reference-link .session-reference-icon',
  ])('selects a workspace session when clicking %s in Markdown', (target) => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('activeSessionId', 'ses_origin123');
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
    expect(click.defaultPrevented).toBe(true);
    expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('ses_found123', {
      directory: '/repo',
    });
    expect(getDirectSessionReturnId('ses_found123')).toBe('ses_origin123');
    expect(send).not.toHaveBeenCalled();
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

  it('invalidates finalized multi-reference Markdown after renaming and removing sessions', async () => {
    setState(
      'sessions',
      ['first', 'second'].map((name) => ({
        id: `ses_${name}`,
        projectID: 'project-1',
        directory: '/repo',
        title: name,
        version: '1',
        time: { created: 0, updated: 0 },
      }))
    );
    const content = 'Open ses_first and session:ses_second.';
    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);
    expect(container?.querySelectorAll('a.session-reference-link')).toHaveLength(2);

    setState('sessions', 0, 'title', 'Renamed first');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container?.querySelector('[data-session-id="ses_first"]')?.textContent).toBe(
      'Renamed first'
    );
    expect(container?.querySelector('[data-session-id="ses_second"]')?.getAttribute('href')).toBe(
      '#session/ses_second'
    );

    setState('sessions', []);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container?.querySelector('a.session-reference-link')).toBeNull();
    expect(container?.textContent).toContain(content);
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

  it.each(['https://example.test/docs', 'http://localhost:3000', 'http://app.above-all.test/docs'])(
    'makes the external link %s actionable',
    (url) => {
      const send = vi.fn();
      window.__sendToExtension = send;

      cleanup = render(
        () =>
          MarkdownRenderer({
            content: `[Docs](${url}) ${url}\n\n| Component | URL |\n| --- | --- |\n| App | ${url} |`,
            cacheByContent: true,
          }),
        container!
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
      cleanup = render(
        () =>
          MarkdownRenderer({
            content: `[Docs](${url}) ${url}\n\n| URL |\n| --- |\n| ${url} |`,
            cacheByContent: true,
          }),
        container!
      );

      // VS Code's window listener forwards anchor clicks even when defaultPrevented is true.
      const hostLinkHandler = vi.fn();
      window.addEventListener('click', hostLinkHandler);
      try {
        const links = container!.querySelectorAll<HTMLAnchorElement>('a.external-link');
        expect(links).toHaveLength(3);
        for (const link of links) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true });
          link.querySelector('.link-leading-label')!.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
        expect(send.mock.calls).toEqual(
          Array.from({ length: 3 }, () => [{ type: 'vscode/open-external', payload: { url } }])
        );
        expect(hostLinkHandler).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('click', hostLinkHandler);
      }
    }
  );

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
    expect(link?.getAttribute('data-file')).toBe(JSON.stringify({ path: './src/webview/App.tsx' }));
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'Open file',
      webviewSection: 'varroFileLink',
      varroFilePath: '/repo/src/webview/App.tsx',
    });
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
    expect(link?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
    expect(link?.querySelector('.file-path-icon')).toBeInstanceOf(HTMLImageElement);
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(link?.querySelector('.link-leading-label')?.textContent).toBe('protocol.ts');
    expect(container?.querySelector('pre a.file-path-link')).toBeNull();
    expect(container?.textContent).toContain('spotlight');

    dispatchAnchorClick(link);
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: {
        path: 'src/shared/protocol.ts',
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

  it.each([
    {
      content: '`src/shared/protocol.ts`',
      label: 'protocol.ts',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: 'Review src/shared/protocol.ts.',
      label: 'protocol.ts',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '`src/shared/protocol.ts:12-15`',
      label: 'protocol.ts (line 12-15)',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '[src/shared/protocol.ts](./src/shared/protocol.ts:12)',
      label: 'protocol.ts (line 12)',
      path: '/repo/src/shared/protocol.ts',
    },
    {
      content: '`C:\\repo\\src\\App.tsx:12`',
      label: 'App.tsx (line 12)',
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
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    cleanup = render(() => MarkdownRenderer({ content, cacheByContent: true }), container!);

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
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
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
    expect(links[0]?.textContent).toBe('protocol.ts');
    expect(links[0]?.title).toBe('/repo/src/shared/protocol.ts');
  });

  it('derives native copy-path context from the target instead of untrusted HTML attributes', () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content:
            '<a href="/repo/src/safe.ts" data-vscode-context=\'{"webviewSection":"varroFileLink","varroFilePath":"/other/file.ts"}\'>Safe</a>',
          cacheByContent: true,
        }),
      container!
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
    await vi.waitFor(() => expect(container?.querySelector('.hljs-keyword')).not.toBeNull());

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
    expect(renderHighlightedCodeHtml(source, lang)).toContain('hljs-');
  });

  it.each([
    ['js', 'const value = 1;', 'hljs-keyword'],
    ['tsx', 'const node = <div />;', 'hljs-keyword'],
    ['py', 'def greet():\n    pass', 'hljs-keyword'],
    ['html', '<main>hello</main>', 'hljs-tag'],
    ['yml', 'key: value', 'hljs-attr'],
  ])('highlights language alias %s', async (lang, source, expectedClass) => {
    await requestHighlight(source, lang);
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

  it('separates finalized markdown cache entries by render options', async () => {
    await requestHighlight('const value = 1;', 'ts');
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

  it('separates code block cache entries by highlighting mode', async () => {
    await requestHighlight('const value = 1;', 'ts');
    const params = { text: 'const value = 1;', lang: 'ts' };
    expect(renderCodeBlockHtml({ ...params, disableHighlighting: true })).not.toContain(
      'hljs-keyword'
    );
    expect(renderCodeBlockHtml(params)).toContain('hljs-keyword');
  });

  it('does not cache a pending code block as a completed highlighted block', async () => {
    const params = { text: 'const pendingCacheValue = 2;', lang: 'ts' };
    expect(renderCodeBlockHtml(params)).toContain('data-highlight-lang');
    await requestHighlight(params.text, params.lang);
    const completed = renderCodeBlockHtml(params);
    expect(completed).toContain('hljs-keyword');
    expect(completed).not.toContain('data-highlight-lang');
    expect(renderCodeBlockHtml(params)).toBe(completed);
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

  it('reserves an incomplete streaming table until its delimiter row is complete', async () => {
    const [content, setContent] = createSignal('Status follows.\n\n| No.');
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

    expect(container?.textContent).toContain('Status follows.');
    expect(container?.textContent).toContain('No.');
    expect(
      container?.querySelector('.streaming-markdown-pending')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(container?.querySelector('table')).toBeNull();

    setContent('Status follows.\n\n| No. | Area | State | Lead | Action |\n|---|---|---|---');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).toContain('Action');
    expect(container?.querySelector('.streaming-markdown-pending')).not.toBeNull();
    expect(container?.querySelector('table')).toBeNull();

    setContent('Status follows.\n\n| No. | Area | State | Lead | Action |\n|---|---|---|---|---|');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('Action');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });

  it('holds the active streaming table body row until its line completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    const [content, setContent] = createSignal(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Act'
    );
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          get cacheByContent() {
            return completed();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n| Next | ' +
        'Still streaming a long description. '.repeat(30)
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container?.querySelector('tbody')?.textContent).toContain('Renderer');
    expect(container?.textContent).not.toContain('Still streaming');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent('Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('tbody')?.textContent).toContain('Renderer');
    expect(container?.querySelector('tbody')?.textContent).toContain('Active');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(
      'Status follows.\n\n| Name | State |\n| --- | --- |\n| Renderer | Active |\n| Final | Done |'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(1);

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container?.querySelector('tbody')?.textContent).toContain('Done');
  });

  it('renders a complete streaming table without trailing pipes', async () => {
    cleanup = render(
      () => MarkdownRenderer({ content: 'Status follows.\n\n| Name | State\n| --- | ---' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('State');
  });

  it('counts escaped pipes as table cell content while streaming', async () => {
    cleanup = render(
      () =>
        MarkdownRenderer({ content: 'Status follows.\n\n| Name \\| Alias | State\n| --- | ---' }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('table')).not.toBeNull();
    expect(container?.querySelector('thead')?.textContent).toContain('Name | Alias');
  });

  it('counts pipes after an even backslash run as table separators', async () => {
    cleanup = render(
      () =>
        MarkdownRenderer({
          content: 'Status follows.\n\n| Path \\\\| State | Owner\n| --- | --- | ---',
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('table')).not.toBeNull();
  });

  it('holds incomplete streaming block delimiters', async () => {
    const [content, setContent] = createSignal('Stable text.\n\n## ');
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
    expect(container?.querySelector('h2')).toBeNull();
    expect(container?.querySelector('.streaming-markdown-pending')?.textContent.trim()).toBe('##');

    setContent('Stable text.\n\n## 40. Delivery\n\n```ts\nconst ready = true;\n``');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('h2')?.textContent).toBe('40. Delivery');
    expect(container?.querySelector('code')?.textContent?.trim()).toBe('const ready = true;');
    expect(container?.querySelector('.streaming-markdown-pending')?.textContent).toBe('``');

    setContent('Stable text.\n\n## 40. Delivery\n\n```ts\nconst ready = true;\n```');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('code')?.textContent?.trim()).toBe('const ready = true;');
  });

  it('paints an active ordered-list item while it streams', async () => {
    const base = 'Scope protects attention.';
    const [content, setContent] = createSignal(`${base}\n\n6`);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          forceStreaming: true,
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.textContent).toContain('6');

    setContent(`${base}\n\n6.`);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const marker = container?.querySelector('.streaming-markdown-pending');
    expect(marker?.textContent).toBe('6.');
    expect(marker?.getAttribute('aria-hidden')).toBeNull();
    expect(marker?.classList).not.toContain('streaming-markdown-pending-hidden');

    setContent(`${base}\n\n6. A bounded task identifies`);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('ol li')?.textContent).toBe('A bounded task identifies');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

    setContent(`${base}\n\n6. A bounded task identifies\n`);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('ol li')?.textContent).toBe('A bounded task identifies');
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
    expect(tailLinks?.[0]?.getAttribute('href')).toBe('/repo/src/webview/App.tsx');
  });

  it('reserves an unclosed inline-code suffix without linking it', async () => {
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
    expect(paragraph?.textContent).not.toContain('src/webview/components/Markdown');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).not.toContain('MarkdownRenderer.test.ts');
    expect(container?.querySelector('.streaming-markdown-pending')).not.toBeNull();

    setContent('The related tests are in `src/webview/components/MarkdownRenderer.test.ts`');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
    expect(link?.textContent).toBe('MarkdownRenderer.test.ts');
    expect(link?.getAttribute('href')).toBe(
      '/repo/src/webview/components/MarkdownRenderer.test.ts'
    );
    expect(container?.textContent).not.toContain('src/webview/components/');
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            forceStreaming: true,
          }),
        container!
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

      // The pending block shows dots without painting an orphan list marker.
      const paintedItems = () =>
        Array.from(container!.querySelectorAll('li')).filter(
          (item) => !item.closest('.streaming-markdown-pending-block')
        );
      expectStreamingIndicator(container!);
      expect(container?.textContent).not.toContain('`Open as Edi');
      expect(paintedItems()).toHaveLength(pendingItems);

      setContent(`${content()}tor\` is not a model-change event.`);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(container?.querySelector('.streaming-markdown-pending-block')).toBeNull();
      expect(paintedItems()).toHaveLength(visibleItems + 1);
      expect(container?.querySelector('li:last-child code')?.textContent).toBe('Open as Editor');
    }
  );

  it.each(['- ', '* ', '-'])(
    'does not paint an empty trailing %j bullet before its content arrives',
    async (marker) => {
      const [content, setContent] = createSignal(`Two corrections:\n\n${marker}`);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            forceStreaming: true,
          }),
        container!
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

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
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(visibleItems()).toHaveLength(0);
      expectStreamingIndicator(container!);
      expect(
        container?.querySelector('[data-markdown-tail-tag]')?.getAttribute('data-markdown-tail-tag')
      ).toBe('ul');
      expect(container?.querySelector('p.streaming-markdown-pending-list')).not.toBeNull();

      setContent(`Two corrections:\n\n- \`Open as Editor\` is not a model-change event.`);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(visibleItems()).toHaveLength(1);
      expect(visibleItems()[0]?.querySelector('code')?.textContent).toBe('Open as Editor');
    }
  );

  it.each([
    { delimiter: '`', chunks: ['npm', ' run', ' test'] },
    { delimiter: '``', chunks: ['npm', ' `run`', ' test', '`'] },
  ])(
    'holds unfinished $delimiter inline code until its matching closer arrives',
    async ({ delimiter, chunks }) => {
      const prefix = 'Stable paragraph.\n\n- Passed `npm run lint`, now run ';
      const [content, setContent] = createSignal(`${prefix}${delimiter}`);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            forceStreaming: true,
          }),
        container!
      );

      for (const chunk of ['', ...chunks]) {
        setContent(content() + chunk);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        expectStreamingIndicator(container!);
        expect(Array.from(container!.querySelectorAll('code'), (code) => code.textContent)).toEqual(
          ['npm run lint']
        );
      }

      // The double-backtick case receives the first closing backtick in a separate delta.
      setContent(`${content()}\` now.`);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
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
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            content: `Stable paragraph.\n\n${tag}`,
            get cacheByContent() {
              return completed();
            },
          }),
        container!
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(container?.textContent).not.toContain(tag);
      expect(container?.textContent).toContain('Stable paragraph.');
      setCompleted(true);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    }
  );

  it.each(['a < 3', '\\<details', '`<details`', '```html\n<details'])(
    'preserves literal HTML-like content %s during streaming',
    async (content) => {
      cleanup = render(
        () => createComponent(MarkdownRenderer, { content, forceStreaming: true }),
        container!
      );
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
      expect(container?.textContent).toContain(content === 'a < 3' ? 'a < 3' : '<details');
    }
  );

  it('keeps explicitly escaped HTML visible while the tag is incomplete', async () => {
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content: 'Literal <details',
          forceStreaming: true,
          escapeHtml: true,
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).toBe('Literal <details\n');
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });

  it('holds unfinished inline code at the start of an ordered-list item', async () => {
    const [content, setContent] = createSignal('1. `npm run test');
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
    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('`npm run test');

    setContent(`${content()}\``);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('ol li code')?.textContent).toBe('npm run test');
  });

  it('reveals an unmatched backtick suffix when streaming completes', async () => {
    const [completed, setCompleted] = createSignal(false);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content: 'Malformed `inline content',
          get cacheByContent() {
            return completed();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expectStreamingIndicator(container!);

    setCompleted(true);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('code')).toBeNull();
    expect(container?.textContent).toContain('Malformed `inline content');
  });

  it('reserves an unfinished Markdown link until its destination closes', async () => {
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

    expect(container?.textContent).not.toContain('the renderer implementation');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(0);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation]'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).not.toContain('the renderer implementation');
    expectStreamingIndicator(container!);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).not.toContain('src/webview/components/');

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(container?.textContent).toContain('the renderer implementation');
    expect(container?.textContent).not.toContain('its test');
    expectStreamingIndicator(container!);
    expect(container?.querySelectorAll('a.file-path-link')).toHaveLength(1);

    setContent(
      'Explicit local links use standard Markdown syntax. Open [the renderer implementation](src/webview/components/MarkdownRenderer.tsx) or [its test suite](src/webview/components/MarkdownRenderer.test.ts)'
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const links = container?.querySelectorAll<HTMLAnchorElement>('a.file-path-link');
    expect(links).toHaveLength(2);
    expect(links?.[1]?.textContent).toBe('its test suite');
    expect(links?.[1]?.getAttribute('href')).toBe(
      '/repo/src/webview/components/MarkdownRenderer.test.ts'
    );
  });

  it('reserves trailing bare paths and linkifies them when complete', async () => {
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

      expect(container?.textContent).not.toContain(testCase.partial);
      expectStreamingIndicator(container!);
      expect(container?.querySelector('a.file-path-link')).toBeNull();

      setContent(`Bare path: ${testCase.complete} `);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

      const link = container?.querySelector<HTMLAnchorElement>('a.file-path-link');
      expect(link?.textContent).toBe('FileTypeIcon.tsx');
      expect(link?.getAttribute('href')).toBe(testCase.title);
      expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();

      cleanup();
      cleanup = undefined;
      container!.innerHTML = '';
    }
  });

  it('holds a trailing bare URL until a streaming boundary arrives', async () => {
    const [content, setContent] = createSignal('Docs: https://example.test/reference/Mark');
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

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('https://example.test/reference/Mark');
    expect(container?.querySelector('a[href^="https://example.test"]')).toBeNull();

    setContent('Docs: https://example.test/reference/Markdown ');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(
      container?.querySelector<HTMLAnchorElement>('a[href^="https://example.test"]')?.href
    ).toBe('https://example.test/reference/Markdown');
  });

  it('holds a trailing bare filename once its extension starts', async () => {
    const [content, setContent] = createSignal('File: MarkdownRenderer.t');
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

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('MarkdownRenderer.t');
    expect(container?.querySelector('a.file-path-link')).toBeNull();

    setContent('File: MarkdownRenderer.tsx ');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
    expect(container?.querySelector('a.file-path-link')?.textContent).toBe('MarkdownRenderer.tsx');
  });

  it('links Windows paths while reserving a trailing URL', async () => {
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
    expect(links?.[0]?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
    expect(links?.[1]?.textContent).toBe('onboarding-verification.md');
    expect(links?.[1]?.getAttribute('href')).toBe('/repo/docs/onboarding-verification.md');
    expect(container?.querySelectorAll('.file-path-icon')).toHaveLength(2);
    expect(links?.[0]).toBe(streamingLinks?.[0]);
    expect(links?.[1]).toBe(streamingLinks?.[1]);
  });

  it('tracks tail block type without restyling stable content on every text append', async () => {
    const [content, setContent] = createSignal('Stable paragraph.\n\nLive paragraph.');
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          cacheByContent: false,
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const stable = container!.querySelector<HTMLElement>('[data-markdown-segment="stable"]')!;
    const first = stable.firstElementChild;
    expect(stable.dataset.markdownTailTag).toBe('p');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(stable, { attributes: true, attributeFilter: ['data-markdown-tail-tag'] });
    try {
      setContent('Stable paragraph.\n\nLive paragraph. More text.');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(stable.firstElementChild).toBe(first);
      expect(mutations).toHaveLength(0);
      for (const [tail, tag] of [
        ['- A list item', 'ul'],
        ['1. An ordered item', 'ol'],
        ['# Heading', 'h1'],
      ]) {
        setContent(`Stable paragraph.\n\n${tail}`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(stable.dataset.markdownTailTag).toBe(tag);
      }
      setContent('');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(stable.dataset.markdownTailTag).toBe('');
    } finally {
      observer.disconnect();
    }
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

  it('returns to pending rendering when an explicit live buffer follows finalization', async () => {
    const [content, setContent] = createSignal('Final response.');
    const [forceStreaming, setForceStreaming] = createSignal(false);

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
          cacheByContent: true,
          get forceStreaming() {
            return forceStreaming();
          },
        }),
      container!
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    setForceStreaming(true);
    setContent('Files: `src/webview/components/MarkdownRenderer');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expectStreamingIndicator(container!);
    expect(container?.textContent).not.toContain('MarkdownRenderer');
    expect(container?.querySelector('a.file-path-link')).toBeNull();
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
    expect(link?.getAttribute('href')).toBe('/repo/src/shared/protocol.ts');
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
    expect(link?.getAttribute('href')).toBe('/repo/src/webview/global.d.ts');
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
    await vi.waitFor(() => expect(container?.querySelector('.hljs-keyword')).not.toBeNull());

    code = container?.querySelector('.interactive-result-code-block code');
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code?.querySelector('.hljs-number')?.textContent).toBe('1');
  });

  it('defers first-pass highlighting for completed streaming tail fences to the worker', async () => {
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

    await vi.advanceTimersByTimeAsync(100);

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
