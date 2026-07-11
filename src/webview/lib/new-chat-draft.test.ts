import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editingMessage, resetMessageEditState, startEditingMessage } from './message-edit-state';
import { startNewChatDraft } from './new-chat-draft';
import { inputText, resetDefaultAppState, setInputText, setState, state } from './state';

declare global {
  interface Window {
    __sendToExtension?: (message: unknown) => void;
  }
}

describe('startNewChatDraft', () => {
  beforeEach(() => {
    resetDefaultAppState();
    resetMessageEditState();
    window.__sendToExtension = vi.fn();
  });

  afterEach(() => {
    resetMessageEditState();
    delete window.__sendToExtension;
  });

  it('preserves crafted text while clearing transient context', () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Existing session',
        version: '1',
        time: { created: 1, updated: 2 },
      },
    ]);
    setInputText('Use this history prompt [image.png]');
    setState('droppedFiles', [
      { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
    ]);
    setState('clipboardImages', [
      { id: 'image-1', url: 'blob:image', mime: 'image/png', filename: 'image.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    startNewChatDraft();

    expect(inputText()).toBe('Use this history prompt [image.png]');
    expect(state.activeSessionId).toBeNull();
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(window.__sendToExtension).toHaveBeenCalledWith({ type: 'files/clear' });
    expect(window.__sendToExtension).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('exits message edit mode without replacing the crafted text', () => {
    setState('activeSessionId', 'session-1');
    setInputText('Start a separate conversation');
    startEditingMessage('message-1', 'session-1', 'Edit old message');

    startNewChatDraft();

    expect(inputText()).toBe('Start a separate conversation');
    expect(editingMessage()).toBeNull();
  });
});
