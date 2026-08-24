import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import packageJson from '../../../package.json';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import type { ProviderLimitStatus, WebviewMessage } from '../../shared/protocol';
import type { Session, TextPart, UserMessage } from '../types';
import { ChatInput, sendDroppedContent } from './ChatInput';
import {
  state,
  inputText,
  setConnectionInitialized,
  setIsLoading,
  setShowChangedFiles,
  setShowModelPicker,
  setState,
  setInputText,
  addContextFile,
  addClipboardImage,
  MAX_CLIPBOARD_IMAGES,
  MAX_CLIPBOARD_IMAGE_SIZE,
  nextPastedImageIndex,
  removeContextFile,
  resetPastedImageIndex,
  resetDefaultAppState,
  setQueuedMessageEdit,
} from '../lib/state';
import { client } from '../lib/client';
import { resetMessageEditState, startEditingMessage } from '../lib/message-edit-state';
import { setSessionHistoryPrompts } from '../lib/message-window';
import { hasExpandedDiffOverlay, setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { fixture } from '../test-fixtures';
import type { UnknownRecord } from '../../shared/type-utils';
import {
  applyQueuedMessageClaimResult,
  applyQueuedMessagesSnapshot,
  syncQueuedMessages,
} from '../lib/state-queued-messages';
import { sendQueuedAsSteer } from './chat-input/queued-steer';

interface SessionEventProperties extends UnknownRecord {
  sessionID: string;
  status?: { type: 'idle' };
}

const {
  abortSessionMock,
  continueInterruptedSessionMock,
  editMessageMock,
  forkSessionMock,
  loadOlderSessionPromptsMock,
  redoSessionMock,
  showSessionActionFeedbackMock,
  undoSessionMock,
  runSlashCommandByNameMock,
  sendMessageMock,
  serverEventHandlers,
  serverEventsOnMock,
} = vi.hoisted(() => ({
  abortSessionMock: vi.fn(async () => {}),
  continueInterruptedSessionMock: vi.fn(async () => {}),
  editMessageMock: vi.fn<typeof UseOpenCodeModule.editMessage>(async () => true),
  forkSessionMock: vi.fn(async () => 'forked-session'),
  loadOlderSessionPromptsMock: vi.fn(async () => false),
  redoSessionMock: vi.fn(async () => {}),
  showSessionActionFeedbackMock: vi.fn(),
  undoSessionMock: vi.fn(async () => {}),
  runSlashCommandByNameMock: vi.fn(async () => true),
  sendMessageMock: vi.fn<typeof UseOpenCodeModule.sendMessage>(async () => true),
  serverEventHandlers: new Map<
    string,
    Set<(event: { type: string; properties?: UnknownRecord }) => void>
  >(),
  serverEventsOnMock: vi.fn(
    (type: string, handler: (event: { type: string; properties?: UnknownRecord }) => void) => {
      if (!serverEventHandlers.has(type)) serverEventHandlers.set(type, new Set());
      serverEventHandlers.get(type)!.add(handler);
      return () => serverEventHandlers.get(type)?.delete(handler);
    }
  ),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise ChatInput's module-level hook and client integration. */
vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    abortSession: abortSessionMock,
    continueInterruptedSession: continueInterruptedSessionMock,
    editMessage: editMessageMock,
    forkSession: forkSessionMock,
    loadOlderSessionPrompts: loadOlderSessionPromptsMock,
    redoSession: redoSessionMock,
    undoSession: undoSessionMock,
    runSlashCommandByName: runSlashCommandByNameMock,
    sendMessage: sendMessageMock,
  };
});

vi.mock('./chat/SessionActionFeedback', () => ({
  showSessionActionFeedback: showSessionActionFeedbackMock,
}));

vi.mock('../lib/client', () => ({
  client: {
    session: {
      get: vi.fn(async () => {
        throw new Error('Session not found');
      }),
      list: vi.fn(async () => ({ items: [], hasMore: false })),
      messages: vi.fn(async () => []),
    },
    varro: {
      session: {
        diffSummary: vi.fn(async () => ({
          files: 0,
          additions: 0,
          deletions: 0,
          tokens: 0,
          durationMs: 0,
          activeStartedAt: null,
        })),
      },
      resolveJudgeModel: vi.fn(async () => null),
      resolveWorkspacePath: vi.fn(async (path: string) => {
        if (path === 'README.md') {
          return { path: '/repo/README.md', relativePath: 'README.md', type: 'file' as const };
        }
        if (path === 'src/app.ts') {
          return { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' as const };
        }
        if (path === 'docs') {
          return { path: '/repo/docs', relativePath: 'docs', type: 'directory' as const };
        }
        return null;
      }),
    },
  },
  serverEvents: {
    on: serverEventsOnMock,
  },
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
const testDiffOverlayOwner = Symbol();
let defaultBridgeSend: ((message: WebviewMessage) => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver implements globalThis.ResizeObserver {
    observe(_target: Element, _options?: ResizeObserverOptions) {}
    unobserve(_target: Element) {}
    disconnect() {}
  };
  defaultBridgeSend = (message) => {
    if (message.type !== 'queued-messages/claim') return;
    queueMicrotask(() =>
      applyQueuedMessageClaimResult({
        ...message.payload,
        granted: true,
        lease: message.payload.requestId,
      })
    );
  };
  fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
    defaultBridgeSend;
  setConnectionInitialized(true);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
  if (bridgeWindow.__sendToExtension === defaultBridgeSend) delete bridgeWindow.__sendToExtension;
  defaultBridgeSend = undefined;
  Reflect.deleteProperty(
    fixture<{ __initialWebviewState?: unknown }>(window),
    '__initialWebviewState'
  );
  setInputText('');
  setConnectionInitialized(false);
  setIsLoading(false);
  setShowChangedFiles(false);
  setShowModelPicker(false);
  setState('activeSessionId', null);
  setState('messagesLoading', false);
  setState('messages', []);
  setState('sessions', []);
  setState('questions', []);
  setState('permissions', []);
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  setState('providerDefaults', {});
  setState('selectedAgent', null);
  setState('selectedModel', null);
  setState('sessionSelectedModels', reconcile({}));
  setState('modelVariantSelections', {});
  setState('providerLimits', {});
  setState('mcpStatus', {});
  setState('sessionStatus', reconcile({}));
  setState('failedSessionIds', []);
  setState('sessionUsageLimits', {});
  setState('sessionPermissionModes', {});
  setState('sessionAutoPermissionActivity', {});
  setState('clipboardImages', []);
  setState('nativePdfs', []);
  resetPastedImageIndex();
  setState('droppedFiles', []);
  setState('terminalSelection', null);
  setState('attachedDiagnostics', null);
  setState('editorContext', {
    workspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
  });
  setState('queuedMessages', []);
  setState('queuedMessageDispatchingId', null);
  setState('failedQueuedMessageIds', []);
  setQueuedMessageEdit(null);
  setState('todos', []);
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  setSessionHistoryPrompts('session-1', []);
  resetMessageEditState();
  sendMessageMock.mockReset();
  loadOlderSessionPromptsMock.mockReset();
  loadOlderSessionPromptsMock.mockResolvedValue(false);
  serverEventHandlers.clear();
  serverEventsOnMock.mockClear();
  runSlashCommandByNameMock.mockReset();
  runSlashCommandByNameMock.mockResolvedValue(true);
  abortSessionMock.mockReset();
  continueInterruptedSessionMock.mockReset();
  editMessageMock.mockReset();
  editMessageMock.mockResolvedValue(true);
  forkSessionMock.mockReset();
  forkSessionMock.mockResolvedValue('forked-session');
  redoSessionMock.mockReset();
  showSessionActionFeedbackMock.mockReset();
  undoSessionMock.mockReset();
  vi.mocked(client.varro.session.diffSummary).mockReset();
  vi.mocked(client.varro.session.diffSummary).mockResolvedValue({
    files: 0,
    additions: 0,
    deletions: 0,
    tokens: 0,
    durationMs: 0,
    activeStartedAt: null,
  });
  vi.mocked(client.varro.resolveWorkspacePath).mockClear();
  vi.mocked(client.session.list).mockReset();
  vi.mocked(client.session.list).mockResolvedValue({ items: [], hasMore: false });
  vi.mocked(client.session.get).mockReset();
  vi.mocked(client.session.get).mockRejectedValue(new Error('Session not found'));
  vi.mocked(client.session.messages).mockReset();
  vi.mocked(client.session.messages).mockResolvedValue([]);
  setExpandedDiffOverlay(testDiffOverlayOwner, false);
});

function setupModelState() {
  setState('providers', [
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'api',
      models: {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          limit: { context: 1000, output: 1000 },
        },
      },
    },
  ]);
  setState('providerDefaults', { openai: 'gpt-4o' });
  setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
}

function setupRetryingProviderSwitchState() {
  setupModelState();
  setState('activeSessionId', 'session-1');
  setState('sessions', [session('session-1', 2_000)]);
  setState('providers', [
    ...state.providers,
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'api',
      models: {
        claude: {
          id: 'claude',
          name: 'Claude',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          limit: { context: 1000, output: 1000 },
        },
      },
    },
  ]);
  setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
  setState('sessionStatus', {
    'session-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
  });
  setState('sessionUsageLimits', {
    'session-1': {
      source: 'status',
      statusCode: 429,
      message: 'messages exhausted · retry in 408s · attempt #9',
      unit: 'messages',
      retryAt: 408_000,
      attempt: 9,
      sessionID: 'session-1',
      providerID: 'openai',
      modelID: 'gpt-4o',
    },
  });
}

function assistantMessageEntry(tokens: { input: number; output: number }) {
  return {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant' as const,
      time: { created: 0 },
      parentID: 'user-1',
      modelID: 'gpt-4o',
      providerID: 'openai',
      mode: 'default',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
}

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    ...overrides,
  };
}

function readContextRows(section: Element | undefined) {
  return Object.fromEntries(
    [...(section?.nextElementSibling?.querySelectorAll('.context-popup-row') || [])].map((row) => [
      row.querySelector('.context-popup-row-label')?.textContent,
      row.querySelector('.context-popup-row-value')?.textContent,
    ])
  );
}

// Mention resolution awaits one lookup per mention and then a guarded
// attach/withdraw step, so the chain is several ticks deep for a multi-mention
// paste. Drain generously rather than tuning per call site.
async function flushAsyncWork(count = 16) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function waitForDropdown() {
  await vi.waitFor(() => expect(container?.querySelector('.dropdown-menu')).not.toBeNull());
}

function createDragDataTransfer() {
  const values = new Map<string, string>();
  const types: string[] = [];
  // SAFETY: The fixture provides the unknown fields read by this statement.
  return fixture<DataTransfer>({
    types,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      values.set(type, value);
      if (!types.includes(type)) types.push(type);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
    setDragImage: vi.fn(),
  });
}

function dispatchDragEvent(target: Element, type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}

function dispatchImagePaste(target: Element, files: Array<File | null>, text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      items: files.map((file) => ({
        kind: 'file',
        type: file?.type || 'image/png',
        getAsFile: () => file,
      })),
    },
  });
  target.dispatchEvent(event);
  return event;
}

function installControllableFileReader() {
  const originalFileReader = globalThis.FileReader;
  const pendingReads = new Map<string, { resolve: () => void; reject: () => void }>();

  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;
    private loadListener: (() => void) | undefined;
    private errorListener: (() => void) | undefined;

    addEventListener(type: string, listener: () => void) {
      if (type === 'load') this.loadListener = listener;
      if (type === 'error') this.errorListener = listener;
    }

    readAsDataURL(file: File) {
      pendingReads.set(file.name, {
        resolve: () => {
          this.result = `data:${file.type};base64,${file.name}`;
          this.loadListener?.();
        },
        reject: () => {
          this.error = new DOMException(`Failed to read ${file.name}`);
          this.errorListener?.();
        },
      });
    }
  }

  // SAFETY: The fixture provides the unknown fields read by this statement.
  globalThis.FileReader = fixture<typeof FileReader>(MockFileReader);
  return {
    resolve(filename: string) {
      const pending = pendingReads.get(filename);
      if (!pending) throw new Error(`No pending FileReader for ${filename}`);
      pendingReads.delete(filename);
      pending.resolve();
    },
    reject(filename: string) {
      const pending = pendingReads.get(filename);
      if (!pending) throw new Error(`No pending FileReader for ${filename}`);
      pendingReads.delete(filename);
      pending.reject();
    },
    restore() {
      globalThis.FileReader = originalFileReader;
    },
  };
}

function emitServerEvent(type: string, properties: UnknownRecord) {
  for (const handler of serverEventHandlers.get(type) ?? []) {
    handler({ type, properties });
  }
}

function setCollapsedSelection(target: Node, offset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(target, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function availableProviderLimit(
  overrides?: Partial<ProviderLimitStatus & { status: 'available' }>
) {
  return {
    providerID: 'openai',
    modelID: 'gpt-4o',
    status: 'available' as const,
    source: 'provider' as const,
    checkedAt: 1,
    windows: [
      {
        id: 'five_hour',
        label: '5-Hour Limit',
        unit: 'requests' as const,
        remaining: 39,
        limit: 100,
        resetAt: null,
      },
    ],
    ...overrides,
  };
}

describe('ChatInput', () => {
  it('attaches PDFs picked by the extension', async () => {
    setupModelState();
    cleanup = render(() => ChatInput(), container!);
    const pdf = {
      id: 'pdf-1',
      url: 'data:application/pdf;base64,JVBERi0xCg==',
      mime: 'application/pdf' as const,
      filename: 'spec.pdf',
      size: 7,
      contextFile: { path: '/repo/spec.pdf', relativePath: 'spec.pdf', type: 'file' as const },
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'pdfs/picked', payload: [pdf] },
      })
    );
    await Promise.resolve();

    expect(state.nativePdfs).toMatchObject([pdf]);
    expect(container?.textContent).toContain('spec.pdf');
    const pdfChip = container?.querySelector('.chat-attachment-chip');
    expect(pdfChip).toBeInstanceOf(HTMLElement);
    expect(pdfChip?.textContent).not.toContain('PDF');

    setState('providers', 0, 'models', 'pdf-model', {
      id: 'pdf-model',
      name: 'PDF Model',
      capabilities: {
        input: { text: true, audio: false, image: false, video: false, pdf: true },
      },
      cost: { input: 0, output: 0 },
    });
    setState('selectedModel', { providerID: 'openai', modelID: 'pdf-model' });
    expect(pdfChip?.textContent).toContain('PDF');

    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    expect(pdfChip?.textContent).not.toContain('PDF');
  });

  it('hides pre-input status blocks while a diff overlay is expanded', () => {
    setState('todos', [
      { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'medium' },
    ]);
    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.todo-block')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.chat-input-shell')).toBeInstanceOf(HTMLElement);

    setExpandedDiffOverlay(testDiffOverlayOwner, true);

    expect(container?.querySelector('.todo-block')).toBeNull();
    expect(container?.querySelector('.chat-input-shell')).toBeInstanceOf(HTMLElement);

    setExpandedDiffOverlay(testDiffOverlayOwner, false);

    expect(container?.querySelector('.todo-block')).toBeInstanceOf(HTMLElement);
  });

  it('collapses an expanded diff overlay when sending a message', async () => {
    const collapse = vi.fn(() => setExpandedDiffOverlay(testDiffOverlayOwner, false));
    setExpandedDiffOverlay(testDiffOverlayOwner, true, collapse);
    setState('activeSessionId', 'session-1');
    setInputText('Continue with this change');
    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(collapse).toHaveBeenCalledTimes(1);
    expect(hasExpandedDiffOverlay()).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith('Continue with this change', { noReply: false });
  });

  it('keeps sending disabled until initial message hydration completes', async () => {
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);
    setInputText('Send after hydration');
    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(true);
    sendButton?.click();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setState('messagesLoading', false);
    await flushAsyncWork();

    expect(sendButton?.disabled).toBe(false);
  });

  it('sends at most 20 dropped content files in individual messages', async () => {
    const originalFileReader = globalThis.FileReader;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const readFiles: File[] = [];
    const sent: WebviewMessage[] = [];

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      private loadListener: (() => void) | undefined;

      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.loadListener = listener;
      }

      readAsDataURL(file: File) {
        readFiles.push(file);
        this.result = 'data:application/octet-stream;base64,';
        this.loadListener?.();
      }
    }

    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.FileReader = fixture<typeof FileReader>(MockFileReader);
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      // SAFETY: The fixture provides the File[] fields read by this statement.
      const files = Array.from({ length: 21 }, (_, index) => ({
        name: `file-${index}.txt`,
        size: 0,
      })) as File[];

      await sendDroppedContent(files);

      expect(readFiles).toHaveLength(20);
      expect(sent).toHaveLength(20);
      expect(
        sent.every(
          (message) => message.type === 'files/drop-content' && message.payload.files.length === 1
        )
      ).toBe(true);
    } finally {
      globalThis.FileReader = originalFileReader;
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('rejects per-file and aggregate dropped content limits before FileReader work', async () => {
    const originalFileReader = globalThis.FileReader;
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const readFiles: File[] = [];
    const sent: WebviewMessage[] = [];

    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      private loadListener: (() => void) | undefined;

      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.loadListener = listener;
      }

      readAsDataURL(file: File) {
        readFiles.push(file);
        this.result = 'data:application/octet-stream;base64,QQ==';
        this.loadListener?.();
      }
    }

    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.FileReader = fixture<typeof FileReader>(MockFileReader);
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      const tenMiB = 10 * 1024 * 1024;
      // SAFETY: The fixture provides the File[] fields read by this statement.
      const files = [
        { name: 'oversized.bin', size: tenMiB + 1 },
        ...Array.from({ length: 6 }, (_, index) => ({
          name: `part-${index}.bin`,
          size: tenMiB,
        })),
      ] as File[];

      await sendDroppedContent(files);

      expect(readFiles.map((file) => file.name)).toEqual([
        'part-0.bin',
        'part-1.bin',
        'part-2.bin',
        'part-3.bin',
        'part-4.bin',
      ]);
      expect(sent).toHaveLength(5);
    } finally {
      globalThis.FileReader = originalFileReader;
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('renders while loading before the current model memo is initialized', () => {
    setInputText('Ask the sub-agent');
    setIsLoading(true);

    expect(() => {
      cleanup = render(() => ChatInput(), container!);
    }).not.toThrow();
  });

  it('runs /stats without sending a chat message', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    setInputText('/stats');

    try {
      cleanup = render(() => ChatInput(), container!);
      container
        ?.querySelector<HTMLDivElement>('.rich-composer')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushAsyncWork();

      expect(sent).toContainEqual({
        type: 'usage/report',
        payload: { includeAllTime: false },
      });
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('shows an active hidden session model without falling back to the first visible model', () => {
    setState('providers', [
      {
        id: 'zai-coding-plan',
        name: 'Z.AI Coding Plan',
        source: 'api',
        models: {
          'glm-5.2': {
            id: 'glm-5.2',
            name: 'GLM-5.2',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5.6-luna': {
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            variants: { max: {} },
          },
        },
      },
    ]);
    setState('providerDefaults', { 'zai-coding-plan': 'glm-5.2' });
    setState('hiddenModels', ['openai:gpt-5.6-luna']);
    setState('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
      variant: 'max',
    });

    cleanup = render(() => ChatInput(), container!);

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(modelButton?.textContent).toContain('GPT-5.6 Luna');
    expect(modelButton?.textContent).not.toContain('GLM-5.2');
  });

  it('uses the busy placeholder while a child session is still working', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Root session',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/workspace',
        title: 'Research child',
        version: '1',
        parentID: 'session-1',
        time: { created: 1, updated: 11 },
      },
    ] satisfies Session[]);
    setState('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'busy' },
    });

    cleanup = render(() => ChatInput(), container!);
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    setState('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Describe what to build'
    );
  });

  it('links to the Varro repository when no status metadata is available', () => {
    setState('activeSessionId', null);
    setState('mcpStatus', {});
    setState('lspStatus', []);
    setState('providerLimits', {});
    cleanup = render(() => ChatInput(), container!);

    const repositoryLink = container?.querySelector<HTMLAnchorElement>('.toolbar-repository-link');
    expect(repositoryLink?.href).toBe(packageJson.repository);
    expect(repositoryLink?.textContent).toBe(`v${packageJson.version}`);
    expect(repositoryLink?.getAttribute('aria-label')).toBe(
      `Varro v${packageJson.version} on GitHub`
    );
  });

  it('shows configured MCPs and toggles the picker', async () => {
    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-mcp-count')).toBeNull();

    setState('mcpStatus', {
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'connected' },
      delta: { status: 'failed' },
    });

    const mcpCount = container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count');
    expect(mcpCount?.textContent).toContain('MCPs:');
    expect(mcpCount?.textContent).toContain('2/4');
    expect(mcpCount?.getAttribute('aria-label')).toBe('2 of 4 MCPs enabled');
    expect(mcpCount?.querySelector('.toolbar-mcp-count-separator')?.textContent).toBe('/');

    mcpCount?.click();
    await waitForDropdown();

    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('alpha');
    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('gamma');

    mcpCount?.click();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();

    mcpCount?.click();
    await waitForDropdown();

    document.body.click();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();

    setState('mcpStatus', {
      alpha: { status: 'failed' },
      beta: { status: 'needs_auth' },
      gamma: { status: 'failed' },
      delta: { status: 'disabled' },
    });
    expect(container?.querySelector('.toolbar-mcp-count')?.textContent).toContain('0/4');

    setState('mcpStatus', {
      alpha: { status: 'disabled' },
      beta: { status: 'disabled' },
      gamma: { status: 'disabled' },
      delta: { status: 'disabled' },
    });
    const disconnectedCount = container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count');
    expect(disconnectedCount?.textContent).toContain('0/4');
  });

  it('hides the MCP control while editing a message', async () => {
    setState('activeSessionId', 'session-1');
    setState('mcpStatus', {
      alpha: { status: 'disabled' },
    });
    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-mcp-count')).not.toBeNull();

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    await Promise.resolve();

    expect(container?.querySelector('.toolbar-mcp-count')).toBeNull();
  });

  it('shows one MCP count when every available MCP is enabled', () => {
    setState('mcpStatus', { alpha: { status: 'connected' } });
    const availableNames = Object.keys(state.mcpStatus);
    setState('draftSelectedMcps', availableNames);
    cleanup = render(() => ChatInput(), container!);

    const mcpValue = container?.querySelector('.toolbar-mcp-count-value');
    expect(mcpValue?.textContent).toBe(String(availableNames.length));
    expect(mcpValue?.textContent).not.toContain('/');
    expect(mcpValue?.querySelector('.toolbar-mcp-count-separator')).toBeNull();
  });

  it('shows active LSPs before MCPs and opens a read-only list', async () => {
    setState('mcpStatus', { docs: { status: 'connected' } });
    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-lsp-count')).toBeNull();

    setState('lspStatus', [
      { id: 'typescript', name: 'TypeScript', root: '/repo', status: 'connected' },
      { id: 'oxlint', name: 'Oxlint', root: '/repo', status: 'connected' },
    ]);

    const lspCount = container?.querySelector<HTMLButtonElement>('.toolbar-lsp-count');
    expect(lspCount?.textContent).toContain('LSPs:');
    expect(lspCount?.textContent).toContain('2');
    expect(lspCount?.getAttribute('aria-label')).toContain('Oxlint, TypeScript');
    expect(
      Array.from(container?.querySelectorAll('.toolbar-lsp-count, .toolbar-mcp-count') ?? []).map(
        (element) => element.className
      )
    ).toEqual(['toolbar-lsp-count', 'toolbar-mcp-count']);

    lspCount?.click();
    await waitForDropdown();

    const dropdown = container?.querySelector('.dropdown-menu');
    expect(dropdown?.textContent).toContain('LSPs');
    expect(dropdown?.textContent).toContain('Oxlint');
    expect(dropdown?.textContent).toContain('TypeScript');
    expect(dropdown?.querySelectorAll('.lsp-picker-item')).toHaveLength(2);
    expect(dropdown?.querySelector('button')).toBeNull();
  });

  it('shows all available provider-limit windows under the fixed threshold', () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 41,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const chip = container?.querySelector('.toolbar-limit-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('41%');
    expect(chip?.textContent).toContain('80%');
  });

  it('shows Z.ai MCP quota only in provider limit popup details', async () => {
    setState('providers', [
      {
        id: 'zai-coding-plan',
        name: 'Z.AI Coding Plan',
        source: 'api',
        models: {
          'glm-4.5': {
            id: 'glm-4.5',
            name: 'GLM-4.5',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { 'zai-coding-plan': 'glm-4.5' });
    setState('selectedModel', { providerID: 'zai-coding-plan', modelID: 'glm-4.5' });
    setState('providerLimits', {
      'zai-coding-plan:glm-4.5': {
        providerID: 'zai-coding-plan',
        modelID: 'glm-4.5',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5 Hours Quota',
            unit: 'unknown',
            remaining: 87,
            limit: 100,
            resetAt: null,
            percent: 13,
          },
          {
            id: 'weekly',
            label: 'Weekly Quota',
            unit: 'unknown',
            remaining: 98,
            limit: 100,
            resetAt: null,
            percent: 2,
          },
          {
            id: 'mcp',
            label: 'MCP Quota',
            unit: 'unknown',
            remaining: 1_000,
            limit: 1_000,
            resetAt: null,
            percent: 0,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const chip = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(chip?.textContent).toContain('87%');
    expect(chip?.textContent).toContain('98%');
    expect(chip?.textContent).not.toContain('100%');

    chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const popup = container?.querySelector('.provider-limit-popup');
    expect(popup?.textContent).toContain('5 Hours Quota');
    expect(popup?.textContent).toContain('Weekly Quota');
    expect(popup?.textContent).toContain('MCP Quota');
    expect(popup?.textContent).toContain('87/100 left');
    expect(popup?.textContent).toContain('98/100 left');
    expect(popup?.textContent).toContain('1,000/1,000 left');
  });

  it('filters provider-limit badges for the selected model', () => {
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'spark_five_hour',
            label: '5-Hour Spark Limit',
            unit: 'requests',
            remaining: 10,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'month',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const chip = container?.querySelector('.toolbar-limit-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('39%');
    expect(chip?.textContent).toContain('80%');
    expect(chip?.textContent).not.toContain('10%');
  });

  it('shows provider-limit UI for a monthly-only Copilot-style limit', () => {
    setState('providers', [
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        source: 'api',
        models: {
          'gpt-5-mini': {
            id: 'gpt-5-mini',
            name: 'GPT-5 mini',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { 'github-copilot': 'gpt-5-mini' });
    setState('selectedModel', { providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    setState('providerLimits', {
      'github-copilot:gpt-5-mini': {
        providerID: 'github-copilot',
        modelID: 'gpt-5-mini',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        windows: [
          {
            id: 'chat',
            label: 'Monthly Chat',
            unit: 'messages',
            remaining: 12,
            limit: 20,
            resetAt: null,
          },
        ],
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('Limits:');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('60%');
  });

  it('keeps the selected provider-limit window after limit refreshes', async () => {
    setupModelState();
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        checkedAt: 1,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'seven_day',
            label: 'Weekly All-Model',
            unit: 'requests',
            remaining: 30,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'monthly_limit',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 80,
            limit: 100,
            resetAt: null,
          },
        ],
      }),
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('80%');

    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        checkedAt: 2,
        windows: [
          {
            id: 'five_hour',
            label: '5-Hour Limit',
            unit: 'requests',
            remaining: 39,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'seven_day',
            label: 'Weekly All-Model',
            unit: 'requests',
            remaining: 30,
            limit: 100,
            resetAt: null,
          },
          {
            id: 'monthly_limit',
            label: 'Monthly Limit',
            unit: 'requests',
            remaining: 1,
            limit: 100,
            resetAt: null,
          },
        ],
      }),
    });
    await Promise.resolve();

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('1%');
  });

  it('shows context usage before assistant tokens are available', async () => {
    setupModelState();
    setState('providers', 0, 'models', 'gpt-4o', 'name', 'GPT-5.6 Fast');
    setState('activeSessionId', 'session-1');
    setState('messages', [assistantMessageEntry({ input: 0, output: 0 })]);

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.chat-context-usage');
    expect(button?.getAttribute('aria-label')).toBe('Context usage unavailable');
    expect(button?.getAttribute('title')).toBeNull();

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.context-popup-pct')?.textContent).toBe('--');
    expect(container?.querySelector('.context-popup-pct')?.classList).toContain('unavailable');
    expect(container?.querySelector('.context-popup-stat')?.textContent).toBe('--/1,000tokens');
    expect(container?.querySelector('.context-popup-model')?.textContent).toBe(
      'OpenAI / GPT-5.6 Fast'
    );

    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    await Promise.resolve();

    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');
    expect(container?.querySelector('.context-popup-pct')?.textContent).toBe('50%');
    expect(container?.querySelector('.context-popup-stat')?.textContent).toBe('500/1,000tokens');
    expect(container?.querySelector('.context-popup-breakdown-title')?.textContent).toBe(
      'Context Breakdown'
    );
    expect(container?.querySelector('.context-breakdown-nested')).toBeNull();
    expect(container?.querySelector('.context-breakdown-item')?.textContent).toBe('Other100.0%');
  });

  it('hides context usage before a new session starts', () => {
    setupModelState();

    cleanup = render(() => ChatInput({ newSession: true }), container!);

    expect(container?.querySelector('.chat-context-usage')).toBeNull();
  });

  it('keeps the context button accessible while the popup is open', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.chat-context-usage');
    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.context-popup')).not.toBeNull();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');
  });

  it('includes descendant session snapshots in the session token total', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, {
        parentID: 'session-1',
        tokens: {
          input: 500,
          output: 100,
          reasoning: 0,
          cache: { read: 50, write: 0 },
        },
      }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sections = [...(container?.querySelectorAll('.context-popup-section') || [])];
    expect(sections.map((section) => section.textContent)).toEqual([
      'Session Tokens',
      'Agents (1)650',
    ]);
    expect(readContextRows(sections[0])).toMatchObject({
      Input: '400',
      Output: '100',
      Total: '500',
    });
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const subagentToggle = sections[1] as HTMLButtonElement;
    expect(subagentToggle.getAttribute('aria-expanded')).toBe('false');
    expect(subagentToggle.children[1]?.classList.contains('context-popup-section-chevron')).toBe(
      true
    );
    expect(container?.querySelector('.context-popup-subagent-rows')).toBeNull();

    subagentToggle.click();
    await Promise.resolve();

    expect(subagentToggle.getAttribute('aria-expanded')).toBe('true');
    expect(subagentToggle.querySelector('.context-popup-section-summary')).toBeNull();
    expect(readContextRows(sections[1])).toMatchObject({
      Input: '500',
      Output: '100',
      'Cache read': '50',
      Total: '650',
    });
    expect(container?.querySelector('.context-popup-overall-total')?.textContent).toContain(
      'Overall1,150'
    );
  });

  it('shows unavailable root token details when only agents report usage', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, {
        parentID: 'session-1',
        tokens: {
          input: 500,
          output: 100,
          reasoning: 0,
          cache: { read: 50, write: 0 },
        },
      }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 0, output: 0 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sections = [...(container?.querySelectorAll('.context-popup-section') || [])];
    expect(sections.map((section) => section.textContent)).toEqual([
      'Session Tokens',
      'Agents (1)650',
    ]);
    const sessionSection = sections[0];
    if (!sessionSection) throw new Error('Expected session token section');
    expect(readContextRows(sessionSection)).toEqual({
      Input: '--',
      Output: '--',
      Total: '--',
    });
    expect(sessionSection.nextElementSibling?.querySelectorAll('.unavailable')).toHaveLength(3);
  });

  it('uses the root session snapshot when older messages are not loaded', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000, {
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 25 },
        },
      }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sessionSection = container?.querySelector('.context-popup-section');
    expect(readContextRows(sessionSection ?? undefined)).toEqual({
      Input: '1,000',
      Output: '200',
      Reasoning: '50',
      'Cache read': '100',
      'Cache write': '25',
      Total: '1,375',
    });
  });

  it('shows OpenCode session cost as a separate context detail row', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000, { cost: 0.01 })]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const costRow = container?.querySelector('.context-popup-cost-row');
    expect(costRow?.querySelector('.context-popup-row-label')?.textContent).toBe('Cost');
    expect(costRow?.querySelector('.context-popup-row-value')?.textContent).toBe('$0.01');
  });

  it('loads tokens for subagent sessions whose messages and snapshots are not loaded', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, { parentID: 'session-1' }),
    ]);
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    vi.mocked(client.varro.session.diffSummary).mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 1_400,
      tokenBreakdown: {
        session: {
          total: 500,
          input: 400,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        subagents: {
          total: 900,
          input: 700,
          output: 100,
          reasoning: 50,
          cacheRead: 50,
          cacheWrite: 0,
        },
        subagentCount: 1,
      },
      nestedContextBreakdown: [
        { key: 'tool', tokens: 700, percent: 50 },
        { key: 'other', tokens: 700, percent: 50 },
      ],
      durationMs: 0,
      activeStartedAt: null,
    });

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('.chat-context-usage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(container?.querySelector('.context-popup-section-toggle')?.textContent).toContain(
        'Agents (1)900'
      );
    });
    expect(client.varro.session.diffSummary).toHaveBeenCalledWith('session-1');

    const nested = container?.querySelector<HTMLInputElement>('.context-breakdown-nested input');
    expect(nested?.checked).toBe(true);
    expect(container?.querySelectorAll('.context-breakdown-checkbox')).toHaveLength(1);
    expect(container?.querySelector('.context-breakdown-checkbox-checked')).not.toBeNull();

    expect(
      [...(container?.querySelectorAll('.context-breakdown-item') || [])].map(
        (item) => item.textContent
      )
    ).toEqual(['Tool Calls50.0%', 'Other50.0%']);

    nested?.click();
    await Promise.resolve();

    expect(nested?.checked).toBe(false);
    expect(container?.querySelectorAll('.context-breakdown-checkbox')).toHaveLength(1);
    expect(container?.querySelector('.context-breakdown-checkbox-unchecked')).not.toBeNull();
    expect(
      [...(container?.querySelectorAll('.context-breakdown-item') || [])].map(
        (item) => item.textContent
      )
    ).toEqual(['Other100.0%']);
  });

  it('keeps the provider limit chip accessible while the popup is open', async () => {
    setupModelState();
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({ planName: 'Pro' }),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 39 / 100 left');
    expect(button?.getAttribute('title')).toBeNull();

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const popup = container?.querySelector('.provider-limit-popup');

    expect(popup).not.toBeNull();
    expect(popup?.querySelector('.provider-limit-popup-provider')?.textContent).toBe(
      'OpenAI · Pro'
    );
    expect(popup?.textContent).not.toContain('GPT-4o');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 39 / 100 left');
  });

  it('renders permission, context usage, and provider limits in the lower metadata row', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const shell = container?.querySelector('.chat-input-shell');
    const frame = container?.querySelector('.chat-input-container');
    const mainRow = container?.querySelector('.toolbar-main');
    const metaRow = container?.querySelector('.toolbar-meta');

    expect(frame?.contains(mainRow ?? null)).toBe(true);
    expect(frame?.contains(metaRow ?? null)).toBe(false);
    expect(shell?.contains(metaRow ?? null)).toBe(true);
    expect(mainRow?.querySelector('.chat-context-usage')).toBeNull();
    expect(mainRow?.querySelector('.toolbar-limit-chip')).toBeNull();
    expect(
      mainRow?.querySelector<HTMLButtonElement>('.permission-mode-button')?.textContent
    ).toBeFalsy();
    expect(metaRow?.querySelector('.chat-context-usage')).not.toBeNull();
    expect(metaRow?.querySelector('.toolbar-limit-chip')).not.toBeNull();
    expect(
      metaRow?.querySelector<HTMLButtonElement>('.permission-mode-button')?.textContent
    ).toContain('Default');
    expect(metaRow?.querySelector('.context-anchor')).not.toBeNull();
    expect(metaRow?.querySelector('.provider-limit-anchor')).not.toBeNull();
  });

  it('shows auto-approve activity across the active session tree', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setState('sessionPermissionModes', { 'session-1': 'auto' });
    setState('sessionAutoPermissionActivity', {
      'session-1': [{ permissionId: 'one', status: 'reviewing', title: 'one', createdAt: 2 }],
      'child-1': [{ permissionId: 'two', status: 'auto-approved', title: 'two', createdAt: 1 }],
    });

    cleanup = render(() => ChatInput(), container!);

    const dots = container?.querySelectorAll('.toolbar-meta .permission-activity-item') ?? [];
    expect(dots).toHaveLength(2);
    expect(dots[0]?.className).toContain('auto-approved');
    expect(dots[1]?.className).toContain('reviewing');
  });

  it('shows auto-approve activity only for the latest prompt', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setState('sessionPermissionModes', { 'session-1': 'auto' });
    setState('sessionAutoPermissionActivity', {
      'session-1': [
        { permissionId: 'old-root', status: 'auto-approved', title: 'old', createdAt: 2 },
      ],
      'child-1': [
        { permissionId: 'old-child', status: 'auto-approved', title: 'old', createdAt: 2 },
      ],
    });

    cleanup = render(() => ChatInput(), container!);
    expect(container?.querySelectorAll('.toolbar-meta .permission-activity-item')).toHaveLength(2);

    const latestPrompt = historyEntry('user-2', 'Next prompt');
    latestPrompt.info.time.created = 3;
    setState('messages', [latestPrompt]);
    expect(container?.querySelectorAll('.toolbar-meta .permission-activity-item')).toHaveLength(0);

    setState('sessionAutoPermissionActivity', 'child-1', [
      { permissionId: 'new-child', status: 'reviewing', title: 'new', createdAt: 4 },
    ]);
    const dots = container?.querySelectorAll('.toolbar-meta .permission-activity-item') ?? [];
    expect(dots).toHaveLength(1);
    expect(dots[0]?.className).toContain('reviewing');
  });

  it('uses the full composer controls and starts a new session only when sending', async () => {
    setupModelState();
    setState('activeSessionId', 'existing-session');
    setState('sessionStatus', { 'existing-session': { type: 'busy' } });
    setInputText('Build a fresh feature');
    setState('droppedFiles', [
      { path: '/repo/src/new.ts', relativePath: 'src/new.ts', type: 'file' },
    ]);
    const onBeforeSend = vi.fn(() => {
      setState('activeSessionId', null);
      setState('droppedFiles', []);
    });

    cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    editor?.focus();

    expect(container?.querySelector('.model-picker-btn')).not.toBeNull();
    expect(container?.querySelector('.permission-mode-button')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).not.toBeNull();
    expect(onBeforeSend).not.toHaveBeenCalled();

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('Build a fresh feature', {
      noReply: false,
      queuedAttachments: {
        droppedFiles: [
          {
            path: '/repo/src/new.ts',
            relativePath: 'src/new.ts',
            type: 'file',
            lineRanges: undefined,
            attachmentSequence: undefined,
          },
        ],
        clipboardImages: [],
        nativePdfs: [],
        terminalSelection: null,
      },
    });
  });

  it('preserves text entered while a normal send is pending', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    expect(inputText()).toBe('');

    setInputText('new draft while sending');
    resolveSend?.(false);
    await flushAsyncWork();

    expect(inputText()).toBe('new draft while sending');
  });

  it('does not restore a failed snapshot after the user edits the pending draft back to empty', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    cleanup = render(() => ChatInput(), container!);
    const editor = container?.querySelector<HTMLElement>('.rich-composer');

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    editor!.textContent = 'temporary draft';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    editor!.textContent = '';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(inputText()).toBe('');

    resolveSend?.(false);
    await flushAsyncWork();

    expect(inputText()).toBe('');
  });

  it('restores a failed draft even when consecutive errors have identical text', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('retry this prompt');
    sendMessageMock.mockResolvedValue(false);
    cleanup = render(() => ChatInput(), container!);

    const send = () =>
      container
        ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send();
    await flushAsyncWork();
    expect(inputText()).toBe('retry this prompt');

    send();
    await flushAsyncWork();
    expect(inputText()).toBe('retry this prompt');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('right-aligns the provider limit popup when no context is shown', async () => {
    setupModelState();
    const model = state.providers[0]?.models['gpt-4o'];
    if (!model) throw new Error('Expected GPT-4o fixture');
    const modelWithoutLimit = { ...model };
    delete modelWithoutLimit.limit;
    setState('providers', 0, 'models', 'gpt-4o', modelWithoutLimit);
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('right-aligns the provider limit popup when context is shown', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setState('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    cleanup = render(() => ChatInput(), container!);

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).not.toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('aligns the permission popup to the input frame left edge', async () => {
    setupModelState();

    cleanup = render(() => ChatInput(), container!);

    const frame = container?.querySelector<HTMLElement>('.chat-input-container');
    const button = container?.querySelector<HTMLButtonElement>('.permission-mode-button');

    expect(frame).not.toBeNull();
    expect(button).not.toBeNull();
    expect(button?.style.position).toBe('');

    const frameLeft = 24;
    const buttonLeft = 60;
    vi.spyOn(frame!, 'getBoundingClientRect').mockReturnValue({
      x: frameLeft,
      y: 0,
      top: 0,
      left: frameLeft,
      right: 320,
      bottom: 100,
      width: 296,
      height: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(button!, 'getBoundingClientRect').mockReturnValue({
      x: buttonLeft,
      y: 0,
      top: 0,
      left: buttonLeft,
      right: 120,
      bottom: 24,
      width: 60,
      height: 24,
      toJSON: () => ({}),
    });

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const popup = container?.querySelector<HTMLElement>('.toolbar-popover');
    expect(popup?.style.left).toBe('24px');
  });

  it('marks the input shell as hosting a floating popover while the model picker is open', async () => {
    setupModelState();
    setShowModelPicker(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.chat-input-shell')?.className).toContain(
      'showing-floating-popover'
    );
    await waitForDropdown();
  });

  it('uses distinct panel visibility modifiers for model and MCP pickers', () => {
    setupModelState();
    setShowChangedFiles(true);
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 1_000, {
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: 'src/app.ts', before: '', after: 'updated', additions: 1, deletions: 0 }],
        },
      }),
    ]);
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('queuedMessages', [
      { id: 'queue-1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);
    setState('todos', [
      { id: 'todo-1', content: 'Keep working', status: 'in_progress', priority: 'medium' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const inputPart = container?.querySelector('.interactive-input-part');
    const queue = container?.querySelector('.chat-queue-container');
    const todo = container?.querySelector('.todo-block:not(.changed-files-block)');
    const files = container?.querySelector('.changed-files-block');
    expect(queue).not.toBeNull();
    expect(todo).not.toBeNull();
    expect(files).not.toBeNull();

    setShowModelPicker(true);

    expect(inputPart?.classList.contains('model-picker-open')).toBe(true);
    expect(inputPart?.classList.contains('mcp-picker-open')).toBe(false);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);

    setShowModelPicker(false);
    setState('mcpStatus', { docs: { status: 'connected' } });
    container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count')?.click();

    expect(inputPart?.classList.contains('model-picker-open')).toBe(false);
    expect(inputPart?.classList.contains('mcp-picker-open')).toBe(true);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);
  });

  it('keeps queue, todo, and file panels mounted while the @ menu is open', async () => {
    setShowChangedFiles(true);
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 1_000, {
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: 'src/app.ts', before: '', after: 'updated', additions: 1, deletions: 0 }],
        },
      }),
    ]);
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('queuedMessages', [
      { id: 'queue-1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);
    setState('todos', [
      { id: 'todo-1', content: 'Keep working', status: 'in_progress', priority: 'medium' },
    ]);
    setState('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputText('@hel');

    cleanup = render(() => ChatInput(), container!);

    const inputPart = container?.querySelector('.interactive-input-part');
    const queue = container?.querySelector('.chat-queue-container');
    const todo = container?.querySelector('.todo-block:not(.changed-files-block)');
    const files = container?.querySelector('.changed-files-block');
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(queue).not.toBeNull();
    expect(todo).not.toBeNull();
    expect(files).not.toBeNull();
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');

    editor.focus();
    setCollapsedSelection(editor.firstChild, '@hel'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    await flushAsyncWork();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();
    expect(inputPart?.classList.contains('mention-completion-open')).toBe(true);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);

    setInputText('');
    await flushAsyncWork();

    expect(inputPart?.classList.contains('mention-completion-open')).toBe(false);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);
  });

  it.each([
    { trigger: '@', initial: '@hel', shortened: '@he' },
    { trigger: '&', initial: '&aut', shortened: '&au' },
    { trigger: '/', initial: '/zzv', shortened: '/zz' },
  ])('keeps the $trigger completion menu mounted on backspace', async ({ initial, shortened }) => {
    setState('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setState('sessions', [session('session-auth', 2_000, { title: 'Authentication' })]);
    setState('commands', [
      {
        name: 'zzvarrotest',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText(initial);

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, initial.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: initial.at(-1), bubbles: true }));
    await flushAsyncWork();

    const menu = container?.querySelector('.composer-completion-menu');
    expect(menu).not.toBeNull();

    editor.textContent = shortened;
    if (!editor.firstChild) throw new Error('Expected updated composer editor');
    setCollapsedSelection(editor.firstChild, shortened.length);
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
    );
    await flushAsyncWork();

    expect(inputText()).toBe(shortened);
    expect(container?.querySelector('.composer-completion-menu')).toBe(menu);
  });

  it.each(['&session-auth', '&sessions:session-auth'])(
    'looks up session titles from %s and inserts a session reference',
    async (lookup) => {
      vi.useFakeTimers();
      const result = session('session-auth', 2_000, { title: 'Investigate authentication' });
      vi.mocked(client.session.list).mockResolvedValue({ items: [result], hasMore: false });
      vi.mocked(client.session.get).mockResolvedValue(result);
      setInputText(lookup);

      cleanup = render(() => ChatInput(), container!);

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      setCollapsedSelection(editor.firstChild, lookup.length);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'h', bubbles: true }));
      await vi.advanceTimersByTimeAsync(120);
      await flushAsyncWork();

      expect(client.session.list).toHaveBeenCalledWith({
        limit: 30,
        search: 'session-auth',
        roots: true,
        signal: expect.any(AbortSignal),
      });
      if (lookup.startsWith('&sessions:')) {
        expect(client.session.get).toHaveBeenCalledWith('session-auth');
      }
      const item = container?.querySelector<HTMLButtonElement>('.completion-session');
      expect(item?.querySelector('.composer-completion-title')?.textContent).toBe(
        'Investigate authentication'
      );
      expect(item?.querySelector('.composer-completion-age')).not.toBeNull();

      item?.click();
      expect(inputText()).toBe('session:session-auth ');
      const reference = container?.querySelector<HTMLElement>(
        '.composer-session-reference[data-chip-type="mention-session"]'
      );
      expect(reference?.textContent).toBe('Investigate authentication');
      expect(reference?.dataset.chipId).toBeUndefined();
    }
  );

  it('selects a session completion on Enter for a bare ampersand', async () => {
    setState('sessions', [session('session-auth', 2_000, { title: 'Investigate authentication' })]);
    setInputText('Run both commands &');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, 'Run both commands &'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '&', bubbles: true }));
    await flushAsyncWork();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(inputText()).toBe('Run both commands session:session-auth ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('selects an agent completion on Enter without sending the message', async () => {
    setState('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputText('Ask @hel');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, 'Ask @hel'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    await flushAsyncWork();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(inputText()).toBe('Ask @helper ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('runs a parameterless slash completion on the first Enter', async () => {
    setState('commands', [
      {
        name: 'zzvarrotest',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText('/zzv');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, '/zzv'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    await flushAsyncWork();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(inputText()).toBe('');
    expect(container?.querySelector('.composer-completion-menu')).toBeNull();
    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('zzvarrotest', '');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('runs /stats from the completion menu on the first Enter', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    setInputText('/stat');

    try {
      cleanup = render(() => ChatInput(), container!);

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      setCollapsedSelection(editor.firstChild, '/stat'.length);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 't', bubbles: true }));
      await flushAsyncWork();

      expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      await flushAsyncWork();

      expect(inputText()).toBe('');
      expect(sent).toContainEqual({
        type: 'usage/report',
        payload: { includeAllTime: false },
      });
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('selects a parameterized slash completion without running it', async () => {
    setState('commands', [
      {
        name: 'zzvarrotest',
        description: 'Run matching tests',
        template: 'Run matching tests',
        hints: ['pattern'],
      },
    ]);
    setInputText('/zzv');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, '/zzv'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    await flushAsyncWork();

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(inputText()).toBe('/zzvarrotest');
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('resolves pasted session markers to titled links', async () => {
    const result = session('session-auth', 2_000, { title: 'Investigate authentication' });
    vi.mocked(client.session.get).mockResolvedValue(result);
    setInputText('Review session:session-auth');

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(client.session.get).toHaveBeenCalledWith('session-auth');
    await vi.waitFor(() =>
      expect(
        container?.querySelector<HTMLElement>(
          '.composer-session-reference[data-chip-type="mention-session"]'
        )
      ).not.toBeNull()
    );
    const reference = container?.querySelector<HTMLElement>(
      '.composer-session-reference[data-chip-type="mention-session"]'
    );
    expect(reference?.textContent).toBe('Investigate authentication');
    expect(reference?.dataset.chipMarker).toBe('session:session-auth');
  });

  it('renders HTTPS URLs as editable links without replacing their DOM while typing', () => {
    setInputText("What's this https://iconoir.com?");

    cleanup = render(() => ChatInput(), container!);

    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    if (!reference || !editor || !reference.firstChild) {
      throw new Error('Expected editable external link');
    }
    expect(reference?.textContent).toBe('https://iconoir.com');
    expect(container?.querySelector('.composer-external-link-icon')).toBeInstanceOf(
      HTMLImageElement
    );
    expect(reference?.dataset.chipMarker).toBeUndefined();
    expect(reference?.getAttribute('contenteditable')).toBeNull();
    expect(reference?.querySelector('.link-leading-content')?.textContent).toBe('h');
    expect(inputText()).toBe("What's this https://iconoir.com?");

    const trailingText = reference.nextSibling;
    if (!trailingText || trailingText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected trailing URL punctuation');
    }
    editor.focus();
    trailingText.textContent = '/1?';
    setCollapsedSelection(trailingText, 2);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(inputText()).toBe("What's this https://iconoir.com/1?");
    expect(container?.querySelector('.composer-external-link')).toBe(reference);
    expect(document.activeElement).toBe(editor);

    trailingText.textContent = '/12?';
    setCollapsedSelection(trailingText, 3);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(inputText()).toBe("What's this https://iconoir.com/12?");
    expect(container?.querySelector('.composer-external-link')).toBe(reference);
    expect(document.activeElement).toBe(editor);
  });

  it('escapes a URL into plain text when typing a trailing space', () => {
    setInputText('https://iconoir.com');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const linkText = reference?.lastChild;
    if (!editor || !linkText || linkText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected editable external link');
    }
    editor.focus();
    setCollapsedSelection(linkText, 'ttps://iconoir.com'.length);
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: ' ',
      })
    );

    expect(inputText()).toBe('https://iconoir.com ');
    const currentReference = container?.querySelector<HTMLElement>('.composer-external-link');
    expect(currentReference?.textContent).toBe('https://iconoir.com');
    expect(currentReference?.nextSibling?.textContent).toContain(' ');
    expect(document.activeElement).toBe(editor);
  });

  it("renders and acts on only this view owner's queue items from a broad snapshot", async () => {
    fixture<{ __initialWebviewState?: unknown }>(window).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-a',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'owned',
        ownerViewId: 'editor-a',
        sessionId: 'session-1',
        text: 'Owned follow-up',
        paused: true,
      },
      {
        id: 'other-view',
        ownerViewId: 'editor-b',
        sessionId: 'session-1',
        text: 'Other view follow-up',
      },
    ]);

    const sendToExtension = vi.fn(defaultBridgeSend);
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      sendToExtension;
    cleanup = render(() => ChatInput(), container!);

    expect(
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent)
    ).toEqual(['Owned follow-up']);

    await sendQueuedAsSteer(state.queuedMessages[1]!);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['owned', 'other-view']);

    syncQueuedMessages();
    expect(sendToExtension).toHaveBeenLastCalledWith({
      type: 'queued-messages/update',
      payload: {
        messages: [expect.objectContaining({ id: 'owned', ownerViewId: 'editor-a' })],
      },
    });
  });

  it('queues busy composer attachments and clears them from the input', () => {
    setInputText('Follow up with context');
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('selectedAgent', 'build');
    setState('droppedFiles', [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }]);
    setState('clipboardImages', [
      { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    cleanup = render(() => ChatInput(), container!);

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-queue-item')).not.toBeNull();
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]).not.toHaveProperty('messageId');
    expect(state.queuedMessages[0]).toMatchObject({
      text: 'Follow up with context',
      agent: 'build',
      droppedFiles: [
        {
          path: '/repo/src/a.ts',
          relativePath: 'src/a.ts',
          type: 'file',
          attachmentSequence: undefined,
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

  it('keeps the active file selection visible on a queued message', async () => {
    setInputText('Test');
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/menus.css',
        relativePath: 'src/menus.css',
        language: 'css',
      },
      selection: { startLine: 6, endLine: 26 },
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton).not.toBeNull();
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.queuedMessages[0]?.droppedFiles).toEqual([
      {
        path: '/repo/src/menus.css',
        relativePath: 'src/menus.css',
        type: 'file',
        lineRanges: [{ startLine: 6, endLine: 26 }],
      },
    ]);
    expect(state.queuedMessages[0]?.queuedContext).toEqual({
      editorContext: {
        workspacePath: '/repo',
        activeFile: {
          path: '/repo/src/menus.css',
          relativePath: 'src/menus.css',
          language: 'css',
        },
        selection: { startLine: 6, endLine: 26 },
        diagnostics: [],
      },
      currentDocumentEnabled: true,
    });
    expect(container?.querySelector('.chat-queue-meta-item')?.getAttribute('aria-label')).toBe(
      '1 attachment'
    );
  });

  it('dispatches a queued message on authoritative idle without waiting for a timer', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('selectedAgent', 'plan');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Implement the plan',
        agent: 'build',
      },
    ]);

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setIsLoading(false);
    await flushAsyncWork();
    expect(sendMessageMock).not.toHaveBeenCalled();

    for (const handler of serverEventHandlers.get('session.status') ?? []) {
      handler({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      });
    }
    setState('sessionStatus', 'session-1', { type: 'idle' });
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Implement the plan', {
      messageId: expect.stringMatching(/^msg_/),
      agent: 'build',
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it('does not dispatch queued messages after an API failure', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'Do not send after failure' },
    ]);

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    setState('failedSessionIds', ['session-1']);
    setState('sessionStatus', 'session-1', { type: 'idle' });
    setIsLoading(false);
    for (const eventType of ['session.status', 'session.idle']) {
      for (const handler of serverEventHandlers.get(eventType) ?? []) {
        const properties: SessionEventProperties = {
          sessionID: 'session-1',
        };
        if (eventType === 'session.status') properties.status = { type: 'idle' };
        handler({
          type: eventType,
          properties,
        });
      }
    }
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);

    setState('failedSessionIds', []);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches a queued message for an idle background session', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-2', text: 'Continue in the background' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Continue in the background', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-2',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.activeSessionId).toBe('session-1');
    expect(state.queuedMessages).toEqual([]);
  });

  it('removes a restored queued prompt that OpenCode already admitted', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'idle' });
    setState('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_admitted',
        sessionId: 'session-1',
        text: 'Already admitted',
      },
    ]);
    vi.mocked(client.session.messages).mockResolvedValue([
      {
        info: {
          id: 'msg_admitted',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        },
        parts: [],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageDispatchingId).toBeNull();
  });

  it('retains an attempted queued message when admission history cannot be read', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'idle' });
    setState('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_ambiguous',
        sessionId: 'session-1',
        text: 'Keep this prompt',
      },
    ]);
    vi.mocked(client.session.messages).mockRejectedValue(new Error('History unavailable'));

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        id: 'q1',
        messageId: 'msg_ambiguous',
        text: 'Keep this prompt',
      }),
    ]);
    expect(state.failedQueuedMessageIds).toContain('q1');
  });

  it('does not resend an admitted queued message found on an older history page', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'idle' });
    setState('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_admitted',
        sessionId: 'session-1',
        text: 'Already admitted',
      },
    ]);
    // SAFETY: Session message pages are arrays with optional cursor metadata.
    const firstPage = [] as Awaited<ReturnType<typeof client.session.messages>>;
    firstPage.nextCursor = 'cursor-older';
    vi.mocked(client.session.messages)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        {
          info: {
            id: 'msg_admitted',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
          },
          parts: [],
        },
      ]);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(client.session.messages).toHaveBeenNthCalledWith(1, 'session-1', {
      limit: 200,
      before: undefined,
    });
    expect(client.session.messages).toHaveBeenNthCalledWith(2, 'session-1', {
      limit: 200,
      before: 'cursor-older',
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([]);
  });

  it('groups queued rows with separate attachment and image metadata', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Queued follow-up',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      { id: 'q2', sessionId: 'session-1', text: 'Another follow-up' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const meta = container?.querySelector('.chat-queue-meta');
    const metaItems = Array.from(container?.querySelectorAll('.chat-queue-meta-item') || []);
    const queueRows = Array.from(
      container?.querySelectorAll<HTMLElement>('.chat-queue-item') || []
    );
    expect(container?.querySelector('.chat-queue-summary')).toBeNull();
    expect(metaItems.map((item) => item.textContent)).toEqual(['1', '2']);
    expect(metaItems.map((item) => item.getAttribute('aria-label'))).toEqual([
      '1 image',
      '2 attachments',
    ]);
    expect(meta?.closest('.chat-queue-actions')).toBeNull();
    expect(container?.querySelector('.chat-queue-image-icon')).not.toBeNull();
    expect(container?.querySelector('.chat-queue-attachment-icon')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Send as Steer"]')?.textContent).toBe('');
    expect(container?.querySelectorAll('.chat-queue-control')).toHaveLength(10);
    expect(queueRows.map((row) => row.dataset.queuedMessageId)).toEqual(['q1', 'q2']);
    expect(queueRows.map((row) => row.dataset.queuedMessageOwner)).toEqual(['sidebar', 'sidebar']);
    expect(queueRows.map((row) => row.dataset.queuedMessageSessionId)).toEqual([
      'session-1',
      'session-1',
    ]);
  });

  it('sets a native title only when a queued message label is truncated', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Queued follow-up' }]);

    cleanup = render(() => ChatInput(), container!);

    const row = container?.querySelector('.chat-queue-item');
    const label = container?.querySelector('.chat-queue-label');
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 100 });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: 100 });

    label?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(label?.getAttribute('title')).toBeNull();

    Object.defineProperty(label, 'clientWidth', { configurable: true, value: 50 });
    label?.dispatchEvent(new MouseEvent('mouseenter'));

    expect(label?.getAttribute('title')).toBe('Queued follow-up');
    expect(row?.getAttribute('title')).toBeNull();
  });

  it('pauses queued rows individually and toggles all session rows with Alt-click', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'other', sessionId: 'session-2', text: 'other session' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const firstRow = container?.querySelector<HTMLElement>('.chat-queue-item');
    const actions = firstRow?.querySelector<HTMLElement>('.chat-queue-actions');
    const actionButtons = Array.from(actions?.querySelectorAll('button') || []);
    const pauseButton = actions?.querySelector<HTMLButtonElement>(
      '[aria-label="Pause queued message"]'
    );
    const pauseIcon = pauseButton?.firstElementChild;

    pauseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.queuedMessages.find((item) => item.id === 'q1')?.paused).toBe(true);
    expect(state.queuedMessages.find((item) => item.id === 'q2')?.paused).toBeUndefined();
    expect(state.queuedMessages.find((item) => item.id === 'other')?.paused).toBeUndefined();
    expect(container?.querySelectorAll('.chat-queue-item.is-paused')).toHaveLength(1);
    expect(container?.querySelector('.chat-queue-paused-label')?.textContent).toBe('Paused');
    expect(container?.querySelector('.chat-queue-item')).toBe(firstRow);
    expect(firstRow?.querySelector('.chat-queue-actions')).toBe(actions);
    expect(Array.from(actions?.querySelectorAll('button') || [])).toEqual(actionButtons);
    expect(pauseButton?.firstElementChild).not.toBe(pauseIcon);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Pause queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(
      state.queuedMessages
        .filter((item) => item.sessionId === 'session-1')
        .every((item) => item.paused)
    ).toBe(true);
    expect(state.queuedMessages.find((item) => item.id === 'other')?.paused).toBeUndefined();

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Play queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));

    expect(
      state.queuedMessages
        .filter((item) => item.sessionId === 'session-1')
        .every((item) => item.paused === undefined)
    ).toBe(true);
    expect(container?.querySelector('.chat-queue-item.is-paused')).toBeNull();
  });

  it('tracks hidden-scrollbar queue overflow at both edges', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState(
      'queuedMessages',
      Array.from({ length: 6 }, (_, index) => ({
        id: `q${index + 1}`,
        sessionId: 'session-1',
        text: `Queued follow-up ${index + 1}`,
      }))
    );

    cleanup = render(() => ChatInput(), container!);

    const list = container?.querySelector<HTMLElement>('.chat-queue-list');
    expect(list).not.toBeNull();
    Object.defineProperties(list!, {
      clientHeight: { configurable: true, value: 126 },
      scrollHeight: { configurable: true, value: 168 },
    });

    list!.scrollTop = 0;
    list!.dispatchEvent(new Event('scroll'));
    expect(list?.classList.contains('has-more-above')).toBe(false);
    expect(list?.classList.contains('has-more-below')).toBe(true);

    list!.scrollTop = 21;
    list!.dispatchEvent(new Event('scroll'));
    expect(list?.classList.contains('has-more-above')).toBe(true);
    expect(list?.classList.contains('has-more-below')).toBe(true);

    list!.scrollTop = 42;
    list!.dispatchEvent(new Event('scroll'));
    expect(list?.classList.contains('has-more-above')).toBe(true);
    expect(list?.classList.contains('has-more-below')).toBe(false);
  });

  it('reorders queued rows by dragging the left handle without showing the file-drop overlay', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message:"]'
    );
    const rows = container!.querySelectorAll<HTMLElement>('.chat-queue-item');
    const dataTransfer = createDragDataTransfer();

    expect(handles[0]?.draggable).toBe(true);
    dispatchDragEvent(handles[0]!, 'dragstart', dataTransfer);
    dispatchDragEvent(rows[1]!, 'dragover', dataTransfer);

    expect(rows[0]?.classList.contains('is-dragging')).toBe(true);
    expect(rows[1]?.classList.contains('is-drag-over')).toBe(true);
    expect(container?.querySelector('.chat-queue-container.is-reordering')).not.toBeNull();
    expect([...handles].map((handle) => handle.textContent?.trim())).toEqual(['1', '2', '3']);
    expect([...handles].every((handle) => handle.querySelector('svg') === null)).toBe(true);
    expect(document.querySelector('.chat-drop-overlay')).toBeNull();

    dispatchDragEvent(rows[1]!, 'drop', dataTransfer);
    dispatchDragEvent(handles[0]!, 'dragend', dataTransfer);

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2', 'q1', 'q3']);
    expect(
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent)
    ).toEqual(['second', 'first', 'third']);
    expect(container?.querySelector('.chat-queue-container.is-reordering')).toBeNull();
    expect(container?.querySelector('.chat-queue-position')).toBeNull();
    expect(
      [...container!.querySelectorAll('[aria-label^="Reorder queued message:"]')].every(
        (handle) => handle.querySelector('svg') !== null
      )
    ).toBe(true);
  });

  it('shows queue positions in the drag handles while Alt is held', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message:"]'
    );
    expect([...handles].every((handle) => handle.querySelector('svg') !== null)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));

    expect([...handles].map((handle) => handle.textContent?.trim())).toEqual(['1', '2', '3']);
    expect([...handles].every((handle) => handle.querySelector('svg') === null)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));

    expect(container?.querySelector('.chat-queue-position')).toBeNull();
    expect([...handles].every((handle) => handle.querySelector('svg') !== null)).toBe(true);
  });

  it('keeps an edited queue row visible and cancels editing from the row', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Revise this follow-up',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          {
            id: 'img-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'img.png',
            size: 1,
          },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(false);
    editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('Revise this follow-up');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      {
        id: 'img-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'img.png',
        size: 1,
      },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
    expect(container?.querySelector('.chat-queue-item.is-editing')).not.toBeNull();
    expect(container?.querySelector('.chat-queue-editing-label')?.textContent).toBe('Editing');
    const cancelButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel queued message edit"]'
    );
    expect(cancelButton?.disabled).toBe(false);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.hidden
    ).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Remove from queue"]')?.hidden
    ).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label^="Reorder queued message:"]')
        ?.disabled
    ).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label^="Reorder queued message:"]')?.hidden
    ).toBe(false);

    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
    expect(state.clipboardImages).toEqual([]);
    expect(state.terminalSelection).toBeNull();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
    expect(container?.querySelector('.chat-queue-item.is-editing')).toBeNull();
    expect(container?.querySelector('[aria-label="Edit queued message"]')).not.toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('requeues an edited message at its original position', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second', paused: true },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelectorAll<HTMLButtonElement>('[aria-label="Edit queued message"]')[1]
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setInputText('second edited');
    await flushAsyncWork();
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton).not.toBeNull();
    expect(inputText()).toBe('second edited');
    expect(queueButton?.disabled).toBe(false);
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.text)).toEqual([
      'first',
      'second edited',
      'third',
    ]);
    expect(state.queuedMessages[0]?.id).toBe('q1');
    expect(state.queuedMessages[1]?.paused).toBe(true);
    expect(state.queuedMessages[2]?.id).toBe('q3');
  });

  it('sends an edited attempted message with a fresh message id', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', 'session-1', { type: 'busy' });
    setState('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_old_revision',
        sessionId: 'session-1',
        text: 'Old revision',
      },
    ]);
    sendMessageMock.mockResolvedValue(true);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setInputText('Edited revision');
    await flushAsyncWork();
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Add to queue (Enter)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.queuedMessages[0]).not.toHaveProperty('messageId');
    setState('sessionStatus', 'session-1', { type: 'idle' });
    setIsLoading(false);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(client.session.messages).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Edited revision',
      expect.objectContaining({
        messageId: expect.stringMatching(/^msg_/),
        targetSessionId: 'session-1',
      })
    );
    expect(sendMessageMock.mock.calls[0]?.[1]?.messageId).not.toBe('msg_old_revision');
  });

  it('keeps an edited paused message queued when the session becomes idle', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'paused follow-up', paused: true },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setInputText('edited paused follow-up');
    setIsLoading(false);
    await flushAsyncWork();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton).not.toBeNull();
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]?.text).toBe('edited paused follow-up');
    expect(state.queuedMessages[0]?.paused).toBe(true);
  });

  it('pauses automatic queue dispatch while a queued message is being edited', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setIsLoading(false);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessageMock).not.toHaveBeenCalled();

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Cancel queued message edit"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('first', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
  });

  it('does not overwrite existing composer content when editing a queued message', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Keep this draft');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Queued follow-up' }]);

    cleanup = render(() => ChatInput(), container!);

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(true);
    editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('Keep this draft');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
  });

  it('waits for connection initialization before dispatching a restored queue', async () => {
    vi.useFakeTimers();
    setConnectionInitialized(false);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'restored follow-up' }]);

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(500);
    expect(sendMessageMock).not.toHaveBeenCalled();

    setConnectionInitialized(true);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('restored follow-up', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
  });

  it('skips paused rows and dispatches them after they are played', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'paused first', paused: true },
      { id: 'q2', sessionId: 'session-1', text: 'active second' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['active second']);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Play queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'active second',
      'paused first',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('blocks active-session queued actions until message hydration completes', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'wait for hydration' }]);
    sendMessageMock.mockResolvedValue(true);

    cleanup = render(() => ChatInput(), container!);
    const sendNowButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Send as Steer"]'
    );
    expect(sendNowButton?.disabled).toBe(true);
    sendNowButton?.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(sendMessageMock).not.toHaveBeenCalled();

    setState('messagesLoading', false);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'wait for hydration',
      expect.objectContaining({ targetSessionId: 'session-1' })
    );
  });

  it('dispatches a hydrated session queue while the active session is hydrating', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('messagesLoading', true);
    setState('queuedMessages', [
      { id: 'active', sessionId: 'session-1', text: 'active waits' },
      { id: 'other', sessionId: 'session-2', text: 'other can send' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'other can send',
      expect.objectContaining({ targetSessionId: 'session-2' })
    );
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['active']);
  });

  it('retains a failed automatic queue item and its attachments until an explicit retry', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'test 1',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    sendMessageMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('test 1', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: {
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        nativePdfs: undefined,
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const retry = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Retry queued message"]'
    );
    expect(retry?.disabled).toBe(false);
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const firstDispatch = sendMessageMock.mock.calls[0]?.[1]?.queuedMessageDispatch;
    const retryDispatch = sendMessageMock.mock.calls[1]?.[1]?.queuedMessageDispatch;
    expect(sendMessageMock.mock.calls[1]).toEqual([
      'test 1',
      {
        ...sendMessageMock.mock.calls[0]?.[1],
        queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
      },
    ]);
    expect(retryDispatch?.lease).not.toBe(firstDispatch?.lease);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
  });

  it('retains a rejected automatic queue item without repeatedly retrying it', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

    cleanup = render(() => ChatInput(), container!);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe('test 1');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')?.disabled
    ).toBe(false);
  });

  it('does not duplicate an in-flight queued dispatch after remounting', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'pending follow-up' }]);
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessageDispatchingId).toBe('q1');

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    resolveSend?.(true);
    await flushAsyncWork();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageDispatchingId).toBeNull();
  });

  it('preserves a failed queued dispatch and allows retry after remounting', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'retry me' }]);
    sendMessageMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();
    expect(state.failedQueuedMessageIds).toEqual(['q1']);

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(state.queuedMessages).toEqual([]);
    expect(state.failedQueuedMessageIds).toEqual([]);
  });

  it('preserves queued-message editing after remounting', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'edit this follow-up' }]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(inputText()).toBe('edit this follow-up');

    cleanup();
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(container?.querySelector('.chat-queue-item.is-editing')).not.toBeNull();
    expect(inputText()).toBe('edit this follow-up');
  });

  it('clears an edited draft when ownership transfer removes its queued row', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'edit this follow-up' }]);
    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    syncQueuedMessages();
    cleanup();
    resetDefaultAppState();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    cleanup = render(() => ChatInput(), container!);
    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(inputText()).toBe('edit this follow-up');

    applyQueuedMessagesSnapshot([]);
    await flushAsyncWork();

    expect(state.queuedMessageEdit).toBeNull();
    expect(inputText()).toBe('');

    cleanup();
    cleanup = undefined;
    resetDefaultAppState();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageEdit).toBeNull();
    expect(inputText()).toBe('');
  });

  it('sends queued rows as steers and removes them on success', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'test 2',
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
      },
      { id: 'q2', sessionId: 'session-1', text: 'test 3' },
    ]);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('test 2', {
      agent: undefined,
      delivery: 'steer',
      messageId: expect.stringMatching(/^msg_/),
      queuedAttachments: {
        droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
        clipboardImages: [
          { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
        ],
        nativePdfs: undefined,
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
        attachedDiagnostics: undefined,
      },
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
  });

  it('does not resend a restored queued steer that OpenCode already admitted', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_admitted_steer',
        sessionId: 'session-1',
        text: 'Already steered',
      },
    ]);
    vi.mocked(client.session.messages).mockResolvedValue([
      {
        info: {
          id: 'msg_admitted_steer',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        },
        parts: [],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(state.queuedMessages).toEqual([]));

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('keeps a queued steer visible and blocks later queue dispatch while pending', async () => {
    vi.useFakeTimers();
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    let resolveSteer: ((value: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    const queueLabels = () =>
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent);
    expect(sendMessageMock).toHaveBeenCalledWith('test 1', {
      agent: undefined,
      delivery: 'steer',
      messageId: expect.stringMatching(/^msg_/),
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(queueLabels()).toEqual(['test 1', 'test 2']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
    ).toBe(true);

    setIsLoading(false);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(true);
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);

    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]).toEqual([
      'test 2',
      {
        messageId: expect.stringMatching(/^msg_/),
        agent: undefined,
        queuedAttachments: {
          droppedFiles: undefined,
          clipboardImages: undefined,
          nativePdfs: undefined,
          terminalSelection: undefined,
          attachedDiagnostics: undefined,
        },
        queuedContext: expect.any(Object),
        preserveComposer: true,
        targetSessionId: 'session-1',
        queuedMessageDispatch: { itemId: 'q2', lease: expect.any(Number) },
      },
    ]);
  });

  it('removes a pending queued steer when the backend admits it', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    let resolveSteer: ((value: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(resolveSteer).toBeDefined());

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    emitServerEvent('session.next.prompt.admitted', {
      sessionID: 'session-1',
      delivery: 'steer',
      prompt: { text: 'test 1\n[Working directory: /repo]' },
    });
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Steering...');

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(false);
    await flushAsyncWork();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Retry Steer');
  });

  it('restores a queued row when steering it reports a send error', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setState('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 2' },
      { id: 'q2', sessionId: 'session-1', text: 'test 3' },
    ]);
    sendMessageMock.mockResolvedValueOnce(false);

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('test 2', {
      agent: undefined,
      delivery: 'steer',
      messageId: expect.stringMatching(/^msg_/),
      queuedAttachments: {
        droppedFiles: undefined,
        clipboardImages: undefined,
        nativePdfs: undefined,
        terminalSelection: undefined,
        attachedDiagnostics: undefined,
      },
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(container?.querySelector('[aria-label="Retry send as Steer"]')).not.toBeNull();
  });

  it('restores edited message context and restores draft context on cancel', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('draft prompt');
    setState('droppedFiles', [{ path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' }]);
    setState('clipboardImages', [
      { id: 'draft-img', url: 'blob:draft', mime: 'image/png', filename: 'draft.png', size: 10 },
    ]);
    setState('terminalSelection', { text: 'pwd', terminalName: 'draft-terminal' });

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' }],
      images: [
        { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    await Promise.resolve();

    expect(container?.querySelector('.toolbar-repository-link')).toBeNull();
    expect(inputText()).toBe('edited prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });

    container
      ?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('draft prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'draft-img', url: 'blob:draft', mime: 'image/png', filename: 'draft.png', size: 10 },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'pwd', terminalName: 'draft-terminal' });
  });

  it('uses the edited prompt model and reasoning without changing the composer on cancel', async () => {
    setState('activeSessionId', 'session-1');
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          current: {
            id: 'current',
            name: 'Current model',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, max: {} },
          },
          original: {
            id: 'original',
            name: 'Original model',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, high: {} },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'current' });
    setState('selectedModel', { providerID: 'openai', modelID: 'current', variant: 'max' });
    setState('messages', [
      {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'original', variant: 'high' },
        },
        parts: [],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);
    startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, {
      providerID: 'openai',
      modelID: 'original',
      variant: 'high',
    });
    await Promise.resolve();

    expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Original model');
    expect(container?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain(
      'High'
    );
    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'current',
      variant: 'max',
    });

    container
      ?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Current model');
    expect(container?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain('Max');
    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'current',
      variant: 'max',
    });

    startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, {
      providerID: 'openai',
      modelID: 'original',
      variant: 'high',
    });
    await Promise.resolve();
    container?.querySelector<HTMLElement>('.rich-composer')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await flushAsyncWork();

    expect(editMessageMock).toHaveBeenCalledWith(
      'message-1',
      'edited prompt',
      expect.objectContaining({
        selectedModel: { providerID: 'openai', modelID: 'original', variant: 'high' },
      })
    );
    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'original',
      variant: 'high',
    });
  });

  it('restores edited text and preserves the prior draft when an optimistic send fails', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('original draft');
    setState('droppedFiles', [{ path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' }]);
    setState('terminalSelection', { text: 'pwd', terminalName: 'draft-terminal' });
    setState('messages', [
      {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
        },
        parts: [],
      },
    ]);
    editMessageMock.mockImplementationOnce(async (_messageId, _text, options) => {
      options?.onOptimisticPublish?.();
      return false;
    });

    cleanup = render(() => ChatInput(), container!);
    startEditingMessage('message-1', 'session-1', 'corrected prompt', {
      files: [{ path: '/repo/edit.ts', relativePath: 'edit.ts', type: 'file' }],
      images: [],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    await Promise.resolve();

    container?.querySelector<HTMLElement>('.rich-composer')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await flushAsyncWork();

    expect(editMessageMock).toHaveBeenCalledWith(
      'message-1',
      'corrected prompt',
      expect.objectContaining({ onOptimisticPublish: expect.any(Function) })
    );
    expect(inputText()).toBe('corrected prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/edit.ts', relativePath: 'edit.ts', type: 'file' },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });

    container
      ?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(inputText()).toBe('original draft');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'pwd', terminalName: 'draft-terminal' });
  });

  it('merges an edited whole-file attachment into the active document context', async () => {
    setState('activeSessionId', 'session-1');
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: 'app.ts', relativePath: 'app.ts', type: 'file' }],
      images: [],
      terminalSelection: null,
    });
    await Promise.resolve();

    expect(state.droppedFiles).toEqual([]);
    const chips = container?.querySelectorAll('.chat-attachments-container .chat-attachment-chip');
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.textContent).toContain('app.ts');
    expect(chips?.[0]?.querySelector('.chip-remove')).toBeNull();
  });

  it('does not keep edited message text in the composer after remounting into another session', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('draft prompt');

    cleanup = render(() => ChatInput(), container!);

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    await Promise.resolve();

    expect(inputText()).toBe('edited prompt');

    cleanup?.();
    cleanup = undefined;
    setState('activeSessionId', 'session-2');
    cleanup = render(() => ChatInput(), container!);
    await Promise.resolve();

    expect(inputText()).toBe('draft prompt');
  });

  it('queues on modifier Enter while a question is pending and dispatches after it clears', async () => {
    vi.useFakeTimers();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 1_000)]);
    setState('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setInputText('Wait for the answer');
    sendMessageMock.mockResolvedValueOnce(true);

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton?.disabled).toBe(false);
    expect(container?.querySelector('[aria-label="More send options"]')).toBeNull();

    editor?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ sessionId: 'session-1', text: 'Wait for the answer' }),
    ]);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(sendMessageMock).not.toHaveBeenCalled();

    setState('questions', []);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(300);
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Wait for the answer', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: {
        droppedFiles: [],
        clipboardImages: [],
        nativePdfs: [],
        terminalSelection: null,
        attachedDiagnostics: undefined,
      },
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: expect.any(String), lease: expect.any(Number) },
    });
    expect(state.queuedMessages).toEqual([]);
  });

  it('queues on Enter while a permission is pending', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 1_000)]);
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);
    setInputText('Wait for permission');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton?.disabled).toBe(false);
    expect(container?.querySelector('[aria-label="More send options"]')).toBeNull();

    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ sessionId: 'session-1', text: 'Wait for permission' }),
    ]);
  });

  it('does not submit on Enter while a workspace switch is pending', async () => {
    setState('activeSessionId', 'session-1');
    setState('editorContext', {
      workspacePath: '/repo-a',
      workspaceFolders: [
        { name: 'Repo A', path: '/repo-a' },
        { name: 'Repo B', path: '/repo-b' },
      ],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setInputText('Send after switching');

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Select workspace folder"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('button[title="/repo-b"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(true);

    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Send after switching');
  });

  it('still selects a completion on Enter before queueing a pending-request message', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 1_000)]);
    setState('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setState('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputText('@hel');

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected populated composer editor');
    editor.focus();
    setCollapsedSelection(editor.firstChild, '@hel'.length);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(inputText()).toBe('@helper ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('runs /abort with attachments while a question blocks normal sends', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 1_000)]);
    setState('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setState('droppedFiles', [
      { path: '/repo/question.ts', relativePath: 'question.ts', type: 'file' },
    ]);
    setInputText('/abort');

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLDivElement>('.rich-composer')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/abort');
    expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo/question.ts' })]);
  });

  it('runs /stop with attachments while a permission blocks normal sends', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 1_000)]);
    setState('permissions', [
      {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'Allow bash',
        metadata: {},
        time: { created: 1 },
      },
    ]);
    setState('clipboardImages', [
      {
        id: 'permission-image',
        url: 'data:image/png;base64,permission',
        mime: 'image/png',
        filename: 'permission.png',
        size: 1,
      },
    ]);
    setInputText('/stop');

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLDivElement>('.rich-composer')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/stop');
    expect(state.clipboardImages).toEqual([expect.objectContaining({ id: 'permission-image' })]);
  });

  it('runs /abort with attachments while a workspace switch blocks normal sends', async () => {
    setState('activeSessionId', 'session-1');
    setState('editorContext', {
      workspacePath: '/repo-a',
      workspaceFolders: [
        { name: 'Repo A', path: '/repo-a' },
        { name: 'Repo B', path: '/repo-b' },
      ],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setState('droppedFiles', [
      { path: '/repo-a/workspace.ts', relativePath: 'workspace.ts', type: 'file' },
    ]);
    setInputText('/abort');

    cleanup = render(() => ChatInput(), container!);
    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Select workspace folder"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('button[title="/repo-b"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    container
      ?.querySelector<HTMLDivElement>('.rich-composer')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/abort');
    expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo-a/workspace.ts' })]);
  });

  it('shows only the stop button while loading with nothing sendable', () => {
    setIsLoading(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();
    expect(container?.querySelector('.stop-button .toolbar-picker-label')).toBeNull();
    expect(container?.textContent).not.toContain('Stop');
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).toBeNull();
  });

  it('handles a rejected direct stop without an unhandled promise', async () => {
    abortSessionMock.mockRejectedValueOnce(new Error('abort failed'));
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Stop"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stop button through a short idle gap', async () => {
    vi.useFakeTimers();
    setIsLoading(true);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();

    setIsLoading(false);
    await Promise.resolve();

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
  });

  it('shows send controls instead of stop while loading with sendable content', () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Follow up');

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).not.toBeNull();
  });

  it('sends busy composer input as a steer on modifier enter', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Change direction');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Change direction', { delivery: 'steer' });
    expect(state.queuedMessages).toEqual([]);
  });

  it('stops the active response before sending from the busy send menu', async () => {
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Follow up after stopping');

    cleanup = render(() => ChatInput(), container!);

    const menuButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="More send options"]'
    );
    menuButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    const stopAndSendButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Stop and Send')
    );
    stopAndSendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('Follow up after stopping', { noReply: false });
    expect(state.queuedMessages).toEqual([]);
  });

  it('does not send from the busy menu when stopping fails', async () => {
    abortSessionMock.mockRejectedValueOnce(new Error('abort failed'));
    setIsLoading(true);
    setState('activeSessionId', 'session-1');
    setInputText('Do not send after a failed stop');

    cleanup = render(() => ChatInput(), container!);

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const stopAndSendButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Stop and Send')
    );
    stopAndSendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Do not send after a failed stop');
  });

  it('runs a typed slash command with args on Enter', async () => {
    setState('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText('/test --watch');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs a typed slash command with args from the send button', async () => {
    setState('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputText('/test --watch');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('attaches active-file diagnostics with the diagnostics slash command', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [
        {
          path: '/repo/src/app.ts',
          severity: 'error',
          message: 'Unexpected value',
          line: 12,
        },
      ],
      diagnosticsTotal: 3,
    });
    setInputText('/diagnostics');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(state.attachedDiagnostics).toEqual({
      diagnostics: [
        {
          path: '/repo/src/app.ts',
          severity: 'error',
          message: 'Unexpected value',
          line: 12,
        },
      ],
      total: 3,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('shows feedback when the diagnostics slash command finds no issues', async () => {
    setInputText('/diagnostics');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith('No issues found');
    expect(state.attachedDiagnostics).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs the built-in undo slash command on Enter', async () => {
    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0 },
          parentID: 'user-1',
          modelID: 'gpt-4o',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ]);
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs the built-in fork slash command on Enter', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/fork');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('sends slash-prefixed text on Enter when it is not a known slash command', async () => {
    setInputText("/not-a-real-command and /redo commands doesn't work");
    runSlashCommandByNameMock.mockResolvedValue(false);

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith(
      "/not-a-real-command and /redo commands doesn't work",
      {
        noReply: false,
      }
    );
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
  });

  it('runs the built-in undo slash command from the send button', async () => {
    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0 },
          parentID: 'user-1',
          modelID: 'gpt-4o',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ]);
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs undo from the send button even when the suggestion list omits it', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/undo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs redo from the send button even when the suggestion list omits it', async () => {
    setState('activeSessionId', 'session-1');
    setInputText('/redo');

    cleanup = render(() => ChatInput(), container!);

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(redoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('uses a contenteditable rich composer instead of textarea', async () => {
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('contenteditable')).toBe('true');
    expect(editor?.getAttribute('role')).toBe('textbox');
  });

  it('rehydrates pasted file mentions into context files', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? 'Review @README.md and @docs/' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
      {
        path: '/repo/docs',
        relativePath: 'docs',
        type: 'directory',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(inputText()).toBe('Review @README.md and @docs/');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('README.md');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('docs');
  });

  it('withdraws a mention-only paste from the composer once it becomes an attachment', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(inputText()).toBe('');
  });

  it('resolves mentions in a prevented context-only paste without changing the draft', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setInputText('existing draft');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? '[Selection from src/app.ts lines 3-5]\n@README.md' : '',
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(true);
    expect(inputText()).toBe('existing draft');
    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledTimes(1);
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('README.md');
  });

  it('does not attach or withdraw when the session changes while the lookup is pending', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setState('activeSessionId', 'session-a');

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    // The user switches sessions before the workspace lookup comes back.
    setState('activeSessionId', 'session-b');
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([]);
    setState('activeSessionId', null);
  });

  it('does not attach a pasted mention after the composer is cleared in the same session', async () => {
    setState('activeSessionId', 'session-a');
    let resolveLookup:
      | ((value: Awaited<ReturnType<typeof client.varro.resolveWorkspacePath>>) => void)
      | undefined;
    vi.mocked(client.varro.resolveWorkspacePath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    expect(inputText()).toBe('@README.md');
    setInputText('');
    resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
    await flushAsyncWork();

    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
  });

  it('does not attach a pasted mention after it is sent in the same session', async () => {
    setState('activeSessionId', 'session-a');
    sendMessageMock.mockResolvedValueOnce(true);
    let resolveLookup:
      | ((value: Awaited<ReturnType<typeof client.varro.resolveWorkspacePath>>) => void)
      | undefined;
    vi.mocked(client.varro.resolveWorkspacePath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
    );

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('@README.md', { noReply: false });
    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
  });

  it('withdraws the pasted copy, not an identical mention already in the composer', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    // Pre-existing identical mention; with no DOM selection the paste appends
    // at the end, so the two copies sit at different offsets. Searching by
    // content would strip the leading copy and leave ' and notes@README.md'.
    setInputText('@README.md and notes');

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(inputText()).toBe('@README.md and notes');
  });

  it('withdraws only the pasted mention copy when its paired image is null', async () => {
    setInputText('@README.md');
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor?.firstChild) setCollapsedSelection(editor.firstChild, '@README.md'.length);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(event.defaultPrevented).toBe(true);
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('README.md');
    expect(inputText()).toBe('@README.md');
    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
    ]);
  });

  it('inserts mixed-paste text once while attaching the pasted image', async () => {
    const fileReader = installControllableFileReader();
    try {
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);

      dispatchImagePaste(
        editor,
        [new File(['image'], 'mixed.png', { type: 'image/png' })],
        'Pasted description'
      );
      fileReader.resolve('mixed.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(inputText().match(/Pasted description/g)).toHaveLength(1);
      expect(state.clipboardImages.map((image) => image.filename)).toEqual(['Image 1']);
    } finally {
      fileReader.restore();
    }
  });

  it('attaches and disables an image for a model without vision support', async () => {
    const fileReader = installControllableFileReader();
    try {
      setupModelState();
      setState('providers', 0, 'models', 'gpt-4o', 'capabilities', 'vision', false);
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');

      dispatchImagePaste(editor, [new File(['image'], 'unsupported.png', { type: 'image/png' })]);

      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'Image attached; use a vision-capable model or vision subagent to send it',
        'warning'
      );

      fileReader.resolve('unsupported.png');
      await flushAsyncWork();
      expect(inputText()).toBe('');
      expect(state.clipboardImages).toHaveLength(1);
      expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeInstanceOf(
        HTMLElement
      );
    } finally {
      fileReader.restore();
    }
  });

  it('pastes images as attachments after the attachment row takes focus', async () => {
    const fileReader = installControllableFileReader();
    try {
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      dispatchImagePaste(editor, [new File(['first'], 'first.png', { type: 'image/png' })]);
      fileReader.resolve('first.png');
      await flushAsyncWork();

      const attachmentRow = container?.querySelector<HTMLElement>('.chat-attachments-container');
      if (!attachmentRow) throw new Error('Expected attachment row');
      editor.blur();
      attachmentRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      dispatchImagePaste(document.body, [
        new File(['second'], 'second.png', { type: 'image/png' }),
      ]);
      fileReader.resolve('second.png');
      await flushAsyncWork();

      expect(inputText()).toBe('');
      expect(state.clipboardImages.map((image) => image.filename)).toEqual(['Image 1', 'Image 2']);
    } finally {
      fileReader.restore();
    }
  });

  it('enables a non-vision image chip after an exact @vision mention', async () => {
    const fileReader = installControllableFileReader();
    setState('providers', [
      {
        id: 'zai',
        name: 'Z.AI',
        source: 'api',
        models: {
          'glm-4.7': {
            id: 'glm-4.7',
            name: 'GLM 4.7',
            capabilities: { vision: false, toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
      {
        id: 'vision-provider',
        name: 'Vision Provider',
        source: 'api',
        models: {
          viewer: {
            id: 'viewer',
            name: 'Viewer',
            capabilities: { vision: true, toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { zai: 'glm-4.7', 'vision-provider': 'viewer' });
    setState('selectedModel', { providerID: 'zai', modelID: 'glm-4.7' });
    setState('allAgents', [
      {
        name: 'vision',
        mode: 'subagent',
        permission: [],
        model: { providerID: 'vision-provider', modelID: 'viewer' },
      },
    ]);
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    dispatchImagePaste(editor, [new File(['image'], 'delegated.png', { type: 'image/png' })]);
    fileReader.resolve('delegated.png');
    await flushAsyncWork();

    const stagedImageChip = container?.querySelector('.chat-attachment-chip');
    expect(stagedImageChip).toBeInstanceOf(HTMLElement);
    expect(stagedImageChip?.classList).toContain('disabled');

    setInputText('@vision inspect [Image 1]');
    await flushAsyncWork();

    expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeNull();

    setState('activeSessionId', 'session-1');
    setState('messages', [
      {
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'zai', modelID: 'glm-4.7' },
        },
        parts: [
          {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'user-1',
            type: 'text',
            text: '@vision inspect the previous image',
          },
        ],
      },
    ]);
    setInputText('Inspect [Image 1]');
    await flushAsyncWork();

    expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeNull();
    fileReader.restore();
  });

  it('immediately makes a staged image sendable after switching to a vision model', async () => {
    setState('providers', [
      {
        id: 'custom',
        name: 'Custom',
        source: 'api',
        models: {
          text: {
            id: 'text',
            name: 'Text',
            capabilities: { toolcall: true, vision: false },
            cost: { input: 0, output: 0 },
          },
          vision: {
            id: 'vision',
            name: 'Vision',
            capabilities: { attachment: true, toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setState('providerDefaults', { custom: 'text' });
    setState('selectedModel', { providerID: 'custom', modelID: 'text' });
    addClipboardImage({
      id: 'image-1',
      url: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
      filename: 'Image 1',
      size: 5,
    });
    setInputText('[Image 1]');
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(container?.querySelector('.chat-send-button')?.classList).toContain('disabled');

    setState('selectedModel', { providerID: 'custom', modelID: 'vision' });
    await flushAsyncWork();

    expect(container?.querySelector('.chat-send-button')?.classList).toContain('enabled');
    expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeNull();
  });

  it.each(['image first', 'mention first'])(
    'retains an image and mention-only file attachment when %s completes',
    async (completionOrder) => {
      const fileReader = installControllableFileReader();
      let resolveLookup:
        | ((value: Awaited<ReturnType<typeof client.varro.resolveWorkspacePath>>) => void)
        | undefined;
      vi.mocked(client.varro.resolveWorkspacePath).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLookup = resolve;
          })
      );
      try {
        setState('editorContext', {
          workspacePath: '/repo',
          activeFile: null,
          selection: null,
          diagnostics: [],
        });
        cleanup = render(() => ChatInput(), container!);
        await flushAsyncWork();

        const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
        if (!editor) throw new Error('Expected composer editor');
        editor.focus();
        setCollapsedSelection(editor, 0);
        dispatchImagePaste(
          editor,
          [new File(['mention'], 'mention.png', { type: 'image/png' })],
          '@README.md'
        );

        const completeImage = () => fileReader.resolve('mention.png');
        const completeMention = () =>
          resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
        if (completionOrder === 'image first') {
          completeImage();
          await flushAsyncWork();
          completeMention();
        } else {
          completeMention();
          await flushAsyncWork();
          completeImage();
        }
        await flushAsyncWork();

        expect(inputText()).toBe('[Image 1]');
        expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo/README.md' })]);
        expect(state.clipboardImages).toEqual([
          expect.objectContaining({
            url: 'data:image/png;base64,mention.png',
            filename: 'Image 1',
          }),
        ]);
      } finally {
        fileReader.restore();
      }
    }
  );

  it('keeps an image and stripped context reference in one undoable paste transaction', async () => {
    const fileReader = installControllableFileReader();
    try {
      setState('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      });
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);
      dispatchImagePaste(
        editor,
        [new File(['context'], 'context.png', { type: 'image/png' })],
        'Inspect this\n[Selection from src/app.ts lines 3-5]'
      );
      fileReader.resolve('context.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Inspect this [Image 1]');
      expect(state.droppedFiles).toEqual([
        expect.objectContaining({
          path: '/repo/src/app.ts',
          lineRanges: [{ startLine: 3, endLine: 5 }],
        }),
      ]);
      expect(state.clipboardImages).toEqual([
        expect.objectContaining({ url: 'data:image/png;base64,context.png' }),
      ]);

      pressKey(editor, { key: 'z', metaKey: true });
      expect(inputText()).toBe('');
      expect(state.droppedFiles).toEqual([]);
      expect(state.clipboardImages).toEqual([]);
    } finally {
      fileReader.restore();
    }
  });

  it.each([
    { label: 'source order', reads: ['first-mixed.png', 'second-mixed.png'] },
    { label: 'reverse order', reads: ['second-mixed.png', 'first-mixed.png'] },
  ])(
    'keeps overlapping mixed pastes ordered and independently undoable in $label',
    async ({ reads }) => {
      const fileReader = installControllableFileReader();
      try {
        cleanup = render(() => ChatInput(), container!);
        await flushAsyncWork();

        const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
        if (!editor) throw new Error('Expected composer editor');
        editor.focus();
        setCollapsedSelection(editor, 0);

        dispatchImagePaste(
          editor,
          [new File(['first'], 'first-mixed.png', { type: 'image/png' })],
          'First'
        );
        await Promise.resolve();
        if (!editor.firstChild) throw new Error('Expected first pasted text');
        setCollapsedSelection(editor.firstChild, inputText().length);
        dispatchImagePaste(
          editor,
          [new File(['second'], 'second-mixed.png', { type: 'image/png' })],
          ' Second'
        );

        for (const filename of reads) {
          fileReader.resolve(filename);
          await flushAsyncWork();
        }

        expect(inputText()).toBe('First [Image 1] Second [Image 2]');
        expect(
          state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
        ).toEqual([
          { filename: 'Image 1', url: 'data:image/png;base64,first-mixed.png' },
          { filename: 'Image 2', url: 'data:image/png;base64,second-mixed.png' },
        ]);

        pressKey(editor, { key: 'z', metaKey: true });
        expect(inputText()).toBe('First [Image 1]');
        expect(state.clipboardImages).toEqual([
          expect.objectContaining({ url: 'data:image/png;base64,first-mixed.png' }),
        ]);

        pressKey(editor, { key: 'z', metaKey: true });
        expect(inputText()).toBe('');
        expect(state.clipboardImages).toEqual([]);
      } finally {
        fileReader.restore();
      }
    }
  );

  it('undoes mixed pasted text, image, and placeholder as one composer edit', async () => {
    const fileReader = installControllableFileReader();
    try {
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);
      dispatchImagePaste(
        editor,
        [new File(['image'], 'undo-mixed.png', { type: 'image/png' })],
        'Pasted description'
      );
      fileReader.resolve('undo-mixed.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(state.clipboardImages).toHaveLength(1);

      pressKey(editor, { key: 'z', metaKey: true });
      expect(inputText()).toBe('');
      expect(state.clipboardImages).toEqual([]);

      pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(state.clipboardImages).toHaveLength(1);
    } finally {
      fileReader.restore();
    }
  });

  it('keeps mixed-paste text when the clipboard image is null', async () => {
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    editor.focus();
    setCollapsedSelection(editor, 0);

    dispatchImagePaste(editor, [null], 'Text from a null image paste');
    await flushAsyncWork();

    expect(inputText()).toBe('Text from a null image paste');
    expect(state.clipboardImages).toEqual([]);
  });

  it('keeps mixed-paste text when the clipboard image is oversized', async () => {
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const oversized = new File([new Uint8Array(MAX_CLIPBOARD_IMAGE_SIZE + 1)], 'oversized.png', {
      type: 'image/png',
    });
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    editor.focus();
    setCollapsedSelection(editor, 0);

    dispatchImagePaste(editor, [oversized], 'Text from an oversized image paste');
    await flushAsyncWork();

    expect(inputText()).toBe('Text from an oversized image paste');
    expect(state.clipboardImages).toEqual([]);
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Images must be 5 MB or smaller',
      'warning'
    );
  });

  it('keeps mixed-paste text when the clipboard image cannot be read', async () => {
    const fileReader = installControllableFileReader();
    try {
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);

      dispatchImagePaste(
        editor,
        [new File(['broken'], 'unreadable.png', { type: 'image/png' })],
        'Text from an unreadable image paste'
      );
      fileReader.reject('unreadable.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Text from an unreadable image paste');
      expect(state.clipboardImages).toEqual([]);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'Could not read the pasted image',
        'warning'
      );
    } finally {
      fileReader.restore();
    }
  });

  it('keeps mixed-paste text when the clipboard image is rejected as a duplicate', async () => {
    const fileReader = installControllableFileReader();
    try {
      setState('clipboardImages', [
        {
          id: 'existing-image',
          url: 'data:image/png;base64,duplicate.png',
          mime: 'image/png',
          filename: 'Existing',
          size: 1,
        },
      ]);
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);

      dispatchImagePaste(
        editor,
        [new File(['duplicate'], 'duplicate.png', { type: 'image/png' })],
        'Text from a rejected image paste'
      );
      fileReader.resolve('duplicate.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Text from a rejected image paste');
      expect(state.clipboardImages.map((image) => image.id)).toEqual(['existing-image']);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'This image is already attached',
        'warning'
      );
    } finally {
      fileReader.restore();
    }
  });

  it('keeps mixed-paste text when clipboard image capacity is full', async () => {
    const fileReader = installControllableFileReader();
    try {
      setState(
        'clipboardImages',
        Array.from({ length: MAX_CLIPBOARD_IMAGES }, (_, index) => ({
          id: `existing-${index}`,
          url: `data:image/png;base64,existing-${index}`,
          mime: 'image/png',
          filename: `Existing ${index}`,
          size: 1,
        }))
      );
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      editor.focus();
      setCollapsedSelection(editor, 0);

      dispatchImagePaste(
        editor,
        [new File(['extra'], 'capacity.png', { type: 'image/png' })],
        'Text at image capacity'
      );
      fileReader.resolve('capacity.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Text at image capacity');
      expect(state.clipboardImages).toHaveLength(MAX_CLIPBOARD_IMAGES);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        `You can attach up to ${MAX_CLIPBOARD_IMAGES} images`,
        'warning'
      );
    } finally {
      fileReader.restore();
    }
  });

  it('rejects oversized clipboard images before reading them', async () => {
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    const oversized = new File([new Uint8Array(MAX_CLIPBOARD_IMAGE_SIZE + 1)], 'large.png', {
      type: 'image/png',
    });
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => oversized }],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(readSpy).not.toHaveBeenCalled();
    expect(state.clipboardImages).toEqual([]);
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Images must be 5 MB or smaller',
      'warning'
    );
  });

  it('combines multiple image paste rejection reasons into one notification', async () => {
    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    const oversized = new File([new Uint8Array(MAX_CLIPBOARD_IMAGE_SIZE + 1)], 'large.png', {
      type: 'image/png',
    });
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    dispatchImagePaste(editor, [oversized, null]);
    await flushAsyncWork();

    expect(showSessionActionFeedbackMock).toHaveBeenCalledOnce();
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Some images were not pasted: larger than 5 MB, could not be read',
      'warning'
    );
  });

  it('revalidates the composer owner before committing staged pasted images', async () => {
    const fileReader = installControllableFileReader();
    try {
      setState('activeSessionId', 'session-a');
      setInputText('draft');
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');

      dispatchImagePaste(editor, [new File(['a'], 'session.png', { type: 'image/png' })]);
      setState('activeSessionId', 'session-b');
      fileReader.resolve('session.png');
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);

      dispatchImagePaste(editor, [new File(['b'], 'mutation.png', { type: 'image/png' })]);
      setInputText('draft');
      fileReader.resolve('mutation.png');
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);

      dispatchImagePaste(editor, [new File(['c'], 'value.png', { type: 'image/png' })]);
      setInputText('');
      fileReader.resolve('value.png');
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);

      setInputText('send draft');
      sendMessageMock.mockResolvedValueOnce(true);
      dispatchImagePaste(editor, [new File(['d'], 'send.png', { type: 'image/png' })]);
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      await flushAsyncWork();
      expect(inputText()).toBe('');
      fileReader.resolve('send.png');
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);
    } finally {
      fileReader.restore();
    }
  });

  it('stages later image pastes until earlier reads finish, then applies live capacity', async () => {
    const fileReader = installControllableFileReader();
    try {
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      const pasteSize = Math.floor(MAX_CLIPBOARD_IMAGES / 2) + 1;
      const firstPaste = Array.from({ length: pasteSize }, (_, index) => {
        const name = `first-${index + 1}.png`;
        return new File([name], name, { type: 'image/png' });
      });
      const secondPaste = Array.from({ length: pasteSize }, (_, index) => {
        const name = `second-${index + 1}.png`;
        return new File([name], name, { type: 'image/png' });
      });

      dispatchImagePaste(editor, firstPaste);
      dispatchImagePaste(editor, secondPaste);

      fileReader.resolve(secondPaste[0]!.name);
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);

      for (const file of secondPaste.slice(1)) fileReader.resolve(file.name);
      await flushAsyncWork();
      expect(state.clipboardImages).toEqual([]);

      for (const file of firstPaste) fileReader.resolve(file.name);
      await flushAsyncWork();

      expect(state.clipboardImages).toHaveLength(MAX_CLIPBOARD_IMAGES);
      expect(state.clipboardImages.map((image) => image.filename)).toEqual(
        Array.from({ length: MAX_CLIPBOARD_IMAGES }, (_, index) => `Image ${index + 1}`)
      );
      expect(new Set(state.clipboardImages.map((image) => image.filename)).size).toBe(
        MAX_CLIPBOARD_IMAGES
      );
      expect(state.clipboardImages.map((image) => image.url)).toEqual(
        [...firstPaste, ...secondPaste]
          .slice(0, MAX_CLIPBOARD_IMAGES)
          .map((file) => `data:image/png;base64,${file.name}`)
      );
      expect(nextPastedImageIndex()).toBe(MAX_CLIPBOARD_IMAGES + 1);
    } finally {
      fileReader.restore();
    }
  });

  it('commits overlapping image-only pastes into a non-empty composer in source order', async () => {
    const fileReader = installControllableFileReader();
    try {
      setInputText('Review this');
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      setCollapsedSelection(editor.firstChild, 'Review this'.length);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));

      dispatchImagePaste(editor, [new File(['a'], 'first.png', { type: 'image/png' })]);
      dispatchImagePaste(editor, [new File(['b'], 'second.png', { type: 'image/png' })]);

      fileReader.resolve('second.png');
      await flushAsyncWork();
      expect(inputText()).toBe('Review this');
      expect(state.clipboardImages).toEqual([]);

      fileReader.resolve('first.png');
      await flushAsyncWork();

      expect(inputText()).toBe('Review this [Image 1] [Image 2]');
      expect(
        state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
      ).toEqual([
        { filename: 'Image 1', url: 'data:image/png;base64,first.png' },
        { filename: 'Image 2', url: 'data:image/png;base64,second.png' },
      ]);
      expect(nextPastedImageIndex()).toBe(3);
    } finally {
      fileReader.restore();
    }
  });

  it('pastes images at the live selection on the first line', async () => {
    const fileReader = installControllableFileReader();
    try {
      const draft = 'First line\nSecond line';
      setInputText(draft);
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer editor');
      editor.focus();
      setCollapsedSelection(editor.firstChild, 'First line'.length);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
      setCollapsedSelection(editor.firstChild, 0);

      dispatchImagePaste(editor, [
        new File(['a'], 'first.png', { type: 'image/png' }),
        new File(['b'], 'second.png', { type: 'image/png' }),
      ]);
      fileReader.resolve('first.png');
      fileReader.resolve('second.png');
      await flushAsyncWork();

      expect(inputText()).toBe('[Image 1] [Image 2] First line\nSecond line');
      expect(
        state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
      ).toEqual([
        { filename: 'Image 1', url: 'data:image/png;base64,first.png' },
        { filename: 'Image 2', url: 'data:image/png;base64,second.png' },
      ]);
    } finally {
      fileReader.restore();
    }
  });

  it('pastes an image after an inline image chip without adding a newline', async () => {
    const fileReader = installControllableFileReader();
    try {
      addClipboardImage({
        id: 'existing-image',
        url: 'data:image/png;base64,existing',
        mime: 'image/png',
        filename: 'Image 1',
        size: 8,
      });
      setInputText('sdsds [Image 1] ');
      cleanup = render(() => ChatInput(), container!);
      await flushAsyncWork();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      const chip = editor?.querySelector<HTMLElement>('[data-chip-type="image"]');
      const trailingSpacer = chip?.nextSibling;
      if (!editor || trailingSpacer?.nodeType !== Node.TEXT_NODE) {
        throw new Error('Expected inline image chip with a trailing caret spacer');
      }
      editor.focus();
      setCollapsedSelection(trailingSpacer, 1);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));

      dispatchImagePaste(editor, [new File(['next'], 'next.png', { type: 'image/png' })], '\n');
      fileReader.resolve('next.png');
      await flushAsyncWork();

      expect(inputText()).toBe('sdsds [Image 1] [Image 2] ');
      expect(editor.querySelectorAll('br')).toHaveLength(0);
      const pastedChip = Array.from(
        editor.querySelectorAll<HTMLElement>('[data-chip-type="image"]')
      ).at(-1);
      expect(pastedChip?.nextSibling?.textContent).toBe('\u200B ');
    } finally {
      fileReader.restore();
    }
  });

  it('keeps a mention-only paste as text when the mention does not resolve', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@scope/package' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([]);
    expect(inputText()).toBe('@scope/package');
  });

  it('keeps a mention-only paste when the user typed inside it before it resolved', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    setInputText('@READ-edited-ME.md');
    await flushAsyncWork();

    expect(inputText()).toBe('@READ-edited-ME.md');
    expect(state.droppedFiles).toEqual([]);
  });

  it('keeps unresolved scoped package names as plain pasted text', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? 'Use npx @scope/package init' : ''),
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([]);
    expect(inputText()).toBe('Use npx @scope/package init');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('scope/package');
  });

  it('strips pasted context reference lines while restoring them as attachments', async () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    if (editor) setCollapsedSelection(editor, 0);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain'
            ? 'Please review this\n\n[Selection from src/app.ts lines 3-5]\n[Active file: README.md]'
            : '',
        items: [],
      },
    });

    editor?.dispatchEvent(event);
    await flushAsyncWork();

    expect(state.droppedFiles).toEqual([
      {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
      {
        path: '/repo/README.md',
        relativePath: 'README.md',
        type: 'file',
        attachmentSequence: expect.any(Number),
      },
    ]);
    expect(inputText()).toBe('Please review this');
  });

  it('renders inline image chips without a remove button', async () => {
    setState('clipboardImages', [
      {
        id: 'img-1',
        url: 'data:image/png;base64,abc',
        mime: 'image/png',
        filename: 'Image',
        size: 12,
      },
    ]);
    setInputText('[Image]');

    cleanup = render(() => ChatInput(), container!);
    await flushAsyncWork();

    expect(container?.querySelector('.rich-composer .inline-chip')).not.toBeNull();
    expect(container?.querySelector('.rich-composer .inline-chip-remove')).toBeNull();
  });

  it('updates the active Ralph run model and interrupts a usage-limit retry when switching models', async () => {
    const { ralphStore } = await import('../lib/stores/ralph-store');

    setState('activeSessionId', 'child-1');
    setState('sessions', [
      session('manager-1', 2_000),
      session('child-1', 2_100, { parentID: 'manager-1' }),
    ]);
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'api',
        models: {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('sessionStatus', {
      'child-1': { type: 'retry', attempt: 5, message: 'messages exhausted', next: 28 },
    });
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 28s · attempt #5',
        unit: 'messages',
        retryAt: 28_000,
        attempt: 5,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });
    ralphStore.startRun({
      managerSessionId: 'manager-1',
      workspaceDirectory: '/workspace',
      planDocPath: 'RALPH.md',
      iterations: 5,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: { providerID: 'openai', modelID: 'gpt-4o' },
      agent: null,
      createdAt: 1,
    });
    ralphStore.upsertIteration('manager-1', {
      index: 1,
      childSessionId: 'child-1',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });

    cleanup = render(() => ChatInput(), container!);

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(ralphStore.getRun('manager-1')?.config.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(ralphStore.getRun('manager-1')?.status).toBe('paused');
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSessionMock).toHaveBeenCalledWith('child-1');
    expect(state.sessionStatus['child-1']).toEqual({ type: 'idle' });
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('clears the active usage-limit banner when switching away from the limited provider', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setState('providers', [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'api',
        models: {
          claude: {
            id: 'claude',
            name: 'Claude',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setState('sessionStatus', {
      'child-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
    });
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted · retry in 408s · attempt #9',
        unit: 'messages',
        retryAt: 408_000,
        attempt: 9,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(container?.textContent).not.toContain('Usage limit reached');
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
  });

  it('continues a regular retry after switching away from the limited provider', async () => {
    abortSessionMock.mockResolvedValue(undefined);
    continueInterruptedSessionMock.mockResolvedValue(undefined);
    setupRetryingProviderSwitchState();

    cleanup = render(() => ChatInput(), container!);

    const switchProviderButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Switch provider');
    switchProviderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
      variant: undefined,
    });
    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSessionMock).toHaveBeenCalledWith('session-1');
    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(state.sessionUsageLimits['session-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('does not continue a retry when provider-switch abort fails', async () => {
    abortSessionMock.mockRejectedValueOnce(new Error('abort failed'));
    setupRetryingProviderSwitchState();

    cleanup = render(() => ChatInput(), container!);

    const switchProviderButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Switch provider');
    switchProviderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const claudeOption = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('Claude'));
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(continueInterruptedSessionMock).not.toHaveBeenCalled();
    expect(state.sessionStatus['session-1']).toEqual({
      type: 'retry',
      attempt: 9,
      message: 'messages exhausted',
      next: 408,
    });
    expect(state.sessionUsageLimits['session-1']).toMatchObject({
      providerID: 'openai',
      modelID: 'gpt-4o',
      attempt: 9,
    });
  });

  it('clears usage-limit notices across the active tree before sending a prompt', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: 'messages exhausted',
        unit: 'messages',
        retryAt: null,
        attempt: 2,
        sessionID: 'child-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });
    setInputText('continue');

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('continue', { noReply: false });
    expect(state.sessionUsageLimits['child-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('continues from the usage-limit banner and closes the notice', async () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'message',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: null,
        attempt: null,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
      },
    });

    cleanup = render(() => ChatInput(), container!);

    const continueButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Continue');
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(sendMessageMock).toHaveBeenCalledWith('Continue', { noReply: false });
    expect(state.sessionUsageLimits['session-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('renders and opens a safe structured retry action through the extension bridge', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: '429 rate limit reached',
        unit: 'requests',
        retryAt: Date.now() + 30_000,
        attempt: 4,
        sessionID: 'session-1',
        providerID: 'openai',
        modelID: 'gpt-4o',
        action: {
          reason: 'billing',
          provider: 'openai',
          title: 'Add credits to continue',
          message: 'Your OpenAI balance is empty.',
          label: 'Manage billing',
          link: 'https://platform.openai.com/settings/billing',
        },
      },
    });
    const sent: WebviewMessage[] = [];
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    bridgeWindow.__sendToExtension = (message) => sent.push(message);

    try {
      cleanup = render(() => ChatInput(), container!);

      expect(container?.textContent).toContain('Add credits to continue');
      expect(container?.textContent).toContain('Your OpenAI balance is empty.');
      expect(container?.textContent).toContain('request throttled · retry in');
      expect(container?.textContent).toContain('attempt #4');

      const actionButton = Array.from(
        container!.querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent === 'Manage billing');
      actionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(sent).toContainEqual({
        type: 'vscode/open-external',
        payload: { url: 'https://platform.openai.com/settings/billing' },
      });
    } finally {
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it('does not render a structured retry action with a non-HTTPS link', () => {
    setupModelState();
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: '429 rate limit reached',
        unit: 'requests',
        retryAt: null,
        attempt: 4,
        sessionID: 'session-1',
        action: {
          reason: 'billing',
          provider: 'openai',
          title: 'Add credits to continue',
          message: 'Your balance is empty.',
          label: 'Manage billing',
          link: 'http://example.com/billing',
        },
      },
    });

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Add credits to continue');
    expect(container?.textContent).toContain('Your balance is empty.');
    expect(
      Array.from(container!.querySelectorAll('button')).some(
        (button) => button.textContent === 'Manage billing'
      )
    ).toBe(false);
  });

  it('restores reasoning selections per model instead of carrying them across models', async () => {
    setState('providers', [
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
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-5.4' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.4', variant: 'medium' });
    setState('modelVariantSelections', { 'openai:gpt-5.4': 'medium' });

    cleanup = render(() => ChatInput(), container!);

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const gpt55Option = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('GPT-5.5'));
    gpt55Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: undefined,
    });

    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' });
    setState('modelVariantSelections', {
      'openai:gpt-5.4': 'medium',
      'openai:gpt-5.5': 'high',
    });

    modelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForDropdown();

    const gpt54Option = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []
    ).find((button) => button.textContent?.includes('GPT-5.4'));
    gpt54Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsyncWork();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
  });

  it('shows Default for a session without reasoning despite a remembered variant', () => {
    setState('providers', [
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
    ]);
    setState('providerDefaults', { openai: 'gpt-5.4' });
    setState('activeSessionId', 'session-1');
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.4' });
    setState('sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.4' },
    });
    setState('modelVariantSelections', { 'openai:gpt-5.4': 'high' });

    cleanup = render(() => ChatInput(), container!);

    expect(
      container?.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
        ?.textContent
    ).toContain('Default');
  });

  it('warns when the model or reasoning level changes after a session request', async () => {
    vi.useFakeTimers();
    setState('providers', [
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
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 0, output: 0 },
            variants: { low: {}, high: {} },
          },
        },
      },
    ]);
    setState('providerDefaults', { openai: 'gpt-5.4' });
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
    const previousResponse = assistantMessageEntry({ input: 400, output: 100 });
    setState('messages', [
      {
        ...previousResponse,
        info: {
          ...previousResponse.info,
          modelID: 'gpt-5.4',
          variant: 'medium',
        },
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();

    setState('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'high',
    });
    const warning = container?.querySelector<HTMLElement>('.model-selection-cost-warning');
    expect(warning).not.toBeNull();

    warning?.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(0);
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.querySelector('.model-selection-cost-tooltip > span')?.textContent).toBe(
      'Switching the model or reasoning level mid-session may make this request more expensive.'
    );
    expect(tooltip?.querySelector('.model-selection-cost-tooltip-detail')?.textContent).toBe(
      'Current session: OpenAI / GPT-5.4 · Medium'
    );

    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' });
    expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();

    setState('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();

    setState('messagesLoading', true);
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' });
    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();
  });

  it('keeps the usage-limit banner visible when a retry notice predates active-session model hydration', () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('providers', [
      {
        id: 'copilot',
        name: 'GitHub Copilot',
        source: 'api',
        models: {
          'gpt-5-mini': {
            id: 'gpt-5-mini',
            name: 'GPT-5 mini',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-4.1': {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            limit: { context: 1000, output: 1000 },
          },
        },
      },
    ]);
    setState('providerDefaults', { copilot: 'gpt-5-mini' });
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4.1' });
    setState('sessionStatus', {
      'session-1': {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached. retry in 45s attempt #2',
        next: 45,
      },
    });
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached. retry in 45s attempt #2',
        unit: 'messages',
        retryAt: 45_000,
        attempt: 2,
        sessionID: 'session-1',
        providerID: 'copilot',
        modelID: 'gpt-5-mini',
      },
    });
    setState('messages', [
      {
        info: {
          id: 'assistant-usage-limit',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 0, completed: 1 },
          parentID: 'user-1',
          modelID: 'gpt-4.1',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          error: {
            name: 'rate_limit_exceeded',
            data: { message: '429 usage limit reached. retry in 45s attempt #2' },
          },
        },
        parts: [],
      },
    ]);

    cleanup = render(() => ChatInput(), container!);

    expect(container?.textContent).toContain('Usage limit reached');
    expect(container?.textContent).toContain('Stop retrying');
    expect(container?.textContent).toContain('Switch provider');
  });

  it('shows a temporary service failure only from the fourth retry', () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session('session-1', 2_000)]);
    setState('sessionUsageLimits', {
      'session-1': {
        source: 'status',
        statusCode: 429,
        message: 'Our servers are currently overloaded. Please try again later.',
        unit: 'unknown',
        retryAt: null,
        attempt: 3,
        sessionID: 'session-1',
      },
    });

    cleanup = render(() => ChatInput(), container!);
    expect(container?.textContent).not.toContain('Service temporarily unavailable');

    setState('sessionUsageLimits', 'session-1', 'attempt', 4);
    expect(container?.textContent).toContain('Service temporarily unavailable');
  });
});

function pressKey(editor: HTMLDivElement | null | undefined, init: KeyboardEventInit) {
  editor?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function historyEntry(id: string, text: string) {
  const info: UserMessage = {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5' },
  };
  const part: TextPart = {
    id: `${id}-text`,
    sessionID: 'session-1',
    messageID: id,
    type: 'text',
    text,
  };
  return { info, parts: [part] };
}

describe('ChatInput composer history hotkeys', () => {
  it('paginates through sent prompts with Up and returns with Down', async () => {
    setState('activeSessionId', 'session-1');
    setSessionHistoryPrompts('session-1', [
      historyEntry('user-1', 'Earlier loaded prompt'),
      historyEntry('user-2', 'Most recent loaded prompt'),
    ]);
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'ArrowUp' });
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowUp' });
    expect(inputText()).toBe('Earlier loaded prompt');

    loadOlderSessionPromptsMock.mockImplementationOnce(async () => {
      setSessionHistoryPrompts('session-1', [
        historyEntry('user-0', 'Oldest fetched prompt'),
        historyEntry('user-1', 'Earlier loaded prompt'),
        historyEntry('user-2', 'Most recent loaded prompt'),
      ]);
      return true;
    });
    pressKey(editor, { key: 'ArrowUp' });
    await flushAsyncWork();
    expect(inputText()).toBe('Oldest fetched prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('Earlier loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    expect(inputText()).toBe('');
  });

  it('undoes and redoes composer text edits with the keyboard', async () => {
    cleanup = render(() => ChatInput(), container!);
    setInputText('hello');
    setInputText('hello world');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(inputText()).toBe('hello');
    editor?.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'historyUndo',
      })
    );
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'z', ctrlKey: true });
    expect(inputText()).toBe('');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'y', ctrlKey: true });
    expect(inputText()).toBe('hello world');
  });

  it('restores composer text after pasted content is undone', async () => {
    cleanup = render(() => ChatInput(), container!);
    setInputText('draft');
    setInputText('draft pasted block of text');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(inputText()).toBe('draft');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(inputText()).toBe('draft pasted block of text');
  });

  it('undoes and redoes attachment changes', async () => {
    cleanup = render(() => ChatInput(), container!);

    addContextFile({ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    removeContextFile('/repo/src/a.ts');
    expect(state.droppedFiles).toEqual([]);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    pressKey(editor, { key: 'z', metaKey: true });
    expect(state.droppedFiles).toEqual([]);

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);
  });

  it('does not stop the running session on Escape', async () => {
    setState('activeSessionId', 'session-1');
    setIsLoading(true);
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });

  it('closes a toolbar popup on Escape without leaking the shortcut', () => {
    setState('agents', [
      {
        name: 'plan',
        description: 'Draft implementation plans',
        mode: 'primary',
        builtIn: true,
        permission: [],
      },
    ]);
    cleanup = render(() => ChatInput(), container!);

    const agentButton = container?.querySelector<HTMLButtonElement>('[aria-label="Select agent"]');
    agentButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container?.querySelector('.agent-popover')).toBeInstanceOf(HTMLDivElement);

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(container?.querySelector('.agent-popover')).toBeNull();
  });

  it('does not stop anything on Escape while idle', async () => {
    setState('activeSessionId', 'session-1');
    cleanup = render(() => ChatInput(), container!);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await flushAsyncWork();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });
});
