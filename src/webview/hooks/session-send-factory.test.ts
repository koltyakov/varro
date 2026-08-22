import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeModule from '../lib/bridge';

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
import { startNewChatDraft } from '../lib/new-chat-draft';
import { replaceClipboardImages, replaceContextFiles } from '../lib/state';
import { SessionSendOperations } from './session/session-send';

type SendAsync = ConstructorParameters<typeof SessionSendOperations>[0]['sendAsync'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createOperations(sendAsync: SendAsync) {
  return new SessionSendOperations({
    createSession: vi.fn(async () => 'session-2'),
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
}

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
      {
        path: '/repo/src/file.ts',
        relativePath: 'src/file.ts',
        type: 'file',
        attachmentSequence: 1,
      },
    ]);
    appStore.setState('clipboardImages', [
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
    ]);
    appStore.setState('todos', [
      { id: 'todo-1', content: 'Keep visible', status: 'completed', priority: 'high' },
    ]);

    const sendAsync = vi.fn<SendAsync>(async () => {
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
      getMessageCount: () => 1,
      continueInterruptedSession: vi.fn(async () => {}),
    });

    await operations.sendMessage('hello');

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
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
    expect(postMessage).toHaveBeenCalledWith({
      type: 'images/release',
      payload: {
        paths: ['/tmp/varro-drops/image.png'],
        deferred: true,
        sessionId: 'session-1',
      },
    });
  });

  it('clears sent composer attachments while the network send is pending', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    composerStore.addContextFile({
      path: '/repo/pending.ts',
      relativePath: 'pending.ts',
      type: 'file',
    });
    composerStore.addClipboardImage({
      id: 'pending-image',
      url: 'blob:pending',
      mime: 'image/png',
      filename: 'pending.png',
      size: 10,
    });
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    const send = deferred<void>();
    const sendAsync = vi.fn(() => send.promise);
    const operations = createOperations(sendAsync);

    const pending = operations.sendMessage('send pending context');
    await vi.waitFor(() => expect(sendAsync).toHaveBeenCalledOnce());

    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });

    send.resolve();
    await pending;

    expect(postMessage).toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('restores composer attachments when a pending send fails', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    composerStore.addContextFile({
      path: '/repo/retry.ts',
      relativePath: 'retry.ts',
      type: 'file',
    });
    composerStore.addClipboardImage({
      id: 'retry-image',
      url: 'blob:retry',
      mime: 'image/png',
      filename: 'retry.png',
      size: 10,
    });
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    const send = deferred<void>();
    const sendAsync = vi.fn(() => send.promise);
    const operations = createOperations(sendAsync);

    const pending = operations.sendMessage('retry context');
    await vi.waitFor(() => expect(sendAsync).toHaveBeenCalledOnce());
    expect(appStore.state.droppedFiles).toEqual([]);

    send.reject(new Error('send failed'));
    await expect(pending).resolves.toBe(false);

    expect(appStore.state.droppedFiles).toMatchObject([
      { path: '/repo/retry.ts', relativePath: 'retry.ts', type: 'file' },
    ]);
    expect(appStore.state.clipboardImages).toMatchObject([
      { id: 'retry-image', filename: 'retry.png' },
    ]);
    expect(appStore.state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('shares one lazy session creation across rapid sends', async () => {
    appStore.setState('activeSessionId', null);
    appStore.setState('editorContext', {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    const creation = deferred<string | null>();
    const createSession = vi.fn(async () => {
      const sessionId = await creation.promise;
      if (sessionId) appStore.setState('activeSessionId', sessionId);
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
    const second = operations.sendMessage('second');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    creation.resolve('session-new');
    await Promise.all([first, second]);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendAsync).toHaveBeenCalledTimes(2);
    expect(sendAsync.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-new',
      'session-new',
    ]);
  });

  it('starts a separate lazy creation after the user opens another new-chat draft', async () => {
    appStore.setState('activeSessionId', null);
    appStore.setState('editorContext', {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
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
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    startNewChatDraft();
    const second = operations.sendMessage('second draft');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));

    secondCreation.resolve('session-second');
    firstCreation.resolve('session-first');
    await Promise.all([first, second]);

    expect(sendAsync.mock.calls.map(([sessionId]) => sessionId).toSorted()).toEqual([
      'session-first',
      'session-second',
    ]);
  });

  it('clears sent attachments restored without inline sequences', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    replaceContextFiles([{ path: '/repo/file.ts', relativePath: 'file.ts', type: 'file' }]);
    replaceClipboardImages([
      {
        id: 'image-1',
        url: 'blob:image-1',
        mime: 'image/png',
        filename: 'image.png',
        size: 10,
      },
    ]);
    expect(appStore.state.droppedFiles[0]?.attachmentSequence).toBeUndefined();
    expect(appStore.state.clipboardImages[0]?.attachmentSequence).toBeUndefined();
    const operations = createOperations(vi.fn(async () => {}));

    await operations.sendMessage('send restored context');

    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith({ type: 'files/clear' });
  });

  it('clears matching composer attachments after sending to an inactive target session', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('selectedAgent', 'plan');
    appStore.setState('sessionSelectedAgents', 'session-2', 'build');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    composerStore.addContextFile({
      path: '/repo/target.ts',
      relativePath: 'target.ts',
      type: 'file',
    });
    composerStore.addClipboardImage({
      id: 'target-image',
      url: 'blob:target',
      mime: 'image/png',
      filename: 'target.png',
      size: 10,
    });
    composerStore.setTerminalSelection({ text: 'npm test', terminalName: 'zsh' });
    const sendAsync = vi.fn(async () => {});
    const operations = createOperations(sendAsync);

    await operations.sendMessage('send to target', { targetSessionId: 'session-2' });

    expect(sendAsync).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({ agent: 'build' })
    );
    expect(appStore.state.droppedFiles).toEqual([]);
    expect(appStore.state.clipboardImages).toEqual([]);
    expect(appStore.state.terminalSelection).toBeNull();
  });

  it('removes only captured attachments after a pending send succeeds', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    composerStore.addContextFile({
      path: '/repo/sent.ts',
      relativePath: 'sent.ts',
      type: 'file',
    });
    composerStore.addClipboardImage({
      id: 'sent-image',
      url: 'blob:sent',
      mime: 'image/png',
      filename: 'sent.png',
      size: 10,
    });
    composerStore.setTerminalSelection({ text: 'sent command', terminalName: 'zsh' });
    const send = deferred<void>();
    const operations = createOperations(vi.fn(() => send.promise));

    const pending = operations.sendMessage('send captured context');
    await vi.waitFor(() => expect(appStore.state.messages).toHaveLength(0));
    composerStore.addContextFile({
      path: '/repo/new.ts',
      relativePath: 'new.ts',
      type: 'file',
    });
    composerStore.addClipboardImage({
      id: 'new-image',
      url: 'blob:new',
      mime: 'image/png',
      filename: 'new.png',
      size: 10,
    });
    composerStore.setTerminalSelection({ text: 'new command', terminalName: 'zsh' });
    appStore.setState('activeSessionId', 'session-2');
    send.resolve();
    await pending;

    expect(appStore.state.droppedFiles.map((file) => file.path)).toEqual(['/repo/new.ts']);
    expect(appStore.state.clipboardImages.map((image) => image.id)).toEqual(['new-image']);
    expect(appStore.state.terminalSelection).toEqual({
      text: 'new command',
      terminalName: 'zsh',
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'files/remove',
      payload: { path: '/repo/sent.ts' },
    });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('preserves identical attachments that were replaced while sending', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
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
    composerStore.addClipboardImage(image);
    composerStore.setTerminalSelection(terminalSelection);
    const send = deferred<void>();
    const operations = createOperations(vi.fn(() => send.promise));

    const pending = operations.sendMessage('send context');
    composerStore.removeContextFile(file.path);
    composerStore.addContextFile(file);
    composerStore.removeClipboardImage(image.id);
    composerStore.addClipboardImage(image);
    composerStore.setTerminalSelection(null);
    composerStore.setTerminalSelection({ ...terminalSelection });
    send.resolve();
    await pending;

    expect(appStore.state.droppedFiles.map((item) => item.path)).toEqual([file.path]);
    expect(appStore.state.clipboardImages.map((item) => item.id)).toEqual([image.id]);
    expect(appStore.state.terminalSelection).toEqual(terminalSelection);
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'files/clear' });
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminal-selection/clear' });
  });

  it('treats a queued null terminal selection as explicitly empty', async () => {
    appStore.setState('activeSessionId', 'session-1');
    appStore.setState('editorContext', {
      workspacePath: null,
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    appStore.setState('terminalSelection', { text: 'live command', terminalName: 'zsh' });
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

    expect(sendAsync).toHaveBeenCalledWith('session-1', {
      messageID: 'msg_queued',
      parts: [{ type: 'text', text: 'queued prompt' }],
    });
    expect(appStore.state.terminalSelection).toEqual({
      text: 'live command',
      terminalName: 'zsh',
    });
  });
});
