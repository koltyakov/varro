import { createEffect, flush } from 'solid-js';
import { render } from '@solidjs/web';
import { describe, expect, it, vi } from 'vitest';
import { createAppState } from './app-state';

describe('file diff layout mutation boundary', () => {
  it('captures the old DOM before publishing a changed preference, including updater setters', () => {
    const appState = createAppState();
    const container = document.createElement('div');
    const dispose = render(() => {
      const element = document.createElement('span');
      createEffect(appState.showFileDiffs, (enabled) => {
        element.textContent = enabled ? 'diff' : 'summary';
      });
      return element;
    }, container);
    const before: Array<{ enabled: boolean; text: string | null }> = [];
    const stop = appState.onBeforeShowFileDiffsPreferenceChange(() => {
      before.push({ enabled: appState.showFileDiffs(), text: container.textContent });
    });
    try {
      expect(appState.setShowFileDiffs(true)).toBe(true);
      expect(before).toEqual([{ enabled: false, text: 'summary' }]);
      flush();
      expect(container.textContent).toBe('diff');
      appState.setShowFileDiffs(true);
      expect(before).toHaveLength(1);
      expect(appState.setShowFileDiffs((current) => !current)).toBe(false);
      flush();
      expect(before).toEqual([
        { enabled: false, text: 'summary' },
        { enabled: true, text: 'diff' },
      ]);
      expect(container.textContent).toBe('summary');
      stop();
      appState.setShowFileDiffs(true);
      expect(before).toHaveLength(2);
    } finally {
      stop();
      dispose();
    }
  });

  it('keeps captures scoped to the app instance', () => {
    const first = createAppState();
    const second = createAppState();
    const capture = vi.fn();
    const stop = first.onBeforeShowFileDiffsPreferenceChange(capture);
    try {
      second.setShowFileDiffs(true);
      expect(capture).not.toHaveBeenCalled();
      first.setShowFileDiffs(true);
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});

describe('composer mutation ownership', () => {
  it('captures each write immediately without forcing text publication', () => {
    const app = createAppState();
    app.setInputText('draft');
    flush();
    const before = app.inputTextMutationVersion();
    app.setInputText('');
    const cleared = app.inputTextMutationVersion();
    expect(cleared).toBe(before + 1);
    expect(app.readLatestDraftText()).toBe('');
    expect(app.inputText()).toBe('draft');
    flush();
    expect(app.inputText()).toBe('');
    expect(app.inputTextMutationVersion()).toBe(cleared);
    app.setInputText('temporary');
    app.setInputText('');
    expect(app.inputTextMutationVersion()).toBe(cleared + 2);
    flush();
    expect(app.inputText()).toBe('');
  });
});
