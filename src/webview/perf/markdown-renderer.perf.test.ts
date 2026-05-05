import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import hljs from 'highlight.js/lib/core';
import { marked } from 'marked';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  MarkdownRenderer,
} from '../components/MarkdownRenderer';
import { setState } from '../lib/state';
import { expectCachedCallBudget } from './harness';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createLongMarkdownDocument() {
  return Array.from({ length: 250 }, (_, index) => {
    return [
      `## Section ${index}`,
      '',
      `This is a long markdown paragraph for section ${index} that exercises parsing and sanitization work.`,
      '',
      '```ts',
      `const value${index} = ${index};`,
      `console.log(value${index});`,
      '```',
    ].join('\n');
  }).join('\n\n');
}

describe('MarkdownRenderer perf guards', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    __resetMarkdownCachesForTests();
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
    __resetMarkdownCachesForTests();
    vi.restoreAllMocks();
  });

  it('reuses cached finalized markdown on identical parses', () => {
    const content = `${createLongMarkdownDocument()}\n\nCache key: markdown-perf-finalized`;
    const parseSpy = vi.spyOn(marked, 'parse');

    const { firstValue: firstHtml, secondValue: secondHtml } = expectCachedCallBudget({
      label: 'finalized markdown parse cache',
      run: () => __parseMarkdownForTests(content, { cacheByContent: true }),
    });

    expect(secondHtml).toBe(firstHtml);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses highlighted code blocks when streaming appends extend only the tail', async () => {
    const highlightSpy = vi.spyOn(hljs, 'highlight');
    const [content, setContent] = createSignal('```ts\nconst value = 1;\n```\nTail');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    await waitForAnimationFrame();

    expect(highlightSpy).toHaveBeenCalledTimes(1);

    setContent('```ts\nconst value = 1;\n```\nTail extended with more streamed text');
    await waitForAnimationFrame();

    expect(highlightSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reparse a completed fenced code block when only tail text streams', async () => {
    const parseSpy = vi.spyOn(marked, 'parse');
    const [content, setContent] = createSignal('```ts\nconst value = 1;\n```\nTail');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    await waitForAnimationFrame();
    parseSpy.mockClear();

    setContent('```ts\nconst value = 1;\n```\nTail extended with more streamed text');
    await waitForAnimationFrame();

    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledWith('Tail extended with more streamed text');
  });

  it('skips table and copy-button hydration scans for plain streaming markdown', async () => {
    const querySelectorAllSpy = vi.spyOn(Element.prototype, 'querySelectorAll');
    const [content, setContent] = createSignal('Plain streaming response');

    cleanup = render(
      () =>
        createComponent(MarkdownRenderer, {
          get content() {
            return content();
          },
        }),
      container!
    );
    await waitForAnimationFrame();
    querySelectorAllSpy.mockClear();

    setContent('Plain streaming response with more text and no rich blocks');
    await waitForAnimationFrame();
    await Promise.resolve();

    const selectors = querySelectorAllSpy.mock.calls.map(([selector]) => selector);
    expect(selectors).not.toContain('table');
    expect(selectors).not.toContain('button[data-copy]');
  });
});
