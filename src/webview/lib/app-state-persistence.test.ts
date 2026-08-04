import { beforeEach, describe, expect, it } from 'vitest';
import { createAppState } from './app-state';
import { STORAGE_KEYS } from './state-storage';

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __vscodeWebviewState?: unknown }).__vscodeWebviewState;
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
    let vscodeState: Record<string, unknown> = {};
    (
      window as unknown as {
        __vscodeWebviewState: {
          getState(): Record<string, unknown>;
          setState(state: Record<string, unknown>): void;
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
});
