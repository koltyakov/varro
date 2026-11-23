import { flush as flushSolid, flush } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '../../shared/extension-context';
import { nativePdfFixture } from '../../shared/native-pdf.test-support';
import type { EditorContext } from '../../shared/protocol';
import {
  applySessionSelectedModelsSnapshot,
  error,
  isActiveSessionWorking,
  replaceClipboardImages,
  replaceContextFiles,
  setClipboardImageContextFile,
} from '../lib/state';
import type * as BridgeModule from '../lib/bridge';
import { deferred } from '../test-fixtures';

const { postMessage } = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise send-factory integration with the bridge module. */
vi.mock('../lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof BridgeModule>();
  return {
    ...actual,
    postMessage,
  };
});

import { appStore } from '../lib/stores/app-store';
import { composerStore } from '../lib/stores/composer-store';
import { routingStore } from '../lib/stores/routing-store';
import { startNewChatDraft } from '../lib/new-chat-draft';
import { SessionSendOperations } from './session/session-send';
import { parseInlineProblem, problemReferenceMarker } from '../lib/editor-problems';

type SendAsync = ConstructorParameters<typeof SessionSendOperations>[0]['sendAsync'];

function createOperations(
  sendAsync: SendAsync,
  ensureSessionPermission?: ConstructorParameters<
    typeof SessionSendOperations
  >[0]['ensureSessionPermission'],
  overrides: Partial<ConstructorParameters<typeof SessionSendOperations>[0]> = {}
) {
  return new SessionSendOperations({
    createSession: vi.fn(async () => 'session-2'),
    ensureSessionPermission,
    clearPendingAbort: vi.fn(),
    resetTodoSync: vi.fn(),
    syncSessionMcps: vi.fn(async () => {}),
    sendAsync,
    syncSession: vi.fn(async () => {}),
    syncSessionMessages: vi.fn(async () => {}),
    recheckSessionStatus: vi.fn(async () => {}),
    setSessionStatusEntry: vi.fn(),
    getMessageCount: () => 1,
    continueInterruptedSession: vi.fn(async () => {}),
    ...overrides,
  });
}

describe('SessionSendOperations', () => {
  it('sends captured queued image/PDF capabilities without changing the displayed catalog', async () => {
    appStore.setState((draft) => {
      draft.activeSessionId = 'session-1';
      draft.providers = [
        {
          id: 'fixture',
          name: 'Fixture',
          source: 'api',
          models: {
            text: {
              id: 'text',
              name: 'Text',
              cost: { input: 0, output: 0 },
              capabilities: { vision: false, toolcall: false, input: ['text'] },
            },
          },
        },
      ];
    });
    flushSolid();
    flush();
    flushSolid();
    const catalog = appStore.state.providers;
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const selection = { providerID: 'fixture', modelID: 'text', variant: 'captured' };
    const sent = await createOperations(sendAsync).sendMessage('Describe the files', {
      selectedModel: selection,
      preserveComposer: true,
      queuedContext: {
        currentDocumentEnabled: false,
        editorContext: {
          workspacePath: null,
          activeFile: null,
          selection: null,
          diagnostics: [],
          queuedModel: {
            selection,
            capabilities: { vision: true, tools: true, pdf: true },
          },
        },
      },
      queuedAttachments: {
        clipboardImages: [
          {
            id: 'queued-image',
            filename: 'image.png',
            mime: 'image/png',
            url: 'data:image/png;base64,AA==',
            size: 1,
          },
        ],
        nativePdfs: [nativePdfFixture()],
      },
    });
    flushSolid();
    flush();
    flushSolid();
    expect(sent).toBe(true);
    expect(sendAsync).toHaveBeenCalledOnce();
    expect(sendAsync.mock.calls[0]?.[0]).toBe('session-1');
    expect(sendAsync.mock.calls[0]?.[1]).toMatchObject({
      model: { providerID: 'fixture', modelID: 'text' },
      variant: 'captured',
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'file', mime: 'image/png' }),
        expect.objectContaining({ type: 'file', mime: 'application/pdf' }),
      ]),
    });
    expect(appStore.state.providers).toBe(catalog);
    expect(appStore.state.providers[0]?.models.text?.capabilities).toMatchObject({
      vision: false,
      toolcall: false,
      input: ['text'],
    });
  });
  it('sends context-free actions without attaching or consuming any composer context', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    const diagnostic = {
      path: '/repo/index.html',
      line: 1,
      severity: 'error' as const,
      message: 'Draft diagnostic',
    };
    const editorContext: EditorContext = {
      workspacePath: '/repo',
      activeFile: { path: '/repo/index.html', relativePath: 'index.html', language: 'html' },
      selection: { startLine: 1, endLine: 1 },
      diagnostics: [diagnostic],
      editorText: {
        kind: 'dirty-buffer',
        path: '/repo/index.html',
        relativePath: 'index.html',
        language: 'html',
        range: { startLine: 1, endLine: 1 },
        text: '<h1>Draft</h1>',
        truncated: false,
      },
      extensionContexts: [
        {
          provider: 'unavailable.context',
          version: 1,
          label: 'Issue',
          placement: 'replace-document',
          data: {},
        },
      ],
    };
    appStore.setState(
      storePath('droppedFiles', [
        { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('clipboardImages', [
        {
          id: 'draft-image',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'draft.png',
          size: 1,
        },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('nativePdfs', [
        {
          id: 'draft-pdf',
          url: 'data:application/pdf;base64,AA==',
          mime: 'application/pdf',
          filename: 'draft.pdf',
          size: 1,
        },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('terminalSelection', { text: 'Draft terminal output', terminalName: 'zsh' })
    );
    flushSolid();
    appStore.setState(storePath('attachedDiagnostics', { diagnostics: [diagnostic], total: 1 }));
    flushSolid();
    appStore.setState(storePath('inlineProblems', [{ id: 'draft-problem', diagnostic }]));
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync);
    const text = 'Stop process 42';
    expect(
      await operations.sendMessage(text, {
        omitContext: true,
        preserveComposer: true,
        queuedContext: { editorContext, currentDocumentEnabled: true },
      })
    ).toBe(true);
    flushSolid();
    expect(sendAsync.mock.calls[0]?.[1].parts).toEqual([{ type: 'text', text }]);
    expect(appStore.state.droppedFiles).toHaveLength(1);
    expect(appStore.state.clipboardImages).toHaveLength(1);
    expect(appStore.state.nativePdfs).toHaveLength(1);
    expect(appStore.state.terminalSelection?.text).toBe('Draft terminal output');
    expect(appStore.state.attachedDiagnostics?.total).toBe(1);
    expect(appStore.state.inlineProblems).toHaveLength(1);
  });

  it('sends restored extension snapshots without a provider and reports missing uncaptured providers', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    const captured: ExtensionContext = {
      provider: 'uninstalled.context',
      version: 4,
      label: 'Saved issue',
      placement: 'replace-document',
      data: { revision: 1 },
      captured: { text: 'Original issue' },
    };
    const editorContext = {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
      extensionContexts: [captured],
    };
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync);
    expect(
      await operations.sendMessage('queued prompt', {
        queuedContext: { currentDocumentEnabled: true, editorContext },
      })
    ).toBe(true);
    flushSolid();
    expect(JSON.stringify(sendAsync.mock.calls[0]![1])).toContain('Original issue');
    sendAsync.mockClear();
    const { captured: _captured, ...uncaptured } = captured;
    expect(
      await operations.sendMessage('blocked prompt', {
        queuedContext: {
          currentDocumentEnabled: true,
          editorContext: { ...editorContext, extensionContexts: [uncaptured] },
        },
      })
    ).toBe(false);
    flushSolid();
    expect(sendAsync).not.toHaveBeenCalled();
    expect(error()).toContain('Context provider unavailable');
  });
  it.each([false, true])(
    'clears sent inline problems and restores them on failure=%s',
    async (fail) => {
      appStore.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      const reference = {
        id: 'captured',
        diagnostic: {
          path: '/repo/a.ts',
          line: 2,
          severity: 'error' as const,
          message: 'Captured problem',
        },
      };
      appStore.setState(storePath('inlineProblems', [reference]));
      flushSolid();
      const sendAsync = vi.fn<SendAsync>(async () => {
        if (fail) throw new Error('Send failed');
      });
      const operations = createOperations(sendAsync);
      expect(await operations.sendMessage(`Explain ${problemReferenceMarker(reference)}`)).toBe(
        !fail
      );
      flushSolid();
      expect(
        sendAsync.mock.calls[0]![1].parts.flatMap((part) =>
          part.text ? [parseInlineProblem(part.text)] : []
        ).filter(Boolean)
      ).toEqual([reference]);
      expect(appStore.state.inlineProblems).toEqual(fail ? [reference] : []);
    }
  );

  it('sends queued inline problem snapshots without consuming the current draft', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    const queued = {
      id: 'queued-problem',
      diagnostic: {
        path: '/repo/old.ts',
        line: 1,
        severity: 'error' as const,
        message: 'Queued problem',
      },
    };
    const live = {
      id: 'live-problem',
      diagnostic: {
        path: '/repo/live.ts',
        line: 4,
        severity: 'warning' as const,
        message: 'Live problem',
      },
    };
    appStore.setState(storePath('inlineProblems', [live]));
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    await createOperations(sendAsync).sendMessage(`Explain ${problemReferenceMarker(queued)}`, {
      queuedAttachments: { inlineProblems: [queued] },
      preserveComposer: true,
    });
    flushSolid();
    expect(
      sendAsync.mock.calls[0]![1].parts.flatMap((part) =>
        part.text ? [parseInlineProblem(part.text)] : []
      ).filter(Boolean)
    ).toEqual([queued]);
    expect(appStore.state.inlineProblems).toEqual([live]);
  });
  beforeEach(() => {
    window.localStorage.clear();
    flushSolid();
    appStore.resetDefaultAppState();
    flushSolid();
    postMessage.mockClear();
  });

  afterEach(() => {
    window.localStorage.clear();
    flushSolid();
    appStore.resetDefaultAppState();
    flushSolid();
  });

  it.each([false, true])(
    'reports an unavailable selection before sending, newSession=%s',
    async (newSession) => {
      const selected = { providerID: 'openai', modelID: 'gpt-6.1-sol' };
      appStore.setState(storePath('activeSessionId', newSession ? null : 'session-1'));
      flushSolid();
      routingStore.setSelectedModel(selected);
      flushSolid();
      appStore.setState(
        storePath(
          'providers',
          ['openrouter', 'github-copilot'].map((id) => ({
            id,
            name: id,
            source: 'api',
            models: {
              'gpt-6.1-sol': {
                id: 'gpt-6.1-sol',
                name: 'GPT-6.1 Sol',
                capabilities: { toolcall: true },
                cost: { input: 0, output: 0 },
              },
            },
          }))
        )
      );
      flushSolid();
      composerStore.addContextFile({ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' });
      flushSolid();
      const sendAsync = vi.fn<SendAsync>(async () => {});
      const createSession = vi.fn(async () => 'session-2');
      const beforeOptimisticPublish = vi.fn();
      const operations = createOperations(sendAsync, undefined, { createSession });

      expect(() => operations.prepareSendMessage('Keep this draft')).toThrow('is unavailable');
      expect(
        await operations.sendMessage('Keep this draft', {
          onOptimisticPublish: beforeOptimisticPublish,
        })
      ).toBe(false);
      flushSolid();

      expect(error()).toContain('Selected model openai/gpt-6.1-sol is unavailable');
      expect(sendAsync).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(beforeOptimisticPublish).not.toHaveBeenCalled();
      expect(appStore.state.selectedModel).toEqual(selected);
      expect(appStore.state.droppedFiles).toHaveLength(1);
    }
  );

  it.each([
    { newSession: false, explicitDefault: false },
    { newSession: true, explicitDefault: false },
    { newSession: false, explicitDefault: true },
  ])(
    'preserves reasoning when sending with newSession=$newSession and explicitDefault=$explicitDefault',
    async ({ newSession, explicitDefault }) => {
      const model = { providerID: 'openai', modelID: 'gpt-6.1-sol' };
      const selected = explicitDefault ? model : { ...model, variant: 'high' };
      appStore.setState(storePath('activeSessionId', newSession ? null : 'session-1'));
      flushSolid();
      appStore.setState(
        storePath('providers', [
          {
            id: 'openai',
            name: 'OpenAI',
            source: 'api',
            models: {
              'gpt-6.1-sol': {
                id: 'gpt-6.1-sol',
                name: 'GPT-6.1 Sol',
                capabilities: { toolcall: true },
                cost: { input: 0, output: 0 },
                variants: { high: {} },
              },
            },
          },
        ])
      );
      flushSolid();
      routingStore.setSelectedModel(model, { rememberVariant: 'high' });
      flushSolid();
      if (explicitDefault) {
        routingStore.setSelectedModel(model, { sessionId: 'session-1', persistGlobal: false });
        flushSolid();
      }
      flushSolid();
      const createSession = vi.fn<
        ConstructorParameters<typeof SessionSendOperations>[0]['createSession']
      >(async () => {
        appStore.setState(storePath('activeSessionId', 'session-1'));
        return 'session-1';
      });
      const sendAsync = vi.fn<SendAsync>(async () => {});
      const operations = createOperations(sendAsync, undefined, { createSession });

      expect(await operations.sendMessage('First prompt')).toBe(true);
      flushSolid();
      expect(appStore.state.selectedModel).toEqual(selected);
      expect(routingStore.getSelectedModelForSession('session-1')).toEqual(selected);
      if (newSession) {
        expect(createSession).toHaveBeenCalledWith(expect.any(String), undefined, selected);
      }
      expect(await operations.sendMessage('Follow-up prompt')).toBe(true);
      flushSolid();
      expect(sendAsync).toHaveBeenCalledTimes(2);
      for (const [, body] of sendAsync.mock.calls) {
        expect(body.variant).toBe(explicitDefault ? undefined : 'high');
      }
    }
  );

  it.each([undefined, ['text']])('preserves PDFs on capability rejection: %j', async (input) => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('providers', [
        {
          id: 'fixture',
          name: 'Fixture',
          source: 'api',
          models: {
            text: {
              id: 'text',
              name: 'Text',
              capabilities: { input },
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('selectedModel', { providerID: 'fixture', modelID: 'text' }));
    flushSolid();
    const pdf = nativePdfFixture();
    appStore.setState(storePath('nativePdfs', [pdf]));
    flushSolid();
    const sendAsync = vi.fn<SendAsync>();
    expect(await createOperations(sendAsync).sendMessage('Keep this draft')).toBe(false);
    flushSolid();
    expect(error()).toContain(
      input ? 'does not support PDF input' : 'PDF input support is unknown'
    );
    expect(appStore.state.nativePdfs).toEqual([pdf]);
    expect(sendAsync).not.toHaveBeenCalled();
    expect(appStore.state.messages).toEqual([]);
  });

  it('builds the payload from stores and clears sent composer attachments', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'PDF fixture',
              capabilities: { input: ['text', 'image', 'pdf'] },
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-5' }));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    appStore.setState(storePath('terminalSelection', { text: 'npm test', terminalName: 'zsh' }));
    flushSolid();
    appStore.setState(
      storePath('droppedFiles', [
        {
          path: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          type: 'file',
          attachmentSequence: 1,
        },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('clipboardImages', [
        {
          id: 'image-1',
          url: 'blob:image-1',
          mime: 'image/png',
          filename: 'image.png',
          size: 10,
          attachmentSequence: 2,
          contextFile: {
            path: '/tmp/varro-drops/image.png',
            relativePath: 'image.png',
            type: 'file',
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('nativePdfs', [
        {
          id: 'pdf-1',
          url: 'data:application/pdf;base64,JVBERi0=',
          mime: 'application/pdf',
          filename: 'spec.pdf',
          size: 5,
          attachmentSequence: 3,
          contextFile: {
            path: '/tmp/varro-drops/spec.pdf',
            relativePath: 'spec.pdf',
            type: 'file',
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Keep visible', status: 'completed', priority: 'high' },
      ])
    );
    flushSolid();

    const sendAsync = vi.fn<SendAsync>(async () => {
      appStore.setState(
        storePath('messages', [
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
        ])
      );
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
      getMessageCount: () => 1,
      continueInterruptedSession: vi.fn(async () => {}),
    });

    await operations.sendMessage('hello');
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
      model: { providerID: 'openai', modelID: 'gpt-5' },
      parts: [
        { type: 'text', text: 'hello' },
        {
          type: 'text',
          text: '[Selection from terminal zsh]\n```text\nnpm test\n```',
        },
        { type: 'text', text: '[Attached file: /repo/src/file.ts]' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'image.png',
          url: 'blob:image-1',
        },
        {
          type: 'file',
          mime: 'application/pdf',
          filename: 'spec.pdf',
          url: 'data:application/pdf;base64,JVBERi0=',
        },
      ],
    });
    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.nativePdfs).toEqual([]);
    expect(appStore.state.todos).toEqual([
      { id: 'todo-1', content: 'Keep visible', status: 'completed', priority: 'high' },
    ]);
    expect(resetTodoSync).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'files/clear',
      payload: { sentSessionId: 'session-1' },
    });
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'images/release',
      payload: {
        paths: ['/tmp/varro-drops/image.png', '/tmp/varro-drops/spec.pdf'],
        deferred: true,
        sessionId: 'session-1',
      },
    });
  });

  it('uses a session Default without replacing the remembered reasoning variant', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5.4': {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              capabilities: { toolcall: true, reasoning: true },
              cost: { input: 0, output: 0 },
              variants: { low: {}, medium: {}, high: {} },
            },
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('providerDefaults', { openai: 'gpt-5.4' }));
    flushSolid();
    routingStore.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-5.4', variant: 'high' },
      { rememberVariant: 'high' }
    );
    flushSolid();
    routingStore.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-5.4' },
      { sessionId: 'session-1', persistGlobal: false }
    );
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('Use the session default');
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        model: { providerID: 'openai', modelID: 'gpt-5.4' },
      })
    );
    expect(sendAsync.mock.calls[0]?.[1]).not.toHaveProperty('variant');
    expect(appStore.state.modelVariantSelections['openai:gpt-5.4']).toBe('high');
    expect(routingStore.getPersistedSelectedModel()).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'high',
    });
  });

  it('keeps the sent model through delayed previous-turn snapshots before the first enqueue', async () => {
    const sessionId = 'session-1';
    const previous = { providerID: 'openai', modelID: 'gpt-6-luna-fast' };
    const selected = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
    const expected = { ...selected };
    appStore.setState(storePath('activeSessionId', sessionId));
    flushSolid();
    appStore.setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: Object.fromEntries(
            [previous, selected].map(({ modelID }) => [
              modelID,
              {
                id: modelID,
                name: modelID,
                capabilities: { toolcall: true },
                cost: { input: 0, output: 0 },
                variants: { high: {} },
              },
            ])
          ),
        },
      ])
    );
    flushSolid();
    routingStore.setSelectedModel({ ...previous }, { sessionId, persistGlobal: false });
    flushSolid();
    expect(isActiveSessionWorking()).toBe(false);
    routingStore.setSelectedModel({ ...selected }, { sessionId, selectionId: 'idle-selection' });
    flushSolid();
    applySessionSelectedModelsSnapshot(
      { [sessionId]: { ...selected } },
      { sessionId, selectionId: 'idle-selection' }
    );
    flushSolid();
    expect(isActiveSessionWorking()).toBe(false);
    const send = deferred<void>();
    const sendAsync = vi.fn<SendAsync>(() => send.promise);
    const operations = createOperations(sendAsync, undefined, {
      setSessionStatusEntry: (id, status) =>
        appStore.setState(storePath('sessionStatus', id, status)),
    });
    const pending = operations.sendMessage('Start the Sol turn');
    flushSolid();
    try {
      await vi.waitFor(() => expect(sendAsync).toHaveBeenCalledOnce());
      flushSolid();
      expect(sendAsync.mock.calls[0]?.[1]).toMatchObject({
        model: { providerID: expected.providerID, modelID: expected.modelID },
        variant: 'high',
      });
      applySessionSelectedModelsSnapshot({ [sessionId]: { ...previous } });
      flushSolid();

      // The first queued message captures the composer selection during this window.
      expect(appStore.state.selectedModel).toEqual(expected);
      expect(routingStore.getSelectedModelForSession(sessionId)).toEqual(expected);
    } finally {
      send.resolve();
      flushSolid();
      await pending;
      flushSolid();
    }
  });

  it('clears sent composer attachments while the network send is pending', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    composerStore.addContextFile({
      path: '/repo/pending.ts',
      relativePath: 'pending.ts',
      type: 'file',
    });
    flushSolid();
    composerStore.addClipboardImage({
      id: 'pending-image',
      url: 'blob:pending',
      mime: 'image/png',
      filename: 'pending.png',
      size: 10,
    });
    flushSolid();
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    flushSolid();
    const send = deferred<void>();
    const sendAsync = vi.fn(() => send.promise);
    const operations = createOperations(sendAsync);

    const pending = operations.sendMessage('send pending context');
    flushSolid();
    await vi.waitFor(() => expect(sendAsync).toHaveBeenCalledOnce());
    flushSolid();

    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'files/clear' }));
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });

    send.resolve();
    flushSolid();
    await pending;
    flushSolid();

    expect(postMessage).toHaveBeenCalledWith({
      type: 'files/clear',
      payload: { sentSessionId: 'session-1' },
    });
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('restores composer attachments when a pending send fails', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    composerStore.addContextFile({
      path: '/repo/retry.ts',
      relativePath: 'retry.ts',
      type: 'file',
    });
    flushSolid();
    composerStore.addClipboardImage({
      id: 'retry-image',
      url: 'blob:retry',
      mime: 'image/png',
      filename: 'retry.png',
      size: 10,
    });
    flushSolid();
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    flushSolid();
    const send = deferred<void>();
    const sendAsync = vi.fn(() => send.promise);
    const operations = createOperations(sendAsync);

    const pending = operations.sendMessage('retry context');
    flushSolid();
    await vi.waitFor(() => expect(sendAsync).toHaveBeenCalledOnce());
    flushSolid();
    expect(appStore.state.droppedFiles).toEqual([]);

    send.reject(new Error('send failed'));
    flushSolid();
    await expect(pending).resolves.toBe(false);
    flushSolid();

    expect(appStore.state.droppedFiles).toMatchObject([
      { path: '/repo/retry.ts', relativePath: 'retry.ts', type: 'file' },
    ]);
    expect(appStore.state.clipboardImages).toMatchObject([
      { id: 'retry-image', filename: 'retry.png' },
    ]);
    expect(appStore.state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'files/clear' }));
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('shares one lazy session creation across rapid sends', async () => {
    appStore.setState(storePath('activeSessionId', null));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    const creation = deferred<string | null>();
    const createSession = vi.fn(async () => {
      const sessionId = await creation.promise;
      if (sessionId) appStore.setState(storePath('activeSessionId', sessionId));
      return sessionId;
    });
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = new SessionSendOperations({
      createSession,
      clearPendingAbort: vi.fn(),
      resetTodoSync: vi.fn(),
      syncSessionMcps: vi.fn(async () => {}),
      sendAsync,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      recheckSessionStatus: vi.fn(async () => {}),
      setSessionStatusEntry: vi.fn(),
      getMessageCount: () => 1,
      continueInterruptedSession: vi.fn(async () => {}),
    });

    const first = operations.sendMessage('first');
    flushSolid();
    const second = operations.sendMessage('second');
    flushSolid();
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    flushSolid();
    creation.resolve('session-new');
    flushSolid();
    await Promise.all([first, second]);
    flushSolid();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendAsync).toHaveBeenCalledTimes(2);
    expect(sendAsync.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-new',
      'session-new',
    ]);
  });

  it('starts a separate lazy creation after the user opens another new-chat draft', async () => {
    appStore.setState(storePath('activeSessionId', null));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    const firstCreation = deferred<string | null>();
    const secondCreation = deferred<string | null>();
    const createSession = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(firstCreation.promise)
      .mockReturnValueOnce(secondCreation.promise);
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = new SessionSendOperations({
      createSession,
      clearPendingAbort: vi.fn(),
      resetTodoSync: vi.fn(),
      syncSessionMcps: vi.fn(async () => {}),
      sendAsync,
      syncSession: vi.fn(async () => {}),
      syncSessionMessages: vi.fn(async () => {}),
      recheckSessionStatus: vi.fn(async () => {}),
      setSessionStatusEntry: vi.fn(),
      getMessageCount: () => 1,
      continueInterruptedSession: vi.fn(async () => {}),
    });

    const first = operations.sendMessage('first draft');
    flushSolid();
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    flushSolid();
    startNewChatDraft();
    flushSolid();
    const second = operations.sendMessage('second draft');
    flushSolid();
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    flushSolid();

    secondCreation.resolve('session-second');
    flushSolid();
    firstCreation.resolve('session-first');
    flushSolid();
    await Promise.all([first, second]);
    flushSolid();

    expect(sendAsync.mock.calls.map(([sessionId]) => sessionId).toSorted()).toEqual([
      'session-first',
      'session-second',
    ]);
  });

  it.each([false, true])(
    'handles image storage completing during send preparation, failure=%s',
    async (fail) => {
      appStore.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      const image = {
        id: 'pasted-image',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'Image 1',
        size: 1,
      };
      composerStore.addClipboardImage(image);
      flushSolid();
      const contextFile = {
        path: '/repo/image.png',
        relativePath: 'image.png',
        type: 'file' as const,
      };
      let draftImageIdsDuringSend: string[] | undefined;
      const operations = createOperations(
        vi.fn(async () => {
          flushSolid();
          draftImageIdsDuringSend = appStore.state.clipboardImages.map((item) => item.id);
          if (fail) throw new Error('Send failed');
        })
      );
      const send = operations.prepareSendMessage('Look at [Image 1]');
      setClipboardImageContextFile(image.id, contextFile);
      flushSolid();

      expect(await send()).toBe(!fail);
      flushSolid();
      expect(draftImageIdsDuringSend).toEqual([]);
      if (fail) {
        expect(appStore.state.clipboardImages).toEqual([
          expect.objectContaining({ ...image, contextFile }),
        ]);
      } else {
        expect(appStore.state.clipboardImages).toEqual([]);
        expect(postMessage).toHaveBeenCalledWith({
          type: 'images/release',
          payload: { paths: [contextFile.path], deferred: true, sessionId: 'session-1' },
        });
        expect(composerStore.addClipboardImage({ ...image, id: 'next-paste' })).toBe(true);
        flushSolid();
      }
      flushSolid();
    }
  );

  it('clears sent attachments restored without inline sequences', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    replaceContextFiles([{ path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' }]);
    flushSolid();
    replaceClipboardImages([
      {
        id: 'image-1',
        url: 'blob:image-1',
        mime: 'image/png',
        filename: 'image.png',
        size: 10,
      },
    ]);
    flushSolid();
    expect(appStore.state.droppedFiles[0]?.attachmentSequence).toBeUndefined();
    expect(appStore.state.clipboardImages[0]?.attachmentSequence).toBeUndefined();
    const operations = createOperations(vi.fn(async () => {}));

    await operations.sendMessage('send restored context');
    flushSolid();

    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'files/clear',
      payload: { sentSessionId: 'session-1' },
    });
  });

  it('clears matching composer attachments after sending to an inactive target session', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(storePath('selectedAgent', 'plan'));
    flushSolid();
    appStore.setState(storePath('sessionSelectedAgents', 'session-2', 'build'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    composerStore.addContextFile({
      path: '/repo/target.ts',
      relativePath: 'target.ts',
      type: 'file',
    });
    flushSolid();
    composerStore.addClipboardImage({
      id: 'target-image',
      url: 'blob:target',
      mime: 'image/png',
      filename: 'target.png',
      size: 10,
    });
    flushSolid();
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    flushSolid();
    const sendAsync = vi.fn(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('send to target', { targetSessionId: 'session-2' });
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({ agent: 'build' })
    );
    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
  });

  it('uses the visible agent when active session routing is stale', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(storePath('selectedAgent', 'build'));
    flushSolid();
    appStore.setState(storePath('sessionSelectedAgents', 'session-1', 'plan'));
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('implement the plan');
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ agent: 'build' })
    );
  });

  it('creates a session for an explicitly captured draft despite a later active session', async () => {
    appStore.setState(storePath('activeSessionId', 'session-later'));
    flushSolid();
    const createSession = vi.fn(async () => 'session-draft');
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync, undefined, { createSession });

    await operations.sendMessage('send captured draft', { targetSessionId: null });
    flushSolid();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendAsync).toHaveBeenCalledWith('session-draft', expect.any(Object));
  });

  it('removes only captured attachments after a pending send succeeds', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    composerStore.addContextFile({
      path: '/repo/sent.ts',
      relativePath: 'sent.ts',
      type: 'file',
    });
    flushSolid();
    composerStore.addClipboardImage({
      id: 'sent-image',
      url: 'blob:sent',
      mime: 'image/png',
      filename: 'sent.png',
      size: 10,
    });
    flushSolid();
    composerStore.setTerminalSelection({ text: 'sent command', terminalName: 'zsh' });
    flushSolid();
    const send = deferred<void>();
    const operations = createOperations(vi.fn(() => send.promise));

    const pending = operations.sendMessage('send captured context');
    flushSolid();
    await vi.waitFor(() => expect(appStore.state.messages).toHaveLength(0));
    flushSolid();
    composerStore.addContextFile({
      path: '/repo/new.ts',
      relativePath: 'new.ts',
      type: 'file',
    });
    flushSolid();
    composerStore.addClipboardImage({
      id: 'new-image',
      url: 'blob:new',
      mime: 'image/png',
      filename: 'new.png',
      size: 10,
    });
    flushSolid();
    composerStore.setTerminalSelection({ text: 'new command', terminalName: 'zsh' });
    flushSolid();
    appStore.setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    send.resolve();
    flushSolid();
    await pending;
    flushSolid();

    expect(appStore.state.droppedFiles.map((file) => file.path)).toEqual(['/repo/new.ts']);
    expect(appStore.state.clipboardImages.map((image) => image.id)).toEqual(['new-image']);
    expect(appStore.state.terminalSelection).toEqual({
      text: 'new command',
      terminalName: 'zsh',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'files/remove',
      payload: { path: '/repo/sent.ts', sentSessionId: 'session-1' },
    });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('preserves identical attachments that were replaced while sending', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    const file = { path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' as const };
    const image = {
      id: 'image-1',
      url: 'blob:image-1',
      mime: 'image/png',
      filename: 'image.png',
      size: 10,
    };
    const terminalSelection = { text: 'npm test', terminalName: 'zsh' };
    composerStore.addContextFile(file);
    flushSolid();
    composerStore.addClipboardImage(image);
    flushSolid();
    composerStore.setTerminalSelection(terminalSelection);
    flushSolid();
    const send = deferred<void>();
    const operations = createOperations(vi.fn(() => send.promise));

    const pending = operations.sendMessage('send context');
    flushSolid();
    composerStore.removeContextFile(file.path);
    flushSolid();
    composerStore.addContextFile(file);
    flushSolid();
    composerStore.removeClipboardImage(image.id);
    flushSolid();
    composerStore.addClipboardImage(image);
    flushSolid();
    composerStore.setTerminalSelection(null);
    flushSolid();
    composerStore.setTerminalSelection({ ...terminalSelection });
    flushSolid();
    send.resolve();
    flushSolid();
    await pending;
    flushSolid();

    expect(appStore.state.droppedFiles.map((item) => item.path)).toEqual([file.path]);
    expect(appStore.state.clipboardImages.map((item) => item.id)).toEqual([image.id]);
    expect(appStore.state.terminalSelection).toEqual(terminalSelection);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'files/clear' }));
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('treats a queued null terminal selection as explicitly empty', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    appStore.setState(
      storePath('terminalSelection', { text: 'live command', terminalName: 'zsh' })
    );
    flushSolid();
    const sendAsync = vi.fn(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('queued prompt', {
      messageId: 'msg_queued',
      queuedAttachments: {
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
      preserveComposer: true,
    });
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      messageID: 'msg_queued',
      parts: [{ type: 'text', text: 'queued prompt' }],
    });
    expect(appStore.state.terminalSelection).toEqual({
      text: 'live command',
      terminalName: 'zsh',
    });
  });

  it.each([
    { enabled: true, integrationEnabled: true },
    { enabled: false, integrationEnabled: true },
    { enabled: true, integrationEnabled: false },
  ])(
    'uses the queued problem-context toggle %s instead of the live toggle',
    async ({ enabled, integrationEnabled }) => {
      appStore.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      appStore.setState(storePath('issuesEnabled', !enabled));
      flushSolid();
      appStore.setState(storePath('autoAttachProblems', integrationEnabled));
      flushSolid();
      const sendAsync = vi.fn<SendAsync>(async () => {});
      const operations = createOperations(sendAsync);
      await operations.sendMessage('queued problem question', {
        queuedContext: {
          currentDocumentEnabled: false,
          issuesEnabled: enabled,
          editorContext: {
            workspacePath: '/repo',
            activeFile: {
              path: '/repo/original.ts',
              relativePath: 'original.ts',
              language: 'typescript',
            },
            selection: null,
            diagnostics: [
              { path: '/repo/original.ts', line: 1, severity: 'error', message: 'Original error' },
            ],
          },
        },
        preserveComposer: true,
      });
      flushSolid();
      expect(sendAsync).toHaveBeenCalledOnce();
      const parts = sendAsync.mock.calls[0]![1].parts;
      expect(parts.some((part) => part.text?.includes('Original error'))).toBe(
        enabled && integrationEnabled
      );
    }
  );

  it('builds a queued prompt from its captured editor context instead of live editor state', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/new-workspace',
        activeFile: {
          path: '/new-workspace/private.ts',
          relativePath: 'private.ts',
          language: 'typescript',
        },
        selection: null,
        editorText: {
          kind: 'dirty-buffer',
          path: '/new-workspace/private.ts',
          relativePath: 'private.ts',
          language: 'typescript',
          range: { startLine: 1, endLine: 1 },
          text: 'const privateValue = true;',
          truncated: false,
        },
        diagnostics: [],
      })
    );
    flushSolid();
    const sendAsync = vi.fn(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('queued prompt', {
      messageId: 'msg_queued_context',
      queuedAttachments: {
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
      queuedContext: {
        editorContext: {
          workspacePath: '/original-workspace',
          activeFile: {
            path: '/original-workspace/original.ts',
            relativePath: 'original.ts',
            language: 'typescript',
          },
          selection: { startLine: 4, endLine: 4 },
          diagnostics: [],
        },
        currentDocumentEnabled: true,
      },
      preserveComposer: true,
    });
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      messageID: 'msg_queued_context',
      parts: [
        { type: 'text', text: 'queued prompt' },
        { type: 'text', text: '[Selection from original.ts lines 4]' },
      ],
    });
  });

  it.each(['recorded', 'legacy', 'manual'] as const)(
    'respects auto-attachment opt-outs when sending a queued %s file',
    async (kind) => {
      appStore.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      appStore.setState(storePath('autoAttachActiveFile', false));
      flushSolid();
      appStore.setState(storePath('autoAttachProblems', false));
      flushSolid();
      const sendAsync = vi.fn<SendAsync>(async () => {});
      const operations = createOperations(sendAsync);
      await operations.sendMessage('Review', {
        queuedAttachments: {
          droppedFiles: [
            {
              path: '/repo/app.ts',
              relativePath: 'app.ts',
              type: 'file',
              attachmentSequence: kind === 'manual' ? 1 : undefined,
              lineRanges: [{ startLine: 2, endLine: 3 }],
            },
          ],
        },
        queuedContext: {
          currentDocumentEnabled: true,
          autoAttachedFilePath: kind === 'recorded' ? '/repo/app.ts' : undefined,
          issuesEnabled: true,
          editorContext: {
            workspacePath: '/repo',
            activeFile: { path: '/repo/app.ts', relativePath: 'app.ts', language: 'typescript' },
            selection: { startLine: 2, endLine: 3 },
            diagnostics: [
              { path: '/repo/app.ts', line: 2, severity: 'error', message: 'Automatic error' },
            ],
          },
        },
        preserveComposer: true,
      });
      flushSolid();
      expect(sendAsync).toHaveBeenCalledOnce();
      expect(sendAsync.mock.calls[0]![1].parts).toEqual([
        { type: 'text', text: 'Review' },
        ...(kind === 'manual' ? [{ type: 'text', text: '[Selection from app.ts lines 2-3]' }] : []),
      ]);
    }
  );

  it('scopes a queued dispatch to its original workspace', async () => {
    appStore.setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo-b',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const ensureSessionPermission = vi.fn(async () => true);
    const syncSession = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});
    const recheckSessionStatus = vi.fn(async () => {});
    const operations = createOperations(sendAsync, ensureSessionPermission, {
      syncSession,
      syncSessionMessages,
      recheckSessionStatus,
    });

    await operations.sendMessage('queued prompt', {
      messageId: 'msg_queued_workspace',
      targetSessionId: 'session-1',
      workspaceDirectory: '/repo-a',
      queuedContext: {
        editorContext: {
          workspacePath: '/repo-a',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        currentDocumentEnabled: false,
      },
      queuedMessageDispatch: { itemId: 'queue-1', lease: 2 },
      preserveComposer: true,
    });
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        messageID: 'msg_queued_workspace',
        queuedMessageDispatch: { itemId: 'queue-1', lease: 2 },
      }),
      { directory: '/repo-a' }
    );
    expect(ensureSessionPermission).not.toHaveBeenCalled();
    expect(syncSession).not.toHaveBeenCalled();
    expect(syncSessionMessages).not.toHaveBeenCalled();
    expect(recheckSessionStatus).not.toHaveBeenCalled();
  });

  it('uses the queued workspace vision-delegation decision', async () => {
    appStore.setState(storePath('activeSessionId', 'session-2'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo-b',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    appStore.setState(
      storePath('providers', [
        {
          id: 'custom',
          name: 'Current workspace',
          source: 'custom',
          models: {
            text: {
              id: 'text',
              name: 'Text model',
              capabilities: { vision: false, toolcall: true },
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    appStore.setState(storePath('allAgents', []));
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('Inspect the queued image', {
      selectedModel: { providerID: 'custom', modelID: 'text' },
      targetSessionId: 'session-1',
      workspaceDirectory: '/repo-a',
      queuedAttachments: {
        droppedFiles: [],
        clipboardImages: [
          {
            id: 'image-1',
            url: 'data:image/png;base64,aW1hZ2U=',
            mime: 'image/png',
            filename: 'Image 1',
            size: 5,
            contextFile: {
              path: '/tmp/varro-drops/repo-a/Image 1.png',
              relativePath: 'Image 1.png',
              type: 'file',
            },
          },
        ],
        terminalSelection: null,
      },
      queuedContext: {
        editorContext: {
          workspacePath: '/repo-a',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        currentDocumentEnabled: false,
        visionDelegationAvailable: true,
      },
      preserveComposer: true,
    });
    flushSolid();

    expect(sendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        parts: expect.arrayContaining([
          {
            type: 'text',
            text:
              '[Image for @vision: /tmp/varro-drops/repo-a/Image 1.png]\n' +
              'Call the vision subagent to inspect this image before responding. Include {file:/tmp/varro-drops/repo-a/Image 1.png} in its task prompt.',
          },
        ]),
      }),
      { directory: '/repo-a' }
    );
  });

  it('sends a same-workspace queued retry without repeating session preparation', async () => {
    appStore.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    appStore.setState(
      storePath('editorContext', {
        workspacePath: '/repo-a',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    const sendAsync = vi.fn<SendAsync>(async () => {});
    const ensureSessionPermission = vi.fn(async () => true);
    const operations = createOperations(sendAsync, ensureSessionPermission);

    await operations.sendMessage('retry queued prompt', {
      messageId: 'msg_queued_retry',
      targetSessionId: 'session-1',
      workspaceDirectory: '/repo-a',
      queuedMessageDispatch: { itemId: 'queue-1', lease: 3 },
      preserveComposer: true,
    });
    flushSolid();

    expect(ensureSessionPermission).not.toHaveBeenCalled();
    expect(sendAsync).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ messageID: 'msg_queued_retry' }),
      { directory: '/repo-a' }
    );
  });
});
