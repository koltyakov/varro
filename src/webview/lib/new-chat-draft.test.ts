import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editingMessage, resetMessageEditState, startEditingMessage } from './message-edit-state';
import { startNewChatDraft } from './new-chat-draft';
import {
  getPersistedSelectedModel,
  getSelectedModelForSession,
  composerFocusKey,
  inputText,
  resetDefaultAppState,
  setInputText,
  setSelectedModel,
  setState,
  state,
} from './state';

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

  it('preserves the complete composer draft', () => {
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
      {
        id: 'image-2',
        url: 'blob:image-2',
        mime: 'image/png',
        filename: 'image-2.png',
        size: 20,
      },
    ]);
    setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    startNewChatDraft();

    expect(inputText()).toBe('Use this history prompt [image.png]');
    expect(state.activeSessionId).toBeNull();
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'image-1', url: 'blob:image', mime: 'image/png', filename: 'image.png', size: 10 },
      {
        id: 'image-2',
        url: 'blob:image-2',
        mime: 'image/png',
        filename: 'image-2.png',
        size: 20,
      },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
    expect(window.__sendToExtension).not.toHaveBeenCalledWith({ type: 'files/clear' });
    expect(window.__sendToExtension).not.toHaveBeenCalledWith({
      type: 'terminal-selection/clear',
    });
  });

  it('exits message edit mode without replacing the crafted text', () => {
    setState('activeSessionId', 'session-1');
    setInputText('Start a separate conversation');
    startEditingMessage('message-1', 'session-1', 'Edit old message');

    startNewChatDraft();

    expect(inputText()).toBe('Start a separate conversation');
    expect(editingMessage()).toBeNull();
  });

  it('clears message loading immediately when a slow session load is abandoned', () => {
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);

    startNewChatDraft();

    expect(state.activeSessionId).toBeNull();
    expect(state.messagesLoading).toBe(false);
  });

  it('does not reuse a blank-looking session while its messages are loading', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'New session',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);

    startNewChatDraft();

    expect(state.activeSessionId).toBeNull();
    expect(state.messagesLoading).toBe(false);
  });

  it('focuses the composer when reusing an untouched blank session', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'New session',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    const previousFocusKey = composerFocusKey();

    startNewChatDraft();

    expect(state.activeSessionId).toBe('session-1');
    expect(composerFocusKey()).toBe(previousFocusKey + 1);
  });

  it('restores global model and reasoning defaults for a new chat', () => {
    const defaultModel = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'medium',
    };
    const sessionModel = {
      providerID: 'openai',
      modelID: 'gpt-4o',
      variant: 'high',
    };
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
    setSelectedModel({ ...defaultModel });
    setSelectedModel({ ...sessionModel }, { sessionId: 'session-1', persistGlobal: false });

    startNewChatDraft();

    expect(state.activeSessionId).toBeNull();
    expect(state.selectedModel).toEqual(defaultModel);
    expect(getPersistedSelectedModel()).toEqual(defaultModel);
    expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
  });
});
