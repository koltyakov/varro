import { beforeEach, describe, expect, it } from 'vitest';
import { createAppState } from './app-state';
import { STORAGE_KEYS } from './state-storage';
import type { UnknownRecord } from '../../shared/type-utils';

beforeEach(() => {
  window.localStorage.clear();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState;
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __initialWebviewState?: unknown }).__initialWebviewState;
});

describe('composer draft persistence', () => {
  it('restores draft text when app state is recreated', () => {
    const first = createAppState();
    first.setInputText('Keep this draft');

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this draft');
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBe(
      JSON.stringify('Keep this draft')
    );
  });

  it('restores draft text from VS Code webview state', () => {
    let vscodeState: UnknownRecord = {};
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    const first = createAppState();
    first.setInputText('Keep this VS Code draft');
    window.localStorage.clear();

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this VS Code draft');
    expect(vscodeState[STORAGE_KEYS.inputDraft]).toBe('Keep this VS Code draft');
  });

  it('persists functional updates and removes an empty draft', () => {
    const appState = createAppState();
    appState.setInputText('Keep');
    appState.setInputText((value) => `${value} this`);

    expect(createAppState().inputText()).toBe('Keep this');

    appState.setInputText('');

    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBeNull();
    expect(createAppState().inputText()).toBe('');
  });

  it('restores attached files when app state is recreated', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.inputDraftFiles,
      JSON.stringify([
        {
          path: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          type: 'file',
          lineRanges: [{ startLine: 2, endLine: 4 }],
          attachmentSequence: 3,
        },
        { path: '', relativePath: 'invalid.ts', type: 'file' },
      ])
    );

    const restored = createAppState();

    expect(restored.state.droppedFiles).toEqual([
      {
        path: '/repo/src/file.ts',
        relativePath: 'src/file.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
        attachmentSequence: 3,
      },
    ]);
  });

  it('restores pasted images from host state without stale temporary files', () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      clipboardImages: [
        {
          id: 'image-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'pasted-image-1.png',
          size: 1,
          attachmentSequence: 4,
          contextFile: {
            path: '/tmp/old-host/image.png',
            relativePath: 'image.png',
            type: 'file',
          },
        },
      ],
    };

    const restored = createAppState();

    expect(restored.state.clipboardImages).toEqual([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'pasted-image-1.png',
        size: 1,
        attachmentSequence: 4,
      },
    ]);
  });
});
