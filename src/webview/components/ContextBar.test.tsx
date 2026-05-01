import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ContextBar } from './ContextBar';
import { resetDefaultAppState, setState, state } from '../lib/state';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  resetDefaultAppState();
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
  resetDefaultAppState();
  vi.restoreAllMocks();
});

describe('ContextBar', () => {
  it('hides the active-file chip when explicit file context already covers the same selection', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: { startLine: 3, endLine: 5 },
      diagnostics: [],
    });
    setState('droppedFiles', [
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    ]);

    cleanup = render(() => ContextBar(), container!);

    expect(container?.querySelector('[title="app.ts L3-5"]')).toBeNull();
    expect(container?.querySelector('[title="src/app.ts L3-5"]')).toBeInstanceOf(HTMLSpanElement);
  });

  it('shows only selection lines not already covered by explicit file context', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: { startLine: 3, endLine: 7 },
      diagnostics: [],
    });
    setState('droppedFiles', [
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    ]);

    cleanup = render(() => ContextBar(), container!);

    expect(container?.querySelector('[title="app.ts L6-7"]')).toBeInstanceOf(HTMLSpanElement);
    expect(container?.querySelector('[title="src/app.ts L3-5"]')).toBeInstanceOf(HTMLSpanElement);
  });

  it('posts a terminal clear message and clears dropped files from the state', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('terminalSelection', { text: 'pwd', terminalName: 'Terminal 1' });
    setState('droppedFiles', [
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
      },
    ]);

    cleanup = render(() => ContextBar(), container!);

    const terminalChip = container?.querySelector(
      '[title="Terminal selection from Terminal 1"]'
    ) as HTMLSpanElement | null;
    expect(terminalChip).toBeInstanceOf(HTMLSpanElement);
    terminalChip
      ?.querySelector('button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(send).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });

    const clearFilesButton = container?.querySelector(
      'button[title="Clear dropped files"]'
    ) as HTMLButtonElement | null;
    expect(clearFilesButton).toBeInstanceOf(HTMLButtonElement);
    clearFilesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.droppedFiles).toEqual([]);
    expect(container?.querySelector('[title="Clear dropped files"]')).toBeNull();
  });
});
