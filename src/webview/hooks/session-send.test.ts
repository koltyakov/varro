import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DroppedFile, EditorContext } from '../../shared/protocol';
import type { Provider } from '../types';
import {
  buildSessionSendBody,
  getAttachmentReference,
  getQueuedAttachmentSnapshot,
  retryMessageWithDependencies,
  sendMessageWithDependencies,
} from './session/session-send';

function provider(id: string, models: Provider['models']): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models,
  };
}

function createEditorContext(overrides?: Partial<EditorContext>): EditorContext {
  return {
    workspacePath: '/repo',
    activeFile: null,
    selection: null,
    diagnostics: [],
    ...overrides,
  };
}

function createState(overrides?: {
  selectedAgent?: string | null;
  selectedModel?: { providerID: string; modelID: string; variant?: string } | null;
  providers?: Provider[];
  providerDefaults?: Record<string, string>;
  editorContext?: EditorContext;
  terminalSelection?: { text: string; terminalName: string } | null;
  droppedFiles?: DroppedFile[];
  clipboardImages?: Array<{
    id: string;
    url: string;
    mime: string;
    filename: string;
    size: number;
  }>;
}) {
  return {
    selectedAgent: 'build',
    selectedModel: { providerID: 'openai', modelID: 'gpt-4o' },
    providers: [
      provider('openai', {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true, vision: true },
          cost: { input: 0, output: 0 },
        },
      }),
    ],
    providerDefaults: { openai: 'gpt-4o' },
    editorContext: createEditorContext(),
    terminalSelection: null,
    droppedFiles: [],
    clipboardImages: [],
    ...overrides,
  };
}

describe('session-send helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds payload with unique live selection and explicit same-file context', () => {
    const result = buildSessionSendBody(
      createState({
        editorContext: createEditorContext({
          activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
          selection: { startLine: 2, endLine: 12 },
        }),
        droppedFiles: [
          {
            path: '/repo/src/a.ts',
            relativePath: 'src/a.ts',
            type: 'file',
            lineRanges: [
              { startLine: 1, endLine: 4 },
              { startLine: 8, endLine: 10 },
              { startLine: 12, endLine: 20 },
            ],
          },
        ],
      }),
      'session-1',
      'Review overlap',
      () => true
    );

    expect(result).toMatchObject({
      body: {
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
        parts: [
          { type: 'text', text: 'Review overlap' },
          { type: 'text', text: '[Working directory: /repo]' },
          { type: 'text', text: '[Selection from src/a.ts lines 5-7, 11]' },
          { type: 'text', text: '[Selection from src/a.ts lines 1-4, 8-10, 12-20]' },
        ],
      },
      effectiveModel: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('omits current document when disabled while keeping other attachments and vision files', () => {
    const result = buildSessionSendBody(
      createState({
        editorContext: createEditorContext({
          activeFile: { path: '/repo/src/a.ts', relativePath: 'src/a.ts', language: 'typescript' },
          selection: { startLine: 4, endLine: 8 },
        }),
        droppedFiles: [
          {
            path: '/repo/src/extra.ts',
            relativePath: 'src/extra.ts',
            type: 'file',
          },
        ],
        clipboardImages: [
          {
            id: 'img-1',
            url: 'blob:1',
            mime: 'image/png',
            filename: 'img-1.png',
            size: 10,
          },
        ],
      }),
      'session-1',
      'Review this image',
      () => false
    );

    expect(result).toEqual({
      body: {
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
        parts: [
          { type: 'text', text: 'Review this image' },
          { type: 'text', text: '[Working directory: /repo]' },
          { type: 'text', text: 'src/extra.ts' },
          { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
        ],
      },
      effectiveModel: { providerID: 'openai', modelID: 'gpt-4o' },
    });
  });

  it('preserves mixed attachment send order between files and images', () => {
    const result = buildSessionSendBody(
      createState({
        editorContext: createEditorContext({ workspacePath: '/repo' }),
        droppedFiles: [
          {
            path: '/repo/src',
            relativePath: 'src',
            type: 'directory',
            attachmentSequence: 2,
          },
        ],
        clipboardImages: [
          {
            id: 'img-1',
            url: 'blob:1',
            mime: 'image/png',
            filename: 'img-1.png',
            size: 10,
            attachmentSequence: 1,
          },
        ],
      }),
      'session-1',
      'Review this image',
      () => false
    );

    expect(result?.body.parts).toEqual([
      { type: 'text', text: 'Review this image' },
      { type: 'text', text: '[Working directory: /repo]' },
      { type: 'file', mime: 'image/png', filename: 'img-1.png', url: 'blob:1' },
      { type: 'text', text: 'src/' },
    ]);
  });

  it('strips clipboard placeholders for non-vision models and applies preferred variant fallback', () => {
    const result = buildSessionSendBody(
      createState({
        selectedAgent: null,
        selectedModel: { providerID: 'openrouter', modelID: 'qwen3-coder-30b' },
        providers: [
          provider('openrouter', {
            'qwen3-coder-30b': {
              id: 'qwen3-coder-30b',
              name: 'Qwen3 Coder 30B',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              variants: {
                low: {},
                high: {},
                max: {},
              },
            },
          }),
        ],
        providerDefaults: { openrouter: 'qwen3-coder-30b' },
        editorContext: createEditorContext({ workspacePath: null }),
        clipboardImages: [
          {
            id: 'img-1',
            url: 'blob:1',
            mime: 'image/png',
            filename: 'img-1.png',
            size: 10,
          },
        ],
      }),
      'session-1',
      'See [img-1.png] later',
      () => true,
      { noReply: true }
    );

    expect(result).toEqual({
      body: {
        model: { providerID: 'openrouter', modelID: 'qwen3-coder-30b' },
        noReply: true,
        parts: [{ type: 'text', text: 'See later' }],
        variant: 'high',
      },
      effectiveModel: { providerID: 'openrouter', modelID: 'qwen3-coder-30b' },
    });
  });

  it('returns null when there is no text or attachment content to send', () => {
    const result = buildSessionSendBody(
      createState({
        selectedAgent: null,
        selectedModel: null,
        providers: [],
        providerDefaults: {},
        editorContext: createEditorContext({ workspacePath: null }),
      }),
      'session-1',
      '   ',
      () => false
    );

    expect(result).toBeNull();
  });

  it('formats attachment references for files, directories, and workspace root', () => {
    expect(getAttachmentReference({ path: '/repo/src/a.ts', type: 'file' }, '/repo')).toBe(
      'src/a.ts'
    );
    expect(getAttachmentReference({ path: '/repo/src', type: 'directory' }, '/repo')).toBe('src/');
    expect(getAttachmentReference({ path: '/repo', type: 'directory' }, '/repo')).toBe('./');
  });

  it('clones queued attachment snapshots so later composer edits do not mutate them', () => {
    const droppedFiles: DroppedFile[] = [
      {
        path: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        type: 'file',
        lineRanges: [{ startLine: 1, endLine: 3 }],
      },
    ];
    const clipboardImages = [
      {
        id: 'img-1',
        url: 'blob:1',
        mime: 'image/png',
        filename: 'img-1.png',
        size: 10,
      },
    ];
    const terminalSelection = { text: 'npm test', terminalName: 'zsh' };

    const snapshot = getQueuedAttachmentSnapshot({
      droppedFiles,
      clipboardImages,
      terminalSelection,
    });

    droppedFiles[0].relativePath = 'src/changed.ts';
    droppedFiles[0].lineRanges?.push({ startLine: 8, endLine: 9 });
    clipboardImages[0].filename = 'changed.png';
    terminalSelection.text = 'npm run build';

    expect(snapshot).toEqual({
      droppedFiles: [
        {
          path: '/repo/src/a.ts',
          relativePath: 'src/a.ts',
          type: 'file',
          attachmentSequence: undefined,
          lineRanges: [{ startLine: 1, endLine: 3 }],
        },
      ],
      clipboardImages: [
        {
          id: 'img-1',
          url: 'blob:1',
          mime: 'image/png',
          filename: 'img-1.png',
          size: 10,
          attachmentSequence: undefined,
        },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
  });

  it('creates a session when needed and sends the built payload', async () => {
    const sendAsync = vi.fn(async () => {});
    const applyEffectiveModel = vi.fn();

    await sendMessageWithDependencies(
      {
        getActiveSessionId: () => null,
        getDefaultPermissionMode: () => 'default',
        createSession: vi.fn(async () => 'session-2'),
        clearPendingAbort: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        buildSendPayload: () => ({
          body: { parts: [{ type: 'text', text: 'hello' }] },
          effectiveModel: { providerID: 'openai', modelID: 'gpt-4o' },
        }),
        requestMessageListScrollToBottom: vi.fn(),
        startLoading: vi.fn(),
        setError: vi.fn(),
        applyEffectiveModel,
        resetTodoSync: vi.fn(),
        clearTodos: vi.fn(),
        clearSessionUsageLimit: vi.fn(),
        sendAsync,
        getMessageCount: () => 1,
        clearDroppedFiles: vi.fn(),
        clearTerminalSelection: vi.fn(),
        clearClipboardImages: vi.fn(),
        postFilesClear: vi.fn(),
        postTerminalSelectionClear: vi.fn(),
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        recheckSessionStatus: vi.fn(async () => {}),
        stopLoading: vi.fn(),
      },
      'hello'
    );

    expect(applyEffectiveModel).toHaveBeenCalledWith(
      { providerID: 'openai', modelID: 'gpt-4o' },
      'session-2'
    );
    expect(sendAsync).toHaveBeenCalledWith('session-2', {
      parts: [{ type: 'text', text: 'hello' }],
    });
  });

  it('retries message sync when the immediate post-send sync leaves the active chat empty', async () => {
    vi.useFakeTimers();
    let messageCount = 0;
    const syncSessionMessages = vi.fn(async () => {
      if (syncSessionMessages.mock.calls.length >= 2) messageCount = 2;
    });
    const sendPromise = sendMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getDefaultPermissionMode: () => 'default',
        createSession: vi.fn(async () => 'session-1'),
        clearPendingAbort: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        buildSendPayload: () => ({
          body: { parts: [{ type: 'text', text: 'hello' }] },
          effectiveModel: null,
        }),
        requestMessageListScrollToBottom: vi.fn(),
        startLoading: vi.fn(),
        setError: vi.fn(),
        applyEffectiveModel: vi.fn(),
        resetTodoSync: vi.fn(),
        clearTodos: vi.fn(),
        clearSessionUsageLimit: vi.fn(),
        sendAsync: vi.fn(async () => {}),
        getMessageCount: () => messageCount,
        clearDroppedFiles: vi.fn(),
        clearTerminalSelection: vi.fn(),
        clearClipboardImages: vi.fn(),
        postFilesClear: vi.fn(),
        postTerminalSelectionClear: vi.fn(),
        syncSession: vi.fn(async () => {}),
        syncSessionMessages,
        recheckSessionStatus: vi.fn(async () => {}),
        stopLoading: vi.fn(),
        shouldClearComposerAfterSend: () => true,
      },
      'hello'
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await sendPromise;

    expect(syncSessionMessages).toHaveBeenCalledTimes(2);
  });

  it('preserves the live composer when replaying a queued attachment snapshot', async () => {
    const clearDroppedFiles = vi.fn();
    const clearTerminalSelection = vi.fn();
    const clearClipboardImages = vi.fn();
    const postFilesClear = vi.fn();
    const postTerminalSelectionClear = vi.fn();

    await sendMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getDefaultPermissionMode: () => 'default',
        createSession: vi.fn(async () => 'session-1'),
        clearPendingAbort: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        buildSendPayload: () => ({
          body: { parts: [{ type: 'text', text: 'queued' }] },
          effectiveModel: null,
        }),
        requestMessageListScrollToBottom: vi.fn(),
        startLoading: vi.fn(),
        setError: vi.fn(),
        applyEffectiveModel: vi.fn(),
        resetTodoSync: vi.fn(),
        clearTodos: vi.fn(),
        clearSessionUsageLimit: vi.fn(),
        sendAsync: vi.fn(async () => {}),
        getMessageCount: () => 1,
        clearDroppedFiles,
        clearTerminalSelection,
        clearClipboardImages,
        postFilesClear,
        postTerminalSelectionClear,
        syncSession: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        recheckSessionStatus: vi.fn(async () => {}),
        stopLoading: vi.fn(),
        shouldClearComposerAfterSend: () => false,
      },
      'queued',
      {
        preserveComposer: true,
        queuedAttachments: {
          droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        },
      }
    );

    expect(clearDroppedFiles).not.toHaveBeenCalled();
    expect(clearTerminalSelection).not.toHaveBeenCalled();
    expect(clearClipboardImages).not.toHaveBeenCalled();
    expect(postFilesClear).not.toHaveBeenCalled();
    expect(postTerminalSelectionClear).not.toHaveBeenCalled();
  });

  it('logs failed post-send syncs and stops loading when all syncs fail', async () => {
    const stopLoading = vi.fn();
    const logError = vi.fn();

    await sendMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getDefaultPermissionMode: () => 'default',
        createSession: vi.fn(async () => 'session-1'),
        clearPendingAbort: vi.fn(),
        syncSessionMcps: vi.fn(async () => {}),
        buildSendPayload: () => ({
          body: { parts: [{ type: 'text', text: 'queued' }] },
          effectiveModel: null,
        }),
        requestMessageListScrollToBottom: vi.fn(),
        startLoading: vi.fn(),
        setError: vi.fn(),
        applyEffectiveModel: vi.fn(),
        resetTodoSync: vi.fn(),
        clearTodos: vi.fn(),
        clearSessionUsageLimit: vi.fn(),
        sendAsync: vi.fn(async () => {}),
        getMessageCount: () => 1,
        clearDroppedFiles: vi.fn(),
        clearTerminalSelection: vi.fn(),
        clearClipboardImages: vi.fn(),
        postFilesClear: vi.fn(),
        postTerminalSelectionClear: vi.fn(),
        syncSession: vi.fn(async () => {
          throw new Error('syncSession failed');
        }),
        syncSessionMessages: vi.fn(async () => {
          throw new Error('syncSessionMessages failed');
        }),
        recheckSessionStatus: vi.fn(async () => {
          throw new Error('recheckSessionStatus failed');
        }),
        stopLoading,
        shouldClearComposerAfterSend: () => true,
        logError,
      },
      'queued'
    );

    expect(logError).toHaveBeenCalledTimes(3);
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('retries only assistant messages in the active session', async () => {
    const continueInterruptedSession = vi.fn(async () => {});

    await retryMessageWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        hasAssistantMessage: () => true,
        startLoading: vi.fn(),
        setError: vi.fn(),
        clearPendingAbort: vi.fn(),
        clearSessionUsageLimit: vi.fn(),
        setSessionFailed: vi.fn(),
        continueInterruptedSession,
        stopLoading: vi.fn(),
      },
      'assistant-1',
      'session-1'
    );

    expect(continueInterruptedSession).toHaveBeenCalledWith('session-1');
  });
});
