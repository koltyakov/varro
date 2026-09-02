import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import DOMPurify from 'dompurify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __parseMarkdownForTests,
  __resetMarkdownCachesForTests,
  getMarkdownCacheStatsForTests,
  MarkdownRenderer,
} from './MarkdownRenderer';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

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
  it('chooses a streaming placeholder without repeated full-content scans', async () => {
    const marker = 'VARROPENDINGMARKDOWNPLACEHOLDER';
    const originalIncludes = String.prototype.includes;
    const markerChecks: string[] = [];
    vi.spyOn(String.prototype, 'includes').mockImplementation(
      function (this: string, search, position) {
        if (String(search).startsWith(marker)) markerChecks.push(String(search));
        return originalIncludes.call(this, search, position);
      }
    );

    cleanup = render(
      () => MarkdownRenderer({ content: `${marker}${'X'.repeat(2_000)}[unfinished` }),
      container
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(markerChecks.length).toBeLessThanOrEqual(2);
    expect(container.textContent).toContain('[unfinished');
  });

  it('keeps adjacent placeholder-like source text intact while streaming', async () => {
    const marker = 'VARROPENDINGMARKDOWNPLACEHOLDER';
    const content = `${marker}${marker}X[unfinished`;

    cleanup = render(() => MarkdownRenderer({ content }), container);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    expect(container.textContent.trimEnd()).toBe(content);
  });

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
