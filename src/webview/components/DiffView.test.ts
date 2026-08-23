import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';
import { collapseExpandedDiffOverlays, hasExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { xmarkIcon } from '../lib/ui-icons';
import { DiffView, getDiffLines, parseUnifiedPatch } from './DiffView';
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
let messageListShell: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function makeAddedPatch(lineCount: number) {
  return [
    `@@ -0,0 +1,${lineCount} @@`,
    ...Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`),
  ].join('\n');
}

beforeEach(() => {
  messageListShell = document.createElement('div');
  messageListShell.className = 'interactive-list-shell';
  container = document.createElement('div');
  messageListShell.appendChild(container);
  document.body.appendChild(messageListShell);
  delete window.__sendToExtension;
  resetToolCallExpansionState();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  messageListShell?.remove();
  messageListShell = null;
  delete window.__sendToExtension;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it('shows line-by-line changes when inline rendering is enabled', async () => {
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
    await vi.waitFor(() => {
      expect(container?.querySelector('.diff-view-line-content .hljs-keyword')?.textContent).toBe(
        'const'
      );
    });
    expect(container?.querySelector('.diff-view-toggle')).toBeNull();
  });

  it('starts at the first change and expands and collapses multi-hunk previews', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-scroll-anchor') ? 57 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 80 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 320 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 300 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 600 : 0;
      }
    );

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

    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    viewport?.click();
    expect(document.activeElement).toBe(viewport);
    viewport?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 20 }));

    await Promise.resolve();

    const overlay = document.querySelector<HTMLElement>('.diff-view-overlay');
    const overlayViewport = overlay?.querySelector<HTMLElement>('.diff-view-overlay-lines');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse changes in example.ts');
    expect(toggle?.title).toBe('Collapse diff preview');
    expect(overlay).toBeInstanceOf(HTMLElement);
    expect(overlay?.hasAttribute('aria-modal')).toBe(false);
    expect(overlay?.closest('.interactive-list-shell')).toBe(messageListShell);
    expect(hasExpandedDiffOverlay()).toBe(true);
    expect(overlayViewport?.scrollTop).toBe(57);
    expect(overlay?.textContent).toContain('final context');
    expect(overlay?.querySelector('.diff-view-overlay-title .diff-view-icon')).toBeInstanceOf(
      HTMLImageElement
    );
    const closeIcon = overlay?.querySelector<HTMLElement>('.diff-view-overlay-close .ui-icon');
    expect(closeIcon).toBeInstanceOf(HTMLSpanElement);
    expect(closeIcon?.style.getPropertyValue('--ui-icon-width')).toBe('10px');
    expect(closeIcon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(xmarkIcon));

    const closeButton = overlay?.querySelector<HTMLButtonElement>('.diff-view-overlay-close');
    expect(document.activeElement).toBe(closeButton);

    overlayViewport?.focus();
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    overlayViewport?.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(false);

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);
    expect(document.querySelector('.diff-view-overlay')).toBe(overlay);
    composer.remove();

    closeButton?.click();
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(viewport?.scrollTop).toBe(0);
    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(hasExpandedDiffOverlay()).toBe(false);
    expect(document.activeElement).toBe(toggle);

    toggle?.click();
    await Promise.resolve();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(document.activeElement).toBe(toggle);

    toggle?.click();
    await Promise.resolve();
    document.querySelector<HTMLElement>('.diff-view-overlay')?.click();
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(document.activeElement).toBe(toggle);
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

    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    toggle?.click();
    await Promise.resolve();
    const overlayViewport = document.querySelector<HTMLElement>('.diff-view-overlay-lines');
    if (overlayViewport) overlayViewport.scrollTop = 44;
    overlayViewport?.dispatchEvent(new Event('scroll'));

    setDiffs([
      {
        file: 'src/live.ts',
        patch: makeAddedPatch(8),
        additions: 8,
        deletions: 0,
      },
    ]);
    await Promise.resolve();

    const updatedViewport = document.querySelector<HTMLElement>('.diff-view-overlay-lines');
    expect(updatedViewport).toBe(overlayViewport);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(updatedViewport?.scrollTop).toBe(44);

    cleanup();
    cleanup = render(
      () => DiffView({ showChanges: true, diffs: diffs(), stateKey: 'tool-1' }),
      container!
    );
    await Promise.resolve();
    await Promise.resolve();

    const remountedViewport = document.querySelector<HTMLElement>('.diff-view-overlay-lines');
    const remountedToggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    expect(remountedToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(remountedViewport?.scrollTop).toBe(44);
  });

  it('does not leak undisposed computations while scrolling a keyed preview', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observers: Array<{ callback: ResizeObserverCallback; target?: Element }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: { callback: ResizeObserverCallback; target?: Element };

        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {}
      }
    );

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [{ file: 'src/live.ts', patch: makeAddedPatch(40), additions: 40, deletions: 0 }],
          stateKey: 'tool-1',
        }),
      container!
    );
    await Promise.resolve();

    const viewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    container?.querySelector<HTMLButtonElement>('.diff-view-toggle')?.click();

    // Each of these drives savePreviewState from a callback with no owner.
    for (let scrollTop = 0; scrollTop < 20; scrollTop += 1) {
      if (viewport) viewport.scrollTop = scrollTop;
      viewport?.dispatchEvent(new Event('scroll'));
      for (const observer of observers) {
        if (!observer.target) continue;
        // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
        observer.callback(
          [{ target: observer.target }] as ResizeObserverEntry[],
          {} as ResizeObserver
        );
      }
    }
    await Promise.resolve();

    const leaks = warn.mock.calls.filter(([message]) =>
      String(message).includes('never be disposed')
    );
    expect(leaks).toEqual([]);
  });

  it('coalesces repeated preview resize measurements until resizing settles', async () => {
    vi.useFakeTimers();
    let notifyResize: ResizeObserverCallback | undefined;
    let observedElement: Element | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe(element: Element) {
          observedElement = element;
        }
        disconnect() {}
      }
    );
    let clientWidthReads = 0;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('diff-view-lines')) {
          clientWidthReads += 1;
          return 300;
        }
        return 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 600 : 0;
      }
    );

    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [{ file: 'src/live.ts', patch: makeAddedPatch(4), additions: 4, deletions: 0 }],
        }),
      container!
    );
    await Promise.resolve();
    clientWidthReads = 0;

    for (let index = 0; index < 20; index += 1) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      notifyResize?.([{ target: observedElement! }] as ResizeObserverEntry[], {} as ResizeObserver);
    }

    expect(clientWidthReads).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(clientWidthReads).toBe(1);
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
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 300 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('diff-view-lines') ? 600 : 0;
      }
    );

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

    expect(container?.querySelectorAll('.diff-view-line')).toHaveLength(6);
    expect(document.querySelectorAll('.diff-view-overlay .diff-view-line')).toHaveLength(500);
  });

  it('closes an expanded preview from its header or with Escape', async () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/example.ts',
              patch: makeAddedPatch(7),
              additions: 7,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    toggle?.click();
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeInstanceOf(HTMLElement);

    document.querySelector<HTMLElement>('.diff-view-overlay-panel')?.click();
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeInstanceOf(HTMLElement);

    document.querySelector<HTMLElement>('.diff-view-overlay')?.click();
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeNull();

    toggle?.click();
    await Promise.resolve();

    document.querySelector<HTMLElement>('.diff-view-overlay-header')?.click();
    await Promise.resolve();

    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    toggle?.click();
    await Promise.resolve();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();

    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes an expanded preview through the shared collapse action', async () => {
    cleanup = render(
      () =>
        DiffView({
          showChanges: true,
          diffs: [
            {
              file: 'src/example.ts',
              patch: makeAddedPatch(7),
              additions: 7,
              deletions: 0,
            },
          ],
        }),
      container!
    );

    container?.querySelector<HTMLButtonElement>('.diff-view-toggle')?.click();
    await Promise.resolve();
    expect(document.querySelector('.diff-view-overlay')).toBeInstanceOf(HTMLElement);

    collapseExpandedDiffOverlays();
    await Promise.resolve();

    expect(document.querySelector('.diff-view-overlay')).toBeNull();
    expect(hasExpandedDiffOverlay()).toBe(false);
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

  it('expands from the code preview and opens from either filename', () => {
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
    const preview = container?.querySelector<HTMLElement>('.diff-view-lines');
    const toggle = container?.querySelector<HTMLButtonElement>('.diff-view-toggle');
    expect(header).toBeInstanceOf(HTMLDivElement);
    expect(filenameSlot).toBeInstanceOf(HTMLSpanElement);
    expect(filename).toBeInstanceOf(HTMLButtonElement);
    expect(preview).toBeInstanceOf(HTMLDivElement);
    expect(filename?.textContent).toBe('Chat.tsx');
    expect(container?.querySelector('.diff-view-icon')).toBeInstanceOf(HTMLImageElement);
    expect(filename?.getAttribute('title')).toBe('Open full diff: src/webview/components/Chat.tsx');
    expect(filename?.textContent).not.toContain('src/webview/components/Chat.tsx');

    preview?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).not.toHaveBeenCalled();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    const overlayFilename = document.querySelector<HTMLButtonElement>(
      'button.diff-view-overlay-filename'
    );
    expect(overlayFilename?.title).toBe('Open full diff: src/webview/components/Chat.tsx');

    overlayFilename?.click();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/webview/components/Chat.tsx', kind: 'file', view: 'diff' },
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    filenameSlot?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    filename?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/webview/components/Chat.tsx', kind: 'file', view: 'diff' },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
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

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const button = container?.querySelector('button.diff-view-filename') as HTMLButtonElement;
    expect(button.textContent).toContain('Unknown file');
    expect(button.disabled).toBe(true);
    expect(container?.querySelector('.diff-lines-added')?.textContent).toBe('+1');
    expect(container?.querySelector('.diff-lines-removed')).toBeNull();

    button.click();

    expect(send).not.toHaveBeenCalled();
  });
});
