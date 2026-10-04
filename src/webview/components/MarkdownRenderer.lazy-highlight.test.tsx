import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { MarkdownRenderer } from './MarkdownRenderer';
import { installHighlightWorker } from '../lib/highlight-worker.test-support';

beforeAll(installHighlightWorker);

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('MarkdownRenderer deferred highlighting', () => {
  it('upgrades code blocks after the syntax highlighter loads', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    cleanup = render(
      () => <MarkdownRenderer content={'```ts\nconst value = true;\n```'} cacheByContent />,
      container
    );

    expect(container.textContent).toContain('const value = true;');
    const wrapper = container.querySelector('.interactive-result-code-block');
    const code = container.querySelector('code');
    const copy = container.querySelector('button[data-copy]');
    const parse = vi.spyOn(marked, 'parse');
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    await vi.waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    });
    expect(container.querySelector('.interactive-result-code-block')).toBe(wrapper);
    expect(container.querySelector('code')).toBe(code);
    expect(container.querySelector('button[data-copy]')).toBe(copy);
    expect(parse).not.toHaveBeenCalled();
    expect(sanitize).not.toHaveBeenCalled();
    parse.mockRestore();
    sanitize.mockRestore();
    container.remove();
  });
});
