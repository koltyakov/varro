import { createComponent, createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHighlightWorker } from '../lib/highlight-worker.test-support';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  getMarkdownCacheStatsForTests,
  MarkdownRenderer,
  renderHighlightedCodeHtml,
} from './MarkdownRenderer';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeAll(installHighlightWorker);

beforeEach(() => {
  __resetMarkdownCachesForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MarkdownRenderer performance regressions', () => {
  it.each([
    ['a pathological TypeScript line', `${'a'.repeat(30_000)}!<&`],
    ['a long line in a small block', `${'a'.repeat(1_001)}!<&`],
    ['an oversized block of short lines', 'const value = 1;\n'.repeat(1_300)],
  ])('renders %s as intact plaintext without running the syntax parser', (_label, text) => {
    // Avoid actually blocking the test worker on the known quadratic TypeScript matcher.
    const highlight = vi.spyOn(hljs, 'highlight').mockImplementation(() => {
      throw new Error('Syntax parsing must be skipped for this input');
    });

    container.innerHTML = renderHighlightedCodeHtml(text, 'typescript');

    expect(container.textContent).toBe(text);
    expect(container.querySelector('*')).toBeNull();
    expect(highlight.mock.calls.length).toBe(0);
  });

  it('chooses a streaming placeholder without repeated full-content scans', async () => {
    const marker = 'VARROPENDINGMARKDOWNPLACEHOLDER';
    const originalIncludes = String.prototype.includes;
    const markerChecks: string[] = [];
    vi.spyOn(String.prototype, 'includes').mockImplementation(function (
      this: string,
      search,
      position
    ) {
      if (String(search).startsWith(marker)) markerChecks.push(String(search));
      return originalIncludes.call(this, search, position);
    });

    cleanup = render(
      () => MarkdownRenderer({ content: `${marker}${'X'.repeat(2_000)}[unfinished` }),
      container
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(markerChecks.length).toBeLessThanOrEqual(2);
    expect(container.textContent).not.toContain('[unfinished');
    expect(container.querySelector('.streaming-markdown-indicator')).not.toBeNull();
  });

  it('keeps adjacent placeholder-like source text intact while streaming', async () => {
    const marker = 'VARROPENDINGMARKDOWNPLACEHOLDER';
    const content = `${marker}${marker}X[unfinished`;

    cleanup = render(() => MarkdownRenderer({ content }), container);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container.textContent.trimEnd()).toBe(`${marker}${marker}X`);
    expect(container.querySelector('.streaming-markdown-indicator')).not.toBeNull();
  });

  it.each(['$$\\frac{x', 'Inline $\\frac{x', 'Docs: https://example.test/', 'File: docs/'])(
    'preserves indicator nodes without DOM mutations as hidden content grows: %s',
    async (initial) => {
      vi.useFakeTimers();
      const [content, setContent] = createSignal(initial);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            get content() {
              return content();
            },
            forceStreaming: true,
          }),
        container
      );
      await vi.advanceTimersByTimeAsync(16);
      const indicator = container.querySelector('.streaming-markdown-indicator');
      expect(indicator).not.toBeNull();
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      observer.observe(container, {
        childList: true,
        attributes: true,
        characterData: true,
        subtree: true,
      });
      try {
        for (let index = 0; index < 20; index += 1) {
          setContent(`${content()}x`);
          await vi.advanceTimersByTimeAsync(16);
          expect(container.querySelector('.streaming-markdown-indicator')).toBe(indicator);
        }
        expect(mutations).toHaveLength(0);
      } finally {
        observer.disconnect();
      }
    }
  );

  it('parses long plain streaming transcripts incrementally without populating caches', async () => {
    vi.useFakeTimers();
    const paragraphs = Array.from({ length: 80 }, (_, index) =>
      `Paragraph ${index} ${'streaming text '.repeat(12)}`.trimEnd()
    );
    const [content, setContent] = createSignal(`${paragraphs[0]}\n\nTail 0`);
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container
    );
    await vi.advanceTimersByTimeAsync(16);

    for (let index = 1; index < paragraphs.length; index += 1) {
      setContent(`${paragraphs.slice(0, index + 1).join('\n\n')}\n\nTail ${index}`);
      await vi.advanceTimersByTimeAsync(16);
    }

    const finalContentLength = content().length;
    const totalSanitizedBytes = sanitizeSpy.mock.calls.reduce(
      (total, [html]) => total + String(html).length,
      0
    );
    expect(totalSanitizedBytes).toBeLessThan(finalContentLength * 4);
    expect(container.textContent).toContain('Paragraph 79');
    expect(getMarkdownCacheStatsForTests()).toMatchObject({ bytes: 0, entries: 0 });
  });

  it('sanitizes only new stable blocks in a rich streaming response', async () => {
    vi.useFakeTimers();
    const sections = Array.from(
      { length: 40 },
      (_, index) =>
        `## Section ${index}\n\nRead [source](src/module-${index}.ts).\n\n- First item\n- **Second** item\n\n\`\`\`ts\nconst value${index} = ${index};\n\`\`\``
    );
    const [content, setContent] = createSignal(`${sections[0]}\n\nTail`);
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container
    );
    await vi.advanceTimersByTimeAsync(16);
    const firstHeading = container.querySelector('h2');
    for (let index = 1; index < sections.length; index += 1) {
      setContent(`${sections.slice(0, index + 1).join('\n\n')}\n\nTail`);
      await vi.advanceTimersByTimeAsync(16);
    }
    const sanitizedBytes = sanitize.mock.calls.reduce(
      (sum, [html]) => sum + String(html).length,
      0
    );
    expect(sanitizedBytes).toBeLessThan(content().length * 8);
    expect(container.querySelector('h2')).toBe(firstHeading);
    const expected = document.createElement('div');
    expected.innerHTML = __parseMarkdownForTests(content(), { cacheByContent: false });
    const blocks = (root: HTMLElement) =>
      [...root.querySelectorAll('h2, p, li, pre code')].map((element) => [
        element.tagName,
        element.textContent,
      ]);
    expect(blocks(container)).toEqual(blocks(expected));
  });

  it.each([
    ['display math', '$$\nf(x) = \\begin{cases}x^2 & x < 0 \\\\ x & x > 0\\end{cases}\n$$'],
    ['inline math', 'For $x < 0$ and $y > 0$, compare the two values.'],
    ['fenced code', '```html\n<div>Example</div>\n```'],
    ['inline code', 'Read `<div>` and `value > 0` literally.'],
    ['blockquotes', '> A quoted paragraph.'],
  ])('retains settled blocks with angle brackets in %s', async (_label, block) => {
    vi.useFakeTimers();
    const sections = Array.from({ length: 20 }, (_, index) => `## Section ${index}\n\n${block}`);
    const [content, setContent] = createSignal(`${sections[0]}\n\nTail`);
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container
    );
    await vi.advanceTimersByTimeAsync(16);
    const firstHeading = container.querySelector('h2');
    const firstBlock = firstHeading?.nextElementSibling;
    for (let index = 1; index < sections.length; index += 1) {
      setContent(`${sections.slice(0, index + 1).join('\n\n')}\n\nTail`);
      await vi.advanceTimersByTimeAsync(16);
      expect(container.querySelector('h2')).toBe(firstHeading);
      expect(firstHeading?.nextElementSibling).toBe(firstBlock);
    }
    const sanitizedBytes = sanitize.mock.calls.reduce(
      (sum, [html]) => sum + String(html).length,
      0
    );
    const expected = document.createElement('div');
    expected.innerHTML = __parseMarkdownForTests(content(), { cacheByContent: false });
    expect(sanitizedBytes).toBeLessThan(expected.innerHTML.length * 3);
    expect(container.textContent).toBe(expected.textContent);
  });

  it('finalizes the pending tail without reparsing settled math and prose', async () => {
    vi.useFakeTimers();
    const content = `${Array.from({ length: 30 }, (_, index) => `## Settled ${index}\n\nFor $x < ${index}$, keep this paragraph.`).join('\n\n')}\n\nTail \`unfinished`;
    const [complete, setComplete] = createSignal(false);
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          content,
          get cacheByContent() {
            return complete();
          },
        }),
      container
    );
    await vi.advanceTimersByTimeAsync(16);
    const firstHeading = container.querySelector('h2');
    expect(container.querySelector('.streaming-markdown-indicator')).not.toBeNull();
    sanitize.mockClear();
    setComplete(true);
    await vi.advanceTimersByTimeAsync(16);

    expect(container.querySelector('h2')).toBe(firstHeading);
    expect(container.querySelectorAll('.katex')).toHaveLength(30);
    expect(container.querySelector('.streaming-markdown-indicator')).toBeNull();
    expect(container.textContent).toContain('Tail `unfinished');
    expect(sanitize.mock.calls.some(([html]) => String(html).includes('Settled 0'))).toBe(false);
  });

  it.each([
    ['- First item', '- Second item'],
    ['1. First item', '2. Second item'],
    ['- First item\n- Second item', '  Continued paragraph'],
    ['> First quote', '> Continued quote'],
    ['A [reference][target].', '[target]: https://example.com'],
    ['<div>First block', 'Second block</div>'],
    ['Text <span', 'title="note">inside the span</span>'],
    ['> A [reference][target].', '[target]: https://example.com'],
    ['## Heading', 'A **bold** paragraph with `code`.'],
    ['```ts\nconst value = 1;\n```', '## Next section'],
    ['| Name | Value |\n| --- | --- |\n| one | two |', 'A following paragraph.'],
  ])('preserves full-document rendering across %s / %s', async (prefix, suffix) => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal(`${prefix}\n\nTail`);
    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container
    );
    await vi.advanceTimersByTimeAsync(16);
    setContent(`${prefix}\n\n${suffix}\n\nTail`);
    await vi.advanceTimersByTimeAsync(16);
    const expected = document.createElement('div');
    expected.innerHTML = __parseMarkdownForTests(content(), { cacheByContent: false });
    const blocks = (root: HTMLElement) =>
      [...root.querySelectorAll('h2, p, li, blockquote, pre code, a, td, th')].map((element) => [
        element.tagName,
        element.textContent,
        element.getAttribute('href'),
      ]);
    expect(blocks(container)).toEqual(blocks(expected));
  });

  it.each([false, true])(
    'keeps code-free Markdown on core changes, finalized=%s',
    async (cacheByContent) => {
      vi.useFakeTimers();
      const [lightweight, setLightweight] = createSignal(false);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            content: '## Formula\n\n$$x < y$$\n\nFinished.',
            cacheByContent,
            get lightweight() {
              return lightweight();
            },
          }),
        container
      );
      await vi.advanceTimersByTimeAsync(16);
      const equation = container.querySelector('.katex');
      expect(equation).not.toBeNull();
      const sanitize = vi.spyOn(DOMPurify, 'sanitize');
      for (const value of [true, false, true, false]) {
        setLightweight(value);
        await vi.advanceTimersByTimeAsync(16);
        expect(container.querySelector('.katex')).toBe(equation);
      }
      expect(sanitize).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['math', '## Formula\n\n$$x < y$$\n\nFinished.'],
    ['table', '| A | B |\n| - | - |\n| one | two |\n\nFinished.'],
    ['list continuation', '- First\n\n- Second'],
    ['reference', '[Reference][target]\n\n[target]: https://example.com'],
    ['HTML', '<div>First\n\nSecond</div>'],
    ['closed fence', '## Code\n\n```js\nconst value = 1;\n```\n\nFinished.'],
    ['open fence', '## Code\n\n```text\nunclosed'],
  ])(
    'keeps full-render equivalence when caching completed streaming %s',
    async (label, content) => {
      vi.useFakeTimers();
      const [complete, setComplete] = createSignal(false);
      cleanup = render(
        () =>
          createComponent(MarkdownRenderer, {
            content,
            get cacheByContent() {
              return complete();
            },
          }),
        container
      );
      await vi.advanceTimersByTimeAsync(16);
      setComplete(true);
      await vi.advanceTimersByTimeAsync(16);
      cleanup();
      cleanup = undefined;
      const sanitize = vi.spyOn(DOMPurify, 'sanitize');
      const remounted = __parseMarkdownForTests(content, { cacheByContent: true });
      if (label === 'math' || label === 'table') expect(sanitize).not.toHaveBeenCalled();
      expect(remounted).toBe(__parseMarkdownForTests(content, { cacheByContent: false }));
    }
  );

  it('reuses finalized Markdown after visiting a history page within the byte budget', () => {
    const content = Array.from(
      { length: 24 },
      (_, index) => `## Section ${index}\n\n$$x_${index} = \\frac{a+b}{c+d}$$`
    ).join('\n\n');
    const original = __parseMarkdownForTests(content, { cacheByContent: true });
    for (let index = 0; index < 200; index += 1) {
      __parseMarkdownForTests(`Earlier history paragraph ${index}.`, { cacheByContent: true });
    }
    const stats = getMarkdownCacheStatsForTests();
    expect(stats.bytes).toBeLessThan(stats.byteBudget);
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');

    expect(__parseMarkdownForTests(content, { cacheByContent: true })).toBe(original);
    expect(sanitize).not.toHaveBeenCalled();
  });

  it('enforces one total byte budget across finalized markdown caches', () => {
    for (let index = 0; index < 40; index += 1) {
      __parseMarkdownForTests(`Final ${index}\n\n${'cache payload '.repeat(6_000)}`, {
        cacheByContent: true,
      });
    }

    const stats = getMarkdownCacheStatsForTests();
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(stats.byteBudget);
  });
});
