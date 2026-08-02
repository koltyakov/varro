import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { MarkdownRenderer } from './MarkdownRenderer';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('MarkdownRenderer deferred highlighting', () => {
  it('upgrades code blocks after the syntax highlighter loads', async () => {
    const container = document.createElement('div');
    cleanup = render(
      () => <MarkdownRenderer content={'```ts\nconst value = true;\n```'} cacheByContent />,
      container
    );

    expect(container.textContent).toContain('const value = true;');
    await vi.waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    });
  });
});
