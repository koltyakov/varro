import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import hljs from 'highlight.js/lib/core';
import { marked } from 'marked';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  MarkdownRenderer,
} from '../components/MarkdownRenderer';
import { setState } from '../lib/state';
import { installHighlightWorker } from '../lib/highlight-worker.test-support';
import { expectCachedCallBudget } from './harness';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeAll(installHighlightWorker);

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
  it('does not mount preview portal containers for completed plain markdown', async () => {
    const bodyChildren = Array.from(document.body.children);
    cleanup = render(
      () =>
        Array.from({ length: 100 }, (_, index) =>
          createComponent(MarkdownRenderer, {
            content: `Completed paragraph ${index}`,
            cacheByContent: true,
          })
        ),
      container!
    );
    await waitForAnimationFrame();

    expect(container?.querySelectorAll('.rendered-markdown')).toHaveLength(100);
    expect(container?.textContent).toContain('Completed paragraph 99');
    expect(Array.from(document.body.children)).toEqual(bodyChildren);

    cleanup();
    cleanup = undefined;
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
  });

  it('lexes only the rich block boundary as settled streaming history grows', async () => {
    const lexer = vi.spyOn(marked, 'lexer');
    const [content, setContent] = createSignal('## First\n\n**First paragraph**\n\nTail');
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
    let stable = '## First\n\n**First paragraph**';
    for (let index = 0; index < 40; index++) {
      stable += `\n\n## Section ${index}\n\n**Paragraph ${index}**`;
      setContent(`${stable}\n\nTail`);
      await waitForAnimationFrame();
    }
    expect(container?.querySelectorAll('h2')).toHaveLength(41);
    const lexedCharacters = lexer.mock.calls.reduce((total, [text]) => total + text.length, 0);
    expect(lexedCharacters).toBeLessThan(stable.length * 8);
  });

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
    await vi.waitFor(() => expect(container?.querySelector('.hljs-keyword')).not.toBeNull());

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
});
