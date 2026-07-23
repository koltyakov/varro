import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { DiffView, getDiffLines, parseUnifiedPatch } from './DiffView';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  delete window.__sendToExtension;
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
    expect(rows).toHaveLength(3);
    expect(container?.querySelector('.diff-view-lines-content')).toBeInstanceOf(HTMLDivElement);
    const lineViewport = container?.querySelector<HTMLElement>('.diff-view-lines');
    expect(lineViewport?.getAttribute('tabindex')).toBe('0');
    expect(container?.querySelector('.diff-view-lines-unnumbered')).toBeNull();
    expect(container?.querySelector('.diff-view-line-deletion')?.textContent).toContain(
      'const oldValue = 1;'
    );
    expect(container?.querySelector('.diff-view-line-addition')?.textContent).toContain(
      'const newValue = 2;'
    );
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
  });

  it('opens the clicked file in VS Code diff view', () => {
    const send = vi.fn();
    window.__sendToExtension = send;

    cleanup = render(
      () =>
        DiffView({
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
    expect(button?.textContent).toContain('src/webview/components/Chat.tsx');

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

    button.click();

    expect(send).not.toHaveBeenCalled();
  });
});
