import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editingMessage, resetMessageEditState, startEditingMessage } from './message-edit-state';
import { newChatDraftKey, startNewChatDraft } from './new-chat-draft';
import { getPersistedLastOpenedView } from './state-view-persistence';
import {
  getPersistedSelectedAgent,
  getPersistedSelectedModel,
  getSelectedAgentForSession,
  getSelectedModelForSession,
  composerFocusKey,
  inputText,
  resetDefaultAppState,
  setInputText,
  setSelectedModel,
  setSelectedAgent,
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
    flushSolid();
    resetMessageEditState();
    flushSolid();
    window.__sendToExtension = vi.fn();
  });

  afterEach(() => {
    resetMessageEditState();
    flushSolid();
    delete window.__sendToExtension;
  });

  it('publishes a fresh draft key even when already in an empty new chat', () => {
    const before = newChatDraftKey();
    startNewChatDraft();
    flushSolid();
    const first = newChatDraftKey();
    expect(first).toBeGreaterThan(before);
    expect(state.activeSessionId).toBeNull();
    startNewChatDraft();
    flushSolid();
    expect(newChatDraftKey()).toBeGreaterThan(first);
    expect(state.activeSessionId).toBeNull();
  });

  it('remembers the new chat instead of the session it just left', () => {
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(getPersistedLastOpenedView()?.type).toBe('new-session');
  });

  it('preserves the complete composer draft', () => {
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Existing session',
          version: '1',
          time: { created: 1, updated: 2 },
        },
      ])
    );
    flushSolid();
    setInputText('Use this history prompt [image.png]');
    flushSolid();
    setState(
      storePath('droppedFiles', [
        { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
      ])
    );
    flushSolid();
    setState(
      storePath('clipboardImages', [
        { id: 'image-1', url: 'blob:image', mime: 'image/png', filename: 'image.png', size: 10 },
        {
          id: 'image-2',
          url: 'blob:image-2',
          mime: 'image/png',
          filename: 'image-2.png',
          size: 20,
        },
      ])
    );
    flushSolid();
    setState(storePath('terminalSelection', { text: 'npm test', terminalName: 'zsh' }));
    flushSolid();

    startNewChatDraft();
    flushSolid();

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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setInputText('Start a separate conversation');
    flushSolid();
    startEditingMessage('message-1', 'session-1', 'Edit old message');
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(inputText()).toBe('Start a separate conversation');
    expect(editingMessage()).toBeNull();
  });

  it.each(['ask', 'plan', 'custom'])(
    'remembers %s without changing the previous session',
    (agent) => {
      setState(
        storePath('agents', [
          { name: agent, mode: 'primary', builtIn: false, permission: {}, tools: {} },
          { name: 'build', mode: 'primary', builtIn: true, permission: {}, tools: {} },
        ])
      );
      flushSolid();
      setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      setSelectedAgent(agent, { sessionId: 'session-1' });
      flushSolid();

      startNewChatDraft();
      flushSolid();

      expect(state.activeSessionId).toBeNull();
      expect(state.selectedAgent).toBe(agent);
      expect(getSelectedAgentForSession('session-1')).toBe(agent);
      expect(getPersistedSelectedAgent()).toBe(agent);
    }
  );

  it('restores the last explicit choice instead of a loaded session agent', () => {
    setState(
      storePath('agents', [
        { name: 'custom', mode: 'primary', builtIn: false, permission: {}, tools: {} },
        { name: 'build', mode: 'primary', builtIn: true, permission: {}, tools: {} },
      ])
    );
    flushSolid();
    setSelectedAgent('custom');
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setSelectedAgent('build', { sessionId: 'session-1', persistGlobal: false });
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.selectedAgent).toBe('custom');
    expect(getSelectedAgentForSession('session-1')).toBe('build');
    expect(getPersistedSelectedAgent()).toBe('custom');
  });

  it('falls back without overwriting an unavailable saved agent', () => {
    setState(
      storePath('agents', [
        { name: 'build', mode: 'primary', builtIn: true, permission: {}, tools: {} },
      ])
    );
    flushSolid();
    setSelectedAgent('custom');
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.selectedAgent).toBe('build');
    expect(getPersistedSelectedAgent()).toBe('custom');
  });

  it('clears message loading immediately when a slow session load is abandoned', () => {
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(storePath('messagesLoading', true));
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(state.messagesLoading).toBe(false);
  });

  it('detaches an active transcript before clearing it after the next paint', () => {
    vi.useFakeTimers();
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(
      storePath('messages', [
        {
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [],
        },
      ])
    );
    flushSolid();

    try {
      startNewChatDraft();
      flushSolid();

      expect(state.activeSessionId).toBeNull();
      expect(state.messages).toHaveLength(1);
      expect(frameCallbacks).toHaveLength(1);

      frameCallbacks[0]!(0);
      vi.runAllTimers();
      flushSolid();

      expect(state.messages).toEqual([]);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not clear a session selected before deferred draft cleanup', () => {
    vi.useFakeTimers();
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(
      storePath('messages', [
        {
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [],
        },
      ])
    );
    flushSolid();

    try {
      startNewChatDraft();
      flushSolid();
      setState(storePath('activeSessionId', 'session-2'));
      flushSolid();
      setState(
        storePath('messages', [
          {
            info: {
              id: 'message-2',
              sessionID: 'session-2',
              role: 'user',
              time: { created: 2 },
              agent: 'build',
              model: { providerID: 'openai', modelID: 'gpt-5' },
            },
            parts: [],
          },
        ])
      );
      flushSolid();

      frameCallbacks[0]!(0);
      vi.runAllTimers();
      flushSolid();

      expect(state.messages.map((message) => message.info.id)).toEqual(['message-2']);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not reuse a blank-looking session while its messages are loading', () => {
    setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'New session',
          version: '1',
          time: { created: 1, updated: 1 },
        },
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(storePath('messagesLoading', true));
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(state.messagesLoading).toBe(false);
  });

  it('focuses the composer and remembers the agent when reusing an untouched blank session', () => {
    setState(
      storePath('agents', [
        { name: 'ask', mode: 'primary', builtIn: false, permission: {}, tools: {} },
        { name: 'build', mode: 'primary', builtIn: true, permission: {}, tools: {} },
      ])
    );
    flushSolid();
    setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'New session',
          version: '1',
          time: { created: 1, updated: 1 },
        },
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    const previousFocusKey = composerFocusKey();

    setSelectedAgent('ask', { sessionId: 'session-1' });
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.activeSessionId).toBe('session-1');
    expect(state.selectedAgent).toBe('ask');
    expect(getSelectedAgentForSession('session-1')).toBe('ask');
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
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Existing session',
          version: '1',
          time: { created: 1, updated: 2 },
        },
      ])
    );
    flushSolid();
    setSelectedModel({ ...defaultModel });
    flushSolid();
    setSelectedModel({ ...sessionModel }, { sessionId: 'session-1', persistGlobal: false });
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(state.selectedModel).toEqual(defaultModel);
    expect(getPersistedSelectedModel()).toEqual(defaultModel);
    expect(getSelectedModelForSession('session-1')).toEqual(sessionModel);
  });
});
