import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type * as BridgeModule from '../lib/bridge';

const {
  clearClipboardImages,
  getCurrentDocumentEnabled,
  getPermissionModeForSession,
  postMessage,
  requestMessageListScrollToBottom,
  setError,
  setSelectedModel,
  setSessionFailed,
  setSessionUsageLimit,
  setState,
  startLoading,
  state,
  stopLoading,
} = vi.hoisted(() => ({
  clearClipboardImages: vi.fn(),
  getCurrentDocumentEnabled: vi.fn(),
  getPermissionModeForSession: vi.fn(),
  postMessage: vi.fn(),
  requestMessageListScrollToBottom: vi.fn(),
  setError: vi.fn(),
  setSelectedModel: vi.fn(),
  setSessionFailed: vi.fn(),
  setSessionUsageLimit: vi.fn(),
  setState: vi.fn(),
  startLoading: vi.fn(),
  state: {
    activeSessionId: 'session-1',
    selectedAgent: null,
    selectedModel: null,
    providers: [],
    providerDefaults: {},
    editorContext: {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    },
    terminalSelection: null,
    droppedFiles: [],
    clipboardImages: [],
    messages: [],
  },
  stopLoading: vi.fn(),
}));

vi.mock('../lib/bridge', async () => {
  const actual = (await vi.importActual('../lib/bridge')) as MockedObject<typeof BridgeModule>;
  return {
    ...actual,
    postMessage,
  };
});

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    clearClipboardImages,
    getCurrentDocumentEnabled,
    getPermissionModeForSession,
    requestMessageListScrollToBottom,
    setError,
    setSelectedModel,
    setSessionFailed,
    setSessionUsageLimit,
    setState,
    startLoading,
    state,
    stopLoading,
  };
});

import { SessionSendOperations } from './session/session-send';

describe('SessionSendOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.activeSessionId = 'session-1';
    state.selectedAgent = null;
    state.selectedModel = null;
    state.providers = [];
    state.providerDefaults = {};
    state.editorContext = {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    };
    state.terminalSelection = null;
    state.droppedFiles = [];
    state.clipboardImages = [];
    state.messages = [] as Array<{
      info: { id: string; sessionID: string; role: string };
      parts: unknown[];
    }>;
    getPermissionModeForSession.mockReturnValue('default');
    getCurrentDocumentEnabled.mockReturnValue(false);
  });

  it('builds and sends payloads from shared state', async () => {
    const sendAsync = vi.fn(async () => {});
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
      continueInterruptedSession: vi.fn(async () => {}),
    });

    await operations.sendMessage('hello');

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(resetTodoSync).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith('todos', []);
    expect(postMessage).toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('retries assistant messages from shared state', async () => {
    state.messages = [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
        },
        parts: [],
      },
    ];

    const continueInterruptedSession = vi.fn(async () => {});
    const operations = new SessionSendOperations({
      createSession: vi.fn(async () => 'session-2'),
      clearPendingAbort: vi.fn(),
      resetTodoSync: vi.fn(),
      syncSessionMcps: vi.fn(async () => {}),
      sendAsync: vi.fn(async () => {}),
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      recheckSessionStatus: vi.fn(async () => {}),
      continueInterruptedSession,
    });

    await operations.retryMessage('assistant-1');

    expect(continueInterruptedSession).toHaveBeenCalledWith('session-1');
  });
});
