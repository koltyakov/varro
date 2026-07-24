import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { DiffView, getDiffLines, parseUnifiedPatch } from './DiffView';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function makeAddedPatch(lineCount: number) {
  return [
    `@@ -0,0 +1,${lineCount} @@`,
    ...Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`),
  ].join('\n');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
  resetToolCallExpansionState();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  delete window.__sendToExtension;
  vi.restoreAllMocks();
});

describe('DiffView', () => {
  it('parses unified patch hunks with old and new line numbers', () => {
    expect(
      parseUnifiedPatch(
        [
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -3,3 +3,4 @@',
          ' same',
          '-old',
          '+new',
          '+more',
          ' end',
        ].join('\n')
      )
    ).toEqual([
      { kind: 'hunk', content: '@@ -3,3 +3,4 @@', oldLine: null, newLine: null },
      { kind: 'context', content: 'same', oldLine: 3, newLine: 3 },
      { kind: 'deletion', content: 'old', oldLine: 4, newLine: null },
      { kind: 'addition', content: 'new', oldLine: null, newLine: 4 },
      { kind: 'addition', content: 'more', oldLine: null, newLine: 5 },
      { kind: 'context', content: 'end', oldLine: 5, newLine: 6 },
    ]);
  });

  it('parses apply_patch fragments without numeric hunk ranges', () => {
    expect(parseUnifiedPatch('@@\n-old\n+new')).toEqual([
      { kind: 'hunk', content: '@@', oldLine: null, newLine: null },
      { kind: 'deletion', content: 'old', oldLine: null, newLine: null },
      { kind: 'addition', content: 'new', oldLine: null, newLine: null },
    ]);
  });

  it('shows line-by-line changes when inline rendering is enabled', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/example.ts',
              patch: '@@ -10,2 +10,2 @@\n-const oldValue = 1;\n+const newValue = 2;',
              additions: 1,
              deletions: 1,
            },
          ],
        }),
      container!
    );

    const rows = container?.querySelectorAll('.diff-view-line');
    expect(rows).toHaveLength(2);
    expect(container?.querySelector('.diff-view-lines-content')).toBeInstanceOf(HTMLDivElement);
    const lineViewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    expect(lineViewport?.getAttribute('tabindex')).toBe('0');
    expect(container?.querySelector('.diff-view-lines-unnumbered')).toBeNull();
    expect(container?.querySelector('.diff-view-line-hunk')).toBeNull();
    expect(
      Array.from(container?.querySelectorAll('.diff-view-line-number') || []).map(
        (lineNumber) => lineNumber.textContent
      )
    ).toEqual(['10', '10']);
    expect(container?.querySelector('.diff-view-line-deletion')?.textContent).toContain(
      'const oldValue = 1;'
    );
    expect(container?.querySelector('.diff-view-line-addition')?.textContent).toContain(
      'const newValue = 2;'
    );
    expect(container?.querySelector('.diff-view-line-content .hljs-keyword')?.textContent).toBe(
      'const'
    );
    expect(container?.querySelector('.diff-view-toggle')).toBeNull();
  });

  it('starts at the first change and expands and collapses multi-hunk previews', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () {
      return this.classList.contains('diff-view-scroll-anchor') ? 57 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.classList.contains('diff-view-lines') ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('diff-view-lines') ? 320 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
      return this.classList.contains('diff-view-lines') ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function () {
      return this.classList.contains('diff-view-lines') ? 600 : 0;
    });

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/example.ts',
              patch: [
                '@@ -10,2 +10,3 @@',
                ' context before',
                '+const firstChange = true;',
                ' context after',
                '@@ -40,2 +41,3 @@',
                ' later context',
                '+const laterChange = true;',
                ' final context',
              ].join('\n'),
              additions: 2,
              deletions: 0,
            },
          ],
        }),
      container!
    );
    await Promise.resolve();

    const viewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');

    expect(viewport?.scrollTop).toBe(57);
    expect(container?.querySelector('.diff-view-scroll-anchor')?.textContent).toContain(
      'const firstChange = true;'
    );
    expect(container?.querySelector('.diff-view-gap')?.textContent).toBe('28 unmodified lines');
    expect(
      container?.querySelector<HTMLElement>(
        '.diff-view-scrollbar-vertical .diff-view-scrollbar-thumb'
      )?.style.height
    ).toBe('28px');
    expect(
      container?.querySelector<HTMLElement>(
        '.diff-view-scrollbar-horizontal .diff-view-scrollbar-thumb'
      )?.style.width
    ).toBe('148px');
    const verticalScrollbarThumb = container?.querySelector<HTMLElement>(
      '.diff-view-scrollbar-vertical .diff-view-scrollbar-thumb'
    );
    const capturePointer = vi.fn();
    if (verticalScrollbarThumb) verticalScrollbarThumb.setPointerCapture = capturePointer;
    verticalScrollbarThumb?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientY: 10,
        pointerId: 7,
      })
    );
    verticalScrollbarThumb?.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientY: 30,
        pointerId: 7,
      })
    );
    verticalScrollbarThumb?.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })
    );
    expect(capturePointer).toHaveBeenCalledWith(7);
    expect(viewport?.scrollTop).toBe(157);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Expand changes in example.ts');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(false);
    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeNull();

    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeNull();

    viewport?.click();
    expect(document.activeElement).toBe(viewport);
    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeInstanceOf(
      HTMLDivElement
    );

    toggle?.click();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse changes in example.ts');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(true);

    if (viewport) viewport.scrollTop = 200;
    toggle?.click();
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(false);
    expect(viewport?.scrollTop).toBe(57);
  });

  it('preserves expansion and scroll position when the same file diff updates', async () => {
    const [diffs, setDiffs] = createSignal([
      {
        file: 'src/live.ts',
        patch: makeAddedPatch(7),
        additions: 7,
        deletions: 0,
      },
    ]);

    cleanup = render(
      () => DiffView({ showChanges: true, diffs: diffs(), stateKey: 'tool-1' }),
      container!
    );
    await Promise.resolve();

    const viewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    toggle?.click();
    if (viewport) viewport.scrollTop = 44;

    setDiffs([
      {
        file: 'src/live.ts',
        patch: makeAddedPatch(8),
        additions: 8,
        deletions: 0,
      },
    ]);
    await Promise.resolve();

    const updatedViewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    expect(updatedViewport).toBe(viewport);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(updatedViewport?.classList.contains('diff-view-lines-expanded')).toBe(true);
    expect(updatedViewport?.scrollTop).toBe(44);

    cleanup();
    cleanup = render(
      () => DiffView({ showChanges: true, diffs: diffs(), stateKey: 'tool-1' }),
      container!
    );
    await Promise.resolve();

    const remountedViewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    const remountedToggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    expect(remountedToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(remountedViewport?.classList.contains('diff-view-lines-expanded')).toBe(true);
    expect(remountedViewport?.scrollTop).toBe(44);
  });

  it('collapses empty number gutters for unnumbered patch fragments', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/example.ts',
              patch: '@@\n-old\n+new',
              additions: 1,
              deletions: 1,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelector('.diff-view-lines-unnumbered')).toBeInstanceOf(HTMLDivElement);
  });

  it('builds focused hunks from before and after content when patch text is unavailable', () => {
    const lines = getDiffLines({
      before: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n'),
      after: ['one', 'two', 'THREE', 'four', 'five', 'six', 'SEVEN', 'eight'].join('\n'),
      additions: 2,
      deletions: 2,
    });

    expect(lines.filter((line) => line.kind === 'hunk')).toHaveLength(1);
    expect(lines).toContainEqual({
      kind: 'deletion',
      content: 'three',
      oldLine: 3,
      newLine: null,
    });
    expect(lines).toContainEqual({
      kind: 'addition',
      content: 'SEVEN',
      oldLine: null,
      newLine: 7,
    });
  });

  it('keeps patch content hidden in compact mode', () => {
    cleanup = render(
      () =>
        DiffView({
          diffs: [
            {
              file: 'src/example.ts',
              patch: '@@ -1 +1 @@\n-old\n+new',
              additions: 1,
              deletions: 1,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelector('.diff-view-lines')).toBeNull();
    expect(container?.querySelector('.diff-view-filename')?.textContent).toBe('src/example.ts');
  });

  it('opens the clicked file in VS Code diff view', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/webview/components/Chat.tsx',
              before: '',
              after: '',
              additions: 109,
              deletions: 41,
            },
          ],
        }),
      container!
    );

    const button = container?.querySelector('button.diff-view-item-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(container?.querySelector('.diff-view-filename')?.textContent).toBe('Chat.tsx');
    expect(container?.querySelector('.diff-view-file-type')?.textContent).toBe('TSX');
    expect(button?.getAttribute('title')).toBe('Open full diff: src/webview/components/Chat.tsx');
    expect(button?.textContent).not.toContain('src/webview/components/Chat.tsx');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/webview/components/Chat.tsx', kind: 'file', view: 'diff' },
    });
  });

  it('renders unknown-file diffs without opening a file', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        DiffView({
          diffs: [{ additions: 1, deletions: 0 }],
        }),
      container!
    );

    const button = container?.querySelector('button.diff-view-item-button') as HTMLButtonElement;
    expect(button.textContent).toContain('Unknown file');
    expect(button.disabled).toBe(true);
    expect(container?.querySelector('.diff-lines-added')?.textContent).toBe('+1');
    expect(container?.querySelector('.diff-lines-removed')).toBeNull();

    button.click();

    expect(send).not.toHaveBeenCalled();
  });
});
