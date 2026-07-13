import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeModule from '../lib/bridge';

const { postMessage } = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('../lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof BridgeModule>();
  return {
    ...actual,
    postMessage,
  };
});

import { appStore } from '../lib/stores/app-store';
import { SessionSendOperations } from './session/session-send';

describe('SessionSendOperations', () => {
  beforeEach(() => {
    window.localStorage.clear();
    appStore.resetDefaultAppState();
    postMessage.mockClear();
  });

  afterEach(() => {
    window.localStorage.clear();
    appStore.resetDefaultAppState();
  });

  it('builds the payload from stores and clears sent composer attachments', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    appStore.setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });
    appStore.setState('droppedFiles', [
      { path: '/repo/src/file.ts', type: 'file', attachmentSequence: 1 },
    ]);
    appStore.setState('clipboardImages', [
      {
        id: 'image-1',
        url: 'blob:image-1',
        mime: 'image/png',
        filename: 'image.png',
        size: 10,
        attachmentSequence: 2,
      },
    ]);
    appStore.setState('todos', [
      { id: 'todo-1', content: 'Keep visible', status: 'completed', priority: 'high' },
    ]);

    const sendAsync = vi.fn(async () => {
      appStore.setState('messages', [
        {
          info: {
            id: 'user-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5' },
          },
          parts: [],
        },
      ]);
    });
    const resetTodoSync = vi.fn();
    const operations = new SessionSendOperations({
      createSession: vi.fn(async () => 'session-2'),
      clearPendingAbort: vi.fn(),
      resetTodoSync,
      syncSessionMcps: vi.fn(async () => {}),
      sendAsync,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      recheckSessionStatus: vi.fn(async () => {}),
      setSessionStatusEntry: vi.fn(),
      continueInterruptedSession: vi.fn(async () => {}),
    });

    await operations.sendMessage('hello');

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      parts: [
        { type: 'text', text: 'hello' },
        {
          type: 'text',
          text: '[Selection from terminal zsh]\n```text\nnpm test\n```',
        },
        { type: 'text', text: '/repo/src/file.ts' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'image.png',
          url: 'blob:image-1',
        },
      ],
    });
    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.todos).toEqual([
      { id: 'todo-1', content: 'Keep visible', status: 'completed', priority: 'high' },
    ]);
    expect(resetTodoSync).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });
});
