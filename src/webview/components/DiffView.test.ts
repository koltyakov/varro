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
  vi.unstubAllGlobals();
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

  it('keeps line numbering scoped to each mixed numeric and nonnumeric hunk', () => {
    expect(
      parseUnifiedPatch(
        [
          '@@ -2 +2 @@',
          '-numeric old',
          '+numeric new',
          '@@ function body',
          '-fragment old',
          '+fragment new',
          '@@ -9,2 +9,2 @@',
          ' context',
          '-last old',
          '+last new',
        ].join('\n')
      )
    ).toEqual([
      { kind: 'hunk', content: '@@ -2 +2 @@', oldLine: null, newLine: null },
      { kind: 'deletion', content: 'numeric old', oldLine: 2, newLine: null },
      { kind: 'addition', content: 'numeric new', oldLine: null, newLine: 2 },
      { kind: 'hunk', content: '@@ function body', oldLine: null, newLine: null },
      { kind: 'deletion', content: 'fragment old', oldLine: null, newLine: null },
      { kind: 'addition', content: 'fragment new', oldLine: null, newLine: null },
      { kind: 'hunk', content: '@@ -9,2 +9,2 @@', oldLine: null, newLine: null },
      { kind: 'context', content: 'context', oldLine: 9, newLine: 9 },
      { kind: 'deletion', content: 'last old', oldLine: 10, newLine: null },
      { kind: 'addition', content: 'last new', oldLine: null, newLine: 10 },
    ]);
  });

  it('does not turn file headers or binary markers into changed lines', () => {
    expect(parseUnifiedPatch('--- a/image.png\n+++ b/image.png')).toEqual([]);
    expect(parseUnifiedPatch('Binary files a/image.png and b/image.png differ')).toEqual([]);
    expect(
      parseUnifiedPatch(
        '@@ -1 +1 @@\n-old\n+new\n--- a/second.ts\n+++ b/second.ts\nBinary files differ'
      )
    ).toEqual([
      { kind: 'hunk', content: '@@ -1 +1 @@', oldLine: null, newLine: null },
      { kind: 'deletion', content: 'old', oldLine: 1, newLine: null },
      { kind: 'addition', content: 'new', oldLine: null, newLine: 1 },
    ]);
    expect(parseUnifiedPatch('-headerless old\n+headerless new')).toEqual([
      { kind: 'deletion', content: 'headerless old', oldLine: null, newLine: null },
      { kind: 'addition', content: 'headerless new', oldLine: null, newLine: null },
    ]);
    expect(parseUnifiedPatch('--- ordinary text\n+++ ordinary text')).toEqual([
      { kind: 'deletion', content: '-- ordinary text', oldLine: null, newLine: null },
      { kind: 'addition', content: '++ ordinary text', oldLine: null, newLine: null },
    ]);
    expect(
      parseUnifiedPatch('--- a/legitimate content\n+++ b/legitimate content', {
        headerless: true,
      })
    ).toEqual([
      { kind: 'deletion', content: '-- a/legitimate content', oldLine: null, newLine: null },
      { kind: 'addition', content: '++ b/legitimate content', oldLine: null, newLine: null },
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
    expect(lineViewport?.getAttribute('role')).toBe('region');
    expect(container?.querySelector('.diff-view-lines-content')?.getAttribute('role')).toBe('list');
    expect(container?.querySelector('.diff-view-line')?.getAttribute('role')).toBe('listitem');
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
    expect(container?.querySelector('.diff-view-line-deletion')?.getAttribute('aria-label')).toBe(
      'Deleted line 10: const oldValue = 1;'
    );
    expect(container?.querySelector('.diff-view-line-addition')?.getAttribute('aria-label')).toBe(
      'Added line 10: const newValue = 2;'
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
    const header = container?.querySelector<HTMLElement>('.diff-view-item-expandable');

    expect(viewport?.scrollTop).toBe(0);
    expect(container?.querySelectorAll('.diff-view-line')).toHaveLength(5);
    expect(container?.textContent).toContain('final context');
    expect(container?.querySelector('.diff-view-line')?.classList).toContain(
      'diff-view-line-addition'
    );
    expect(container?.querySelector('.diff-view-scroll-anchor')?.textContent).toContain(
      'const firstChange = true;'
    );
    expect(container?.querySelector('.diff-view-gap')?.textContent).toBe('28 unmodified lines');
    expect(
      container?.querySelector<HTMLElement>(
        '.diff-view-scrollbar-vertical .diff-view-scrollbar-thumb'
      )?.style.height
    ).toBe('28px');
    expect(container?.querySelector('.diff-view-scrollbar-horizontal')).toBeNull();
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
    expect(viewport?.scrollTop).toBe(100);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Expand changes in example.ts');
    expect(toggle?.title).toBe('Expand diff preview');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(false);
    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeNull();

    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeNull();

    viewport?.click();
    expect(document.activeElement).toBe(viewport);
    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    expect(container?.querySelector('.diff-view-lines-shell-scrolling')).toBeNull();

    header?.click();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse changes in example.ts');
    expect(toggle?.title).toBe('Collapse diff preview');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(true);
    expect(container?.textContent).toContain('final context');
    expect(
      container?.querySelector<HTMLElement>(
        '.diff-view-scrollbar-horizontal .diff-view-scrollbar-thumb'
      )?.style.width
    ).toBe('148px');

    toggle?.focus();
    expect(document.activeElement).toBe(toggle);
    viewport?.click();
    expect(document.activeElement).toBe(viewport);

    if (viewport) viewport.scrollTop = 200;
    toggle?.click();
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(viewport?.classList.contains('diff-view-lines-expanded')).toBe(false);
    expect(viewport?.scrollTop).toBe(0);
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

  it('shows horizontal scrolling when the preview already contains every line', async () => {
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
              patch: '@@ -1 +1 @@\n-old\n+new',
              additions: 1,
              deletions: 1,
            },
          ],
        }),
      container!
    );
    await Promise.resolve();

    expect(container?.querySelector('.diff-view-toggle')).toBeNull();
    expect(container?.querySelector('.diff-view-scrollbar-horizontal')).toBeInstanceOf(
      HTMLDivElement
    );
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

  it('falls back to snapshots when patch text is invalid or header-only', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/header-only.ts',
              patch: '--- a/src/header-only.ts\n+++ b/src/header-only.ts',
              before: 'const value = 1;',
              after: 'const value = 2;',
              additions: 1,
              deletions: 1,
            },
            {
              file: 'src/invalid.ts',
              patch: 'not a textual patch',
              before: 'before',
              after: 'after',
              additions: 1,
              deletions: 1,
            },
          ],
        }),
      container!
    );

    const files = container?.querySelectorAll('.diff-view-file');
    expect(files?.[0]?.querySelector('.diff-view-line-deletion')?.textContent).toContain(
      'const value = 1;'
    );
    expect(files?.[0]?.querySelector('.diff-view-line-addition')?.textContent).toContain(
      'const value = 2;'
    );
    expect(files?.[1]?.querySelector('.diff-view-line-deletion')?.textContent).toContain('before');
    expect(files?.[1]?.querySelector('.diff-view-line-addition')?.textContent).toContain('after');
    expect(container?.querySelector('.diff-view-preview-unavailable')).toBeNull();
  });

  it('observes a preview viewport that appears after the initial render', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        unobserve() {}
        disconnect = disconnect;
      }
    );
    const [diffs, setDiffs] = createSignal([
      {
        file: 'src/live.ts',
        patch: 'invalid patch',
        additions: 1,
        deletions: 1,
      },
    ]);
    const props = {
      showChanges: true,
      get diffs() {
        return diffs();
      },
    };

    cleanup = render(() => DiffView(props), container!);
    expect(container?.querySelector('.diff-view-lines')).toBeNull();

    setDiffs([
      {
        file: 'src/live.ts',
        patch: '@@\n-old\n+new',
        additions: 1,
        deletions: 1,
      },
    ]);
    await Promise.resolve();

    const viewport = container?.querySelector('.diff-view-lines');
    expect(viewport).toBeInstanceOf(HTMLDivElement);
    expect(observe).toHaveBeenCalledWith(viewport);
  });

  it('does not treat after-only edits as whole-file additions', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/edited.ts',
              changeKind: 'edited',
              after: 'line one\nline two',
              additions: 2,
              deletions: 0,
            },
            {
              file: 'src/added.ts',
              changeKind: 'added',
              after: 'line one\nline two',
              additions: 2,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    const files = container?.querySelectorAll('.diff-view-file');
    expect(files?.[0]?.querySelector('.diff-view-preview-unavailable')?.textContent).toContain(
      'Previous content was not provided'
    );
    expect(files?.[0]?.querySelector('.diff-view-line-addition')).toBeNull();
    expect(files?.[1]?.querySelectorAll('.diff-view-line-addition')).toHaveLength(2);
  });

  it('renders metadata-only moves as explicit compact fallbacks', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/new-name.ts',
              fromFile: 'src/old-name.ts',
              changeKind: 'moved',
              additions: 0,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelector('.diff-view-filename')?.textContent).toBe(
      'old-name.ts -> new-name.ts'
    );
    expect(container?.querySelector('.diff-view-preview-unavailable')?.textContent).toBe(
      'File moved; no text preview available.'
    );
  });

  it('mounts only a bounded line window until a large preview is expanded', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/generated.ts',
              patch: makeAddedPatch(500),
              additions: 500,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelectorAll('.diff-view-line')).toHaveLength(6);
    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    expect(toggle?.title).toBe('Expand diff preview');

    toggle?.click();

    expect(container?.querySelectorAll('.diff-view-line')).toHaveLength(500);
  });

  it('shows an explicit truncated state instead of parsing oversized patches', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/too-large.ts',
              patch: makeAddedPatch(2_100),
              additions: 2_100,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelector('.diff-view-preview-truncated')?.textContent).toContain(
      'patch exceeds 2,000 lines or 256 KB'
    );
    expect(container?.querySelector('.diff-view-lines')).toBeNull();
  });

  it('caps oversized single-line patches by UTF-8 byte size', () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/wide-line.ts',
              patch: `@@ -0,0 +1 @@\n+${'x'.repeat(300 * 1024)}`,
              additions: 1,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    expect(container?.querySelector('.diff-view-preview-truncated')?.textContent).toContain(
      'patch exceeds 2,000 lines or 256 KB'
    );
    expect(container?.querySelector('.diff-view-lines')).toBeNull();
  });

  it('shares a bounded LCS budget across snapshot-only files', () => {
    const before = Array.from({ length: 350 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 350 }, (_, index) => `new ${index}`).join('\n');

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: Array.from({ length: 5 }, (_, index) => ({
            file: `src/file-${index}.ts`,
            before,
            after,
            additions: 350,
            deletions: 350,
          })),
        }),
      container!
    );

    expect(container?.querySelectorAll('.diff-view-lines')).toHaveLength(4);
    expect(container?.querySelector('.diff-view-preview-unavailable')?.textContent).toContain(
      'too large to compare'
    );
    expect(container?.querySelectorAll('.diff-view-line')).toHaveLength(24);
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

  it('does not read patch content in compact mode', () => {
    const diff = {
      file: 'src/example.ts',
      additions: 1,
      deletions: 1,
      get patch(): string {
        throw new Error('compact mode parsed patch content');
      },
    };

    expect(() => {
      cleanup = render(() => DiffView({ diffs: [diff] }), container!);
    }).not.toThrow();
    expect(container?.querySelector('.diff-view-filename')?.textContent).toBe('src/example.ts');
  });

  it('opens a file only when its filename is clicked', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/webview/components/Chat.tsx',
              patch: makeAddedPatch(7),
              additions: 7,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    const header = container?.querySelector('.diff-view-item');
    const filenameSlot = container?.querySelector('.diff-view-filename-slot');
    const filename = container?.querySelector('button.diff-view-filename');
    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    expect(header).toBeInstanceOf(HTMLDivElement);
    expect(filenameSlot).toBeInstanceOf(HTMLSpanElement);
    expect(filename).toBeInstanceOf(HTMLButtonElement);
    expect(filename?.textContent).toBe('Chat.tsx');
    expect(container?.querySelector('.diff-view-file-type')?.textContent).toBe('TSX');
    expect(filename?.getAttribute('title')).toBe('Open full diff: src/webview/components/Chat.tsx');
    expect(filename?.textContent).not.toContain('src/webview/components/Chat.tsx');

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    filenameSlot?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).not.toHaveBeenCalled();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    filename?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/webview/components/Chat.tsx', kind: 'file', view: 'diff' },
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
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

    const button = container?.querySelector('button.diff-view-filename') as HTMLButtonElement;
    expect(button.textContent).toContain('Unknown file');
    expect(button.disabled).toBe(true);
    expect(container?.querySelector('.diff-lines-added')?.textContent).toBe('+1');
    expect(container?.querySelector('.diff-lines-removed')).toBeNull();

    button.click();

    expect(send).not.toHaveBeenCalled();
  });
});
