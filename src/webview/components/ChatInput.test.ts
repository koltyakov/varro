import { flush as flushSolid, OBSERVE, reconcile } from 'solid-js';
import type { PathSetter } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { render } from '@solidjs/web';
import packageJson from '../../../package.json';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import type { ProviderLimitStatus, WebviewMessage } from '../../shared/protocol';
import {
  VARRO_VISION_AGENT_DESCRIPTION,
  VARRO_VISION_AGENT_PROMPT,
} from '../../shared/vision-agent';
import type {
  Agent,
  AssistantMessage,
  MessageEntry,
  Part,
  Provider,
  Session,
  TextPart,
  UserMessage,
} from '../types';
import { ChatInput, sendDroppedContent } from './ChatInput';
import {
  state,
  inputText,
  setConnectionInitialized,
  setIsLoading,
  setLoadingLastActivityAt,
  setLoadingStartedAt,
  setShowChangedFiles,
  setShowTurnTimer,
  showModelPicker,
  setShowModelPicker,
  showMcpSettings,
  setShowMcpSettings,
  setState,
  setSelectedModel,
  applySessionSelectedModelsSnapshot,
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
  manualWorkspaceSelection,
  setManualWorkspaceSelection,
  setError,
  errorRetry,
  error as sendError,
  setSessionUsageLimit,
} from '../lib/state';
import type { AppState } from '../lib/app-state';
import { handleWorkspaceSelectionFailure } from '../lib/workspace-selection';
import { startNewChatDraft } from '../lib/new-chat-draft';
import {
  planImplementationDraftRequest,
  requestPlanImplementationDraft,
} from '../lib/plan-implementation-draft';
import { client } from '../lib/client';
import {
  editingMessage,
  resetMessageEditState,
  startEditingMessage,
} from '../lib/message-edit-state';
import { setCachedSessionMessages, setSessionHistoryPrompts } from '../lib/message-window';
import { hasExpandedDiffOverlay, setExpandedDiffOverlay } from '../lib/diff-overlay-state';
import {
  providerConnectionRequest,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import { fixture } from '../test-fixtures';
import type { UnknownRecord } from '../../shared/type-utils';
import {
  applyQueuedMessageClaimResult,
  applyQueuedMessagesSnapshot,
  claimQueuedMessageDispatch,
  syncQueuedMessages,
} from '../lib/state-queued-messages';
import { sendQueuedAsSteer } from './chat-input/queued-steer';
import { databaseBackupIcon, databaseScriptPlusIcon, runningIcon } from '../lib/ui-icons';
import { registerHostExtension } from '../host/extensions';
import { toCssUrl } from './UiIcon';
import { getMaterialChipIcon } from './MaterialChipIcon';
import { getVisibleThreadMessages } from './message-list/thread-visibility';
import { closeSideQuestion, sideQuestionView } from '../lib/side-question';
import { upsertMessageInfo } from '../lib/state-messages';
import * as imageCompression from '../lib/image-compression';
import * as imageLoading from '../lib/image-loading';
import {
  createChatAnnotation,
  getChatAnnotationLabel,
  readChatAnnotation,
} from '../../shared/chat-annotation';
import { pastedTextDataUrl } from '../../shared/pasted-text';
import { resetSessionStatusSnapshotTracking, sessionStore } from '../lib/stores/session-store';
import { suppressExpectedHugeFanIn } from '../../test/expected-solid-diagnostics';

describe('composer dictation integration', () => {
  it('places the mic immediately before Attach and focuses the composer on activation', async () => {
    const sent: WebviewMessage[] = [];
    defaultBridgeSend = (message) => {
      sent.push(message);
      if (message.type !== 'dictation/request') return;
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'dictation/result',
              payload: {
                requestId: message.payload.requestId,
                available: true,
                running: true,
                state: message.payload.action === 'start' ? 'recording' : 'idle',
              },
            },
          })
        )
      );
    };
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      defaultBridgeSend;
    setInputTextAndFlush('Existing draft');
    addContextFile({ path: '/repo/composer.css', relativePath: 'composer.css', type: 'file' });
    flushSolid();
    renderChatInput();
    await Promise.resolve();
    flushSolid();
    const mic = container?.querySelector<HTMLButtonElement>('.toolbar-dictation-button');
    const attach = container?.querySelector<HTMLButtonElement>('.toolbar-attach-button');
    expect(mic).toBeInstanceOf(HTMLButtonElement);
    expect(mic?.closest('.toolbar-right')?.querySelectorAll('button')[0]).toBe(mic);
    flushSolid();
    expect(mic?.closest('.toolbar-right')?.querySelectorAll('button')[1]).toBe(attach);
    flushSolid();
    const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
    const attachment = [...container!.querySelectorAll('.chat-attachment-chip')].find((chip) =>
      chip.textContent?.includes('composer.css')
    );
    expect(attachment).toBeDefined();
    editor.focus();
    flushSolid();
    const textNode = editor.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 8);
    flushSolid();
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    flushSolid();
    window.getSelection()?.addRange(range);
    flushSolid();
    mic?.click();
    flushSolid();
    expect(document.activeElement).toBe(editor);
    expect(sent.at(-1)).toMatchObject({ type: 'dictation/request', payload: { action: 'start' } });
    await Promise.resolve();
    flushSolid();
    expect(
      container?.querySelector('.chat-input-container[data-dictation-requested="true"]')
    ).not.toBeNull();
    expect(container?.querySelector('.composer-dictation-status > .sr-only')?.textContent).toBe(
      'Dictation on. Click mic when done.'
    );
    expect(
      container?.querySelector('.composer-dictation-status > [aria-hidden="true"]')?.textContent
    ).toBe('Rec');
    expect(
      [...container!.querySelectorAll('.chat-attachment-chip')].find((chip) =>
        chip.textContent?.includes('composer.css')
      )
    ).toBe(attachment);
    expect(editor.getAttribute('aria-placeholder')).toBe('Your words will appear here');
    expect(editor.firstChild).toBe(textNode);
    expect(window.getSelection()?.anchorNode).toBe(textNode);
    expect(window.getSelection()?.anchorOffset).toBe(8);
    expect(inputText()).toBe('Existing draft');
    mic?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(
      container?.querySelector('.chat-input-container[data-dictation-requested="true"]')
    ).toBeNull();
    expect(container?.querySelector('.composer-dictation-status')).toBeNull();
    expect(inputText()).toBe('Existing draft');
  });
});

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
  queuedMessageWasAdmittedMock,
  refreshProviderLimitMock,
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
  queuedMessageWasAdmittedMock: vi.fn(),
  refreshProviderLimitMock: vi.fn(async () => {}),
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
    resumeSteering: vi.fn(async (sessionId: string) =>
      client.session.resumeSteering(sessionId, { directory: undefined })
    ),
    editMessage: editMessageMock,
    forkSession: forkSessionMock,
    loadOlderSessionPrompts: loadOlderSessionPromptsMock,
    refreshProviderLimit: refreshProviderLimitMock,
    redoSession: redoSessionMock,
    undoSession: undoSessionMock,
    runSlashCommandByName: runSlashCommandByNameMock,
    sendMessage: sendMessageMock,
  };
});

vi.mock('./chat/SessionActionFeedback', () => ({
  showSessionActionFeedback: showSessionActionFeedbackMock,
}));

vi.mock('./chat-input/queued-message-history', () => ({
  queuedMessageWasAdmitted: queuedMessageWasAdmittedMock,
}));

vi.mock('../lib/client', () => ({
  client: {
    session: {
      get: vi.fn(async () => {
        throw new Error('Session not found');
      }),
      list: vi.fn(async () => ({ items: [], hasMore: false })),
      messages: vi.fn(async () => []),
      update: vi.fn<typeof client.session.update>(),
      status: vi.fn(async () => ({})),
      resumeSteering: vi.fn(async () => true),
    },
    varro: {
      completePrompt: vi.fn<typeof client.varro.completePrompt>(async () => ({
        suffix: ' with tests',
      })),
      workspaceProblems: vi.fn(async () => ({ total: 0, diagnostics: [] })),
      session: {
        reference: vi.fn<typeof client.varro.session.reference>(async () => {
          throw new Error('Session not found');
        }),
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
      matchCopiedSelection: vi.fn(async () => null),
      readWorkspaceFile: vi.fn(async (_path: string): Promise<string | null> => null),
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
let restoreImageLoading: (() => void) | undefined;

beforeEach(() => {
  const imageLoad = vi
    .spyOn(imageLoading, 'loadImage')
    .mockResolvedValue(document.createElement('img'));
  restoreImageLoading = () => imageLoad.mockRestore();
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
  flushSolid();
});

afterEach(() => {
  restoreImageLoading?.();
  flushSolid();
  vi.useRealTimers();
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  flushSolid();
  const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
  if (bridgeWindow.__sendToExtension === defaultBridgeSend) delete bridgeWindow.__sendToExtension;
  defaultBridgeSend = undefined;
  Reflect.deleteProperty(
    fixture<{ __initialWebviewState?: unknown }>(window),
    '__initialWebviewState'
  );
  flushSolid();
  setInputTextAndFlush('');
  setConnectionInitialized(false);
  flushSolid();
  setIsLoadingAndFlush(false);
  setLoadingLastActivityAt(null);
  flushSolid();
  setLoadingStartedAt(null);
  flushSolid();
  setShowChangedFiles(false);
  flushSolid();
  setShowTurnTimer(false);
  flushSolid();
  setShowModelPicker(false);
  flushSolid();
  setManualWorkspaceSelection(false);
  flushSolid();
  setStateAndFlush('pendingWorkspaceSelectionPath', null);
  setStateAndFlush('workspaceSelectionRequestId', null);
  setError(null);
  flushSolid();
  setStateAndFlush('providerRefreshPending', false);
  setStateAndFlush('workspaceCatalogReloadPending', false);
  resetProviderConnectionState();
  flushSolid();
  closeSideQuestion();
  flushSolid();
  setStateAndFlush('activeSessionId', null);
  setStateAndFlush('messagesLoading', false);
  setStateAndFlush('messages', []);
  setStateAndFlush('sessions', []);
  setStateAndFlush('questions', []);
  setStateAndFlush('permissions', []);
  setStateAndFlush('providers', []);
  setStateAndFlush('agents', []);
  setStateAndFlush('allAgents', []);
  setStateAndFlush('providerDefaults', {});
  setStateAndFlush('selectedAgent', null);
  setStateAndFlush('selectedModel', null);
  setState((draft) => {
    const current = draft['sessionSelectedModels'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionSelectedModels'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setStateAndFlush('modelVariantSelections', {});
  setStateAndFlush('providerLimits', {});
  setStateAndFlush('mcpStatus', {});
  setState((draft) => {
    const current = draft['sessionStatus'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionStatus'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  resetSessionStatusSnapshotTracking();
  flushSolid();
  setStateAndFlush('failedSessionIds', []);
  setStateAndFlush('sessionUsageLimits', {});
  setStateAndFlush('sessionPermissionModes', {});
  setStateAndFlush('sessionAutoPermissionActivity', {});
  setStateAndFlush('clipboardImages', []);
  setStateAndFlush('nativePdfs', []);
  resetPastedImageIndex();
  flushSolid();
  setStateAndFlush('droppedFiles', []);
  setStateAndFlush('terminalSelection', null);
  setStateAndFlush('attachedDiagnostics', null);
  setStateAndFlush('inlineProblems', []);
  setStateAndFlush('issuesEnabled', true);
  setStateAndFlush('autoAttachProblems', true);
  setStateAndFlush('autoAttachActiveFile', true);
  setStateAndFlush('promptCompletionModel', '');
  setStateAndFlush('debugShowQuotaWarning', false);
  setStateAndFlush('editorContext', {
    databaseContext: undefined,
    extensionContexts: undefined,
    workspacePath: null,
    activeWorkspacePath: null,
    activeFile: null,
    selection: null,
    diagnostics: [],
    diagnosticCounts: undefined,
  });
  setStateAndFlush('queuedMessages', []);
  setStateAndFlush('queuedMessageDispatchingId', null);
  setStateAndFlush('failedQueuedMessageIds', []);
  setQueuedMessageEdit(null);
  flushSolid();
  setStateAndFlush('todos', []);
  setStateAndFlush('hiddenProviders', []);
  setStateAndFlush('hiddenModels', []);
  setSessionHistoryPrompts('session-1', []);
  flushSolid();
  resetMessageEditState();
  flushSolid();
  sendMessageMock.mockReset();
  queuedMessageWasAdmittedMock.mockReset();
  queuedMessageWasAdmittedMock.mockImplementation(
    async (sessionId: string, messageId: string, workspaceDirectory?: string) => {
      let before: string | undefined;
      do {
        const messages = await client.session.messages(sessionId, {
          limit: 200,
          before,
          directory: workspaceDirectory,
        });
        if (messages.some((message) => message.info.id === messageId)) return true;
        before = messages.nextCursor;
      } while (before);
      return false;
    }
  );
  loadOlderSessionPromptsMock.mockReset();
  loadOlderSessionPromptsMock.mockResolvedValue(false);
  refreshProviderLimitMock.mockReset();
  refreshProviderLimitMock.mockResolvedValue(undefined);
  serverEventHandlers.clear();
  flushSolid();
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
  vi.mocked(client.varro.workspaceProblems).mockReset();
  vi.mocked(client.varro.workspaceProblems).mockResolvedValue({ total: 0, diagnostics: [] });
  vi.mocked(client.session.list).mockReset();
  vi.mocked(client.session.list).mockResolvedValue({ items: [], hasMore: false });
  vi.mocked(client.session.get).mockReset();
  vi.mocked(client.session.get).mockRejectedValue(new Error('Session not found'));
  vi.mocked(client.session.messages).mockReset();
  vi.mocked(client.session.messages).mockResolvedValue([]);
  vi.mocked(client.session.status).mockReset();
  vi.mocked(client.session.status).mockResolvedValue({});
  setExpandedDiffOverlay(testDiffOverlayOwner, false);
  flushSolid();
});

type ProviderModel = Provider['models'][string];

// A tool-capable, zero-cost model; overrides replace or extend those defaults.
function toolModel(
  id: string,
  name: string,
  overrides: Partial<ProviderModel> = {}
): ProviderModel {
  return {
    id,
    name,
    capabilities: { toolcall: true },
    cost: { input: 0, output: 0 },
    ...overrides,
  };
}

function apiProvider(id: string, name: string, models: ProviderModel[]): Provider {
  return {
    id,
    name,
    source: 'api',
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  };
}

function applyModelState() {
  setState(
    storePath('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-4o', 'GPT-4o', { limit: { context: 1000, output: 1000 } }),
      ]),
    ])
  );
  setState(storePath('providerDefaults', { openai: 'gpt-4o' }));
  setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));
}

function setupModelState() {
  applyModelState();
  flushSolid();
}

function setupVisionDelegationModelState() {
  setState(
    storePath('providers', [
      apiProvider('zai', 'Z.AI', [
        toolModel('glm-4.7', 'GLM 4.7', { capabilities: { vision: false, toolcall: true } }),
      ]),
      apiProvider('vision-provider', 'Vision Provider', [
        toolModel('viewer', 'Viewer', { capabilities: { vision: true, toolcall: true } }),
      ]),
    ])
  );
  setState(storePath('providerDefaults', { zai: 'glm-4.7', 'vision-provider': 'viewer' }));
  setState(storePath('selectedModel', { providerID: 'zai', modelID: 'glm-4.7' }));
  setState(
    storePath('allAgents', [
      {
        name: 'vision',
        mode: 'subagent',
        permission: [],
        model: { providerID: 'vision-provider', modelID: 'viewer' },
      },
    ])
  );
  flushSolid();
}

function setupMatchingActiveTurn() {
  applyModelState();
  setState(storePath('selectedAgent', 'build'));
  const entry = historyEntry('active-user', 'Active turn');
  setState(
    storePath('messages', [
      { ...entry, info: { ...entry.info, model: { providerID: 'openai', modelID: 'gpt-4o' } } },
    ])
  );
  flushSolid();
}

function countedUserMessageEntry(text: string, onPartsRead: () => void): MessageEntry<UserMessage> {
  const parts: TextPart[] = [
    {
      id: 'history-text',
      sessionID: 'session-1',
      messageID: 'history-user',
      type: 'text',
      text,
    },
  ];
  return {
    info: {
      id: 'history-user',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'zai', modelID: 'glm-4.7' },
    },
    get parts() {
      onPartsRead();
      return parts;
    },
  };
}

// The matching active turn, loading in the viewed session-1.
function setupLoadingActiveTurn() {
  setupMatchingActiveTurn();
  setIsLoadingAndFlush(true);
  setStateAndFlush('activeSessionId', 'session-1');
}

function setupRetryingProviderSwitchState() {
  applyModelState();
  setState(storePath('activeSessionId', 'session-1'));
  setState(storePath('sessions', [session('session-1', 2_000)]));
  setState(
    storePath('providers', [
      ...state.providers,
      apiProvider('anthropic', 'Anthropic', [
        toolModel('claude', 'Claude', { limit: { context: 1000, output: 1000 } }),
      ]),
    ])
  );
  setState(storePath('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' }));
  setState(
    storePath('sessionStatus', {
      'session-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
    })
  );
  setState(
    storePath('sessionUsageLimits', {
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
    })
  );
  flushSolid();
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

// Flush, drain pending async work, then flush whatever that work scheduled.
async function settle() {
  flushSolid();
  await flushAsyncWork();
  flushSolid();
}

function renderChatInput() {
  cleanup = render(() => ChatInput(), container!);
  flushSolid();
}

function setStateAndFlush<K extends keyof AppState>(key: K, value: PathSetter<AppState[K]>) {
  setState(storePath(key, value));
  flushSolid();
}

function setIsLoadingAndFlush(loading: boolean) {
  setIsLoading(loading);
  flushSolid();
}

function setInputTextAndFlush(text: string) {
  setInputText(text);
  flushSolid();
}

function focusComposer() {
  const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
  if (!editor) throw new Error('Expected composer editor');
  editor.focus();
  flushSolid();
  return editor;
}

function isPopulatedComposer(
  editor: HTMLDivElement | null | undefined
): editor is HTMLDivElement & { firstChild: ChildNode } {
  return Boolean(editor?.firstChild);
}

function focusPopulatedComposer() {
  const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
  if (!isPopulatedComposer(editor)) throw new Error('Expected populated composer editor');
  editor.focus();
  flushSolid();
  return editor;
}

function idleEditorContext(workspacePath: string) {
  return { workspacePath, activeFile: null, selection: null, diagnostics: [] };
}

function multiRootEditorContext(workspacePath: string, activeWorkspacePath?: string) {
  const context = {
    workspacePath,
    workspaceFolders: [
      { name: 'Repo A', path: '/repo-a' },
      { name: 'Repo B', path: '/repo-b' },
    ],
    activeFile: null,
    selection: null,
    diagnostics: [],
  };
  return activeWorkspacePath ? { ...context, activeWorkspacePath } : context;
}

function runningV2Server() {
  return { state: 'running' as const, url: 'http://localhost:4096', apiVersion: 2 as const };
}

const NO_QUEUED_ATTACHMENTS = {
  droppedFiles: undefined,
  clipboardImages: undefined,
  nativePdfs: undefined,
  terminalSelection: undefined,
  attachedDiagnostics: undefined,
};

function userMessageEntry(model: UserMessage['model']): MessageEntry<UserMessage> {
  return {
    info: {
      id: 'message-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model,
    },
    parts: [],
  };
}

function skillCommand(name: string, description: string) {
  return { name, description, template: description, source: 'skill' as const };
}

function dropdownItem(label: string) {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('.dropdown-item') || []).find(
    (button) => button.textContent?.includes(label)
  );
}

// Queues prompts q1..qN for session-1 while idle session-2 is the active view.
function queueForBackgroundSession(...texts: string[]) {
  setStateAndFlush('activeSessionId', 'session-2');
  setStateAndFlush('sessionStatus', {
    'session-1': { type: 'idle' },
    'session-2': { type: 'idle' },
  });
  setStateAndFlush(
    'queuedMessages',
    texts.map((text, index) => ({ id: `q${index + 1}`, sessionId: 'session-1', text }))
  );
}

function captureBridgeMessages() {
  const messages: WebviewMessage[] = [];
  fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension = (
    message
  ) => messages.push(message);
  return messages;
}

async function withControllableFileReader(
  run: (fileReader: ReturnType<typeof installControllableFileReader>) => Promise<void>
) {
  const fileReader = installControllableFileReader();
  flushSolid();
  try {
    await run(fileReader);
  } finally {
    fileReader.restore();
    flushSolid();
  }
}

function dispatchTextPaste(target: Element | null | undefined, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), items: [] },
  });
  target?.dispatchEvent(event);
  return event;
}

function clickAndFlush(target: Element | null | undefined) {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSolid();
}

function clickSelectorAndFlush(selector: string) {
  clickAndFlush(container?.querySelector(selector));
}

function pressKey(target: Element | null | undefined, init: KeyboardEventInit) {
  target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

// Enter as the composer receives it from the document: bubbling, not cancelable.
function pressComposerEnter() {
  container
    ?.querySelector('.rich-composer')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function postQueuedSessionStatus(sessionId: string, status: 'busy' | 'idle') {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'queued-messages/session-status',
        payload: { sessionId, status },
      },
    })
  );
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
  const pendingReads = new Map<
    string,
    { resolve: (resultName?: string) => void; reject: () => void }
  >();

  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;
    private loadListener: (() => void) | undefined;
    private errorListener: (() => void) | undefined;
    private filename: string | undefined;

    addEventListener(type: string, listener: () => void) {
      if (type === 'load') this.loadListener = listener;
      if (type === 'error') this.errorListener = listener;
    }

    readAsDataURL(file: File) {
      this.filename = file.name;
      pendingReads.set(file.name, {
        resolve: (resultName = file.name) => {
          this.result = `data:${file.type};base64,${resultName}`;
          this.loadListener?.();
        },
        reject: () => {
          this.error = new DOMException(`Failed to read ${file.name}`);
          this.errorListener?.();
        },
      });
    }

    abort() {
      if (this.filename) pendingReads.delete(this.filename);
    }
  }

  // SAFETY: The fixture provides the unknown fields read by this statement.
  globalThis.FileReader = fixture<typeof FileReader>(MockFileReader);
  return {
    hasPending(filename: string) {
      return pendingReads.has(filename);
    },
    resolve(filename: string, resultName?: string) {
      const pending = pendingReads.get(filename);
      if (!pending) throw new Error(`No pending FileReader for ${filename}`);
      pendingReads.delete(filename);
      pending.resolve(resultName);
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

function enterComposerText(editor: HTMLDivElement, text: string) {
  editor.focus();
  editor.textContent = text;
  setCollapsedSelection(editor.firstChild ?? editor, text.length);
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text.at(-1) ?? null,
    })
  );
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
  it('initializes queue timers before settled construction effects run', () => {
    setupModelState();
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = render(() => ChatInput(), container);
    flushSolid();
    expect(container.querySelector('[role="textbox"]')).not.toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(client.session.status).not.toHaveBeenCalled();
  });

  it.each(['live messages', 'cached messages'])(
    'includes only the latest same-chat agent text from %s',
    async (source) => {
      vi.useFakeTimers();
      setupModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 2_000)]);
      const base = assistantMessageEntry({ input: 1, output: 1 });
      const textPart = (id: string, text: string): TextPart => ({
        id: `${id}-text`,
        messageID: id,
        sessionID: 'session-1',
        type: 'text',
        text,
      });
      const earlier: MessageEntry = {
        ...base,
        info: { ...base.info, id: 'earlier' },
        parts: [textPart('earlier', 'Old agent reply')],
      };
      const latest: MessageEntry = {
        ...base,
        info: { ...base.info, id: 'latest' },
        parts: [
          textPart('latest', 'The test fails because the handler ignores cancellation.'),
          {
            id: 'reasoning',
            sessionID: 'session-1',
            messageID: 'latest',
            type: 'reasoning',
            text: 'Private reasoning',
            time: { start: 0 },
          },
          { ...textPart('latest', 'Synthetic context'), id: 'synthetic', synthetic: true },
          {
            id: 'tool',
            sessionID: 'session-1',
            messageID: 'latest',
            type: 'tool',
            callID: 'call',
            tool: 'bash',
            state: {
              status: 'completed',
              input: {},
              output: 'Private tool output',
              title: 'Tests',
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
          { ...textPart('latest', 'Ignored text'), id: 'ignored', ignored: true },
          { ...textPart('latest', 'Foreign part'), id: 'foreign-part', sessionID: 'other-chat' },
          { ...textPart('latest', 'Should I fix the handler or change the test?'), id: 'question' },
        ],
      };
      const summary: MessageEntry = {
        ...base,
        info: { ...base.info, id: 'summary', summary: true },
        parts: [textPart('summary', 'Internal compaction summary')],
      };
      const empty: MessageEntry = { ...base, info: { ...base.info, id: 'empty' }, parts: [] };
      const child: MessageEntry = {
        ...base,
        info: { ...base.info, id: 'child', sessionID: 'child-chat' },
        parts: [textPart('child', 'Child agent reply')],
      };
      const other: MessageEntry = {
        ...base,
        info: { ...base.info, id: 'other', sessionID: 'other-chat' },
        parts: [textPart('other', 'Another chat reply')],
      };
      const entries = [earlier, latest, summary, empty, child, other];
      if (source === 'live messages') setState(storePath('messages', entries));
      else setCachedSessionMessages('session-1', entries);
      flushSolid();
      setStateAndFlush('promptCompletionModel', 'openai/fast');
      setInputTextAndFlush('Please fix');
      renderChatInput();
      const editor = focusComposer();
      setCollapsedSelection(editor.firstChild!, 'Please fix'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(client.varro.completePrompt).toHaveBeenCalledWith(
        {
          draft: 'Please fix',
          history: [],
          lastAssistantResponse:
            'The test fails because the handler ignores cancellation.\n\nShould I fix the handler or change the test?',
          variant: undefined,
        },
        { signal: expect.any(AbortSignal), directory: '/repo' }
      );
    }
  );

  it('sends only the last ten user prompts from the composer chat, preserving repeated prompts', async () => {
    vi.useFakeTimers();
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_001, { parentID: 'session-1' }),
      session('other-chat', 2_002),
    ]);
    const prompts = Array.from({ length: 20 }, (_, index) =>
      historyEntry(`prompt-${index}`, index >= 18 ? 'Add a feature' : `Prompt ${index}`)
    );
    const child = historyEntry('child-prompt', 'Private child prompt');
    child.info.sessionID = 'child-1';
    const other = historyEntry('other-prompt', 'Private other chat prompt');
    other.info.sessionID = 'other-chat';
    // Cached and live windows overlap by message ID. Foreign entries must not leak from either.
    setSessionHistoryPrompts('session-1', [...prompts.slice(0, 15), other]);
    flushSolid();
    const assistant = assistantMessageEntry({ input: 1, output: 1 });
    setStateAndFlush('messages', [
      ...prompts.slice(10),
      child,
      other,
      {
        ...assistant,
        parts: [
          {
            id: 'assistant-text',
            sessionID: 'session-1',
            messageID: assistant.info.id,
            type: 'text',
            text: 'Assistant reply, not a user prompt',
          },
        ],
      },
    ]);
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(client.varro.completePrompt).toHaveBeenCalledWith(
      {
        draft: 'Add a feature',
        history: [
          ...Array.from({ length: 8 }, (_, index) => `Prompt ${index + 10}`),
          'Add a feature',
          'Add a feature',
        ],
        lastAssistantResponse: 'Assistant reply, not a user prompt',
        variant: undefined,
      },
      { signal: expect.any(AbortSignal), directory: '/repo' }
    );
  });

  it('does not send another chat history when composing a new chat', async () => {
    vi.useFakeTimers();
    const previousReply = assistantMessageEntry({ input: 1, output: 1 });
    setStateAndFlush('messages', [
      historyEntry('other-prompt', 'Another chat prompt'),
      {
        ...previousReply,
        parts: [
          {
            id: 'old-text',
            sessionID: 'session-1',
            messageID: previousReply.info.id,
            type: 'text',
            text: 'Another chat agent reply',
          },
        ],
      },
    ]);
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(client.varro.completePrompt).toHaveBeenCalledWith(
      { draft: 'Add a feature', history: [], variant: undefined },
      { signal: expect.any(AbortSignal), directory: undefined }
    );
  });
  it('marks the composer pending only while a completion request is in flight', async () => {
    vi.useFakeTimers();
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    let resolve!: (result: { suffix: string }) => void;
    vi.mocked(client.varro.completePrompt).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(editor.dataset.promptCompletionPending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(editor.dataset.promptCompletionPending).toBe('true');
    expect(inputText()).toBe('Add a feature');
    resolve({ suffix: ' with tests' });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(editor.dataset.promptCompletionPending).toBeUndefined();
    expect(editor.dataset.promptSuggestion).toBe(' with tests');
  });
  it.each([false, true])(
    'clears completion warnings when submitting a prompt in the same chat, busy=%s',
    async (busy) => {
      vi.useFakeTimers();
      setupModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 2_000)]);
      setState(storePath('sessionStatus', 'session-1', { type: busy ? 'busy' : 'idle' }));
      flushSolid();
      setStateAndFlush('promptCompletionModel', 'openai/fast');
      setInputTextAndFlush('Add a feature');
      sendMessageMock.mockResolvedValue(true);
      vi.mocked(client.varro.completePrompt).mockRejectedValueOnce(new Error('Unavailable'));
      renderChatInput();
      const editor = focusComposer();
      setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(container!.querySelector('.prompt-completion-warning')).not.toBeNull();
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(inputText()).toBe('');
      expect(state.activeSessionId).toBe('session-1');
      expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
      if (busy) expect(state.queuedMessages[0]?.text).toBe('Add a feature');
      else expect(sendMessageMock).toHaveBeenCalledWith('Add a feature', expect.anything());
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
    }
  );
  it('uses the model-selection warning location and styles for completion failures, with a keyboard-focus tooltip', async () => {
    vi.useFakeTimers();
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    vi.mocked(client.varro.completePrompt).mockRejectedValueOnce(
      new Error('Prompt completion API returned HTTP 403')
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
    await vi.advanceTimersByTimeAsync(599);
    flushSolid();
    expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    const warning = container!.querySelector<HTMLElement>(
      '.toolbar-main .toolbar-left .prompt-completion-warning'
    )!;
    expect(warning).not.toBeNull();
    expect(warning.classList.contains('model-selection-cost-warning')).toBe(true);
    expect(
      warning.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-width')
    ).toBe('16px');
    expect(container!.querySelector('.toolbar-meta .prompt-completion-warning')).toBeNull();
    warning.focus();
    flushSolid();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(container!.querySelector('.prompt-completion-warning')).toBe(warning);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Prompt completion failed (openai/fast): Prompt completion API returned HTTP 403'
    );
    expect(document.querySelector('[role="tooltip"] [role="separator"]')).toBeNull();
    expect(inputText()).toBe('Add a feature');
    expect(sendMessageMock).not.toHaveBeenCalled();
    setStateAndFlush('promptCompletionModel', '');
    expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
  });

  it('shares one warning icon with the model-selection warning and retains that warning after completion recovers', async () => {
    vi.useFakeTimers();
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setState(storePath('providers', 0, 'models', 'gpt-4o', 'variants', { high: {} }));
    flushSolid();
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o', variant: 'high' });
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    vi.mocked(client.varro.completePrompt).mockRejectedValueOnce(new Error('Unavailable'));
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container!.querySelectorAll('.model-selection-cost-warning')).toHaveLength(1);
    const warning = container!.querySelector<HTMLElement>('.prompt-completion-warning')!;
    warning.focus();
    flushSolid();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Switching the model'
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Current session: OpenAI / GPT-4o'
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Prompt completion failed (openai/fast): Unavailable'
    );
    const separator = document.querySelector('[role="tooltip"] [role="separator"]');
    expect(separator?.classList.contains('toolbar-picker-tooltip-separator')).toBe(true);
    expect(separator?.previousElementSibling?.textContent).toContain('Current session:');
    expect(separator?.nextElementSibling?.textContent).toContain('Prompt completion failed');
    editor.focus();
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container!.querySelector('.prompt-completion-warning')).toBeNull();
    expect(container!.querySelectorAll('.model-selection-cost-warning')).toHaveLength(1);
    warning.focus();
    flushSolid();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Switching the model'
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain(
      'Prompt completion failed'
    );
    expect(document.querySelector('[role="tooltip"] [role="separator"]')).toBeNull();
  });
  it("uses the completion model's lowest variant rather than the active chat reasoning level", async () => {
    vi.useFakeTimers();
    setupModelState();
    setState(
      storePath('providers', 0, 'models', 'gpt-4o', 'variants', { high: {}, low: {}, none: {} })
    );
    flushSolid();
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o', variant: 'high' });
    setStateAndFlush('promptCompletionModel', 'openai/gpt-4o');
    setInputTextAndFlush('Add a feature');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected composer');
    editor.focus();
    flushSolid();
    setCollapsedSelection(editor.firstChild, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(client.varro.completePrompt).toHaveBeenCalledWith(
      {
        draft: 'Add a feature',
        history: [],
        variant: 'none',
      },
      { signal: expect.any(AbortSignal), directory: undefined }
    );
    expect(state.selectedModel?.variant).toBe('high');
  });
  it.each(['Tab', 'Escape', 'Enter'])(
    'handles inline prompt suggestions with %s without auto-sending',
    async (key) => {
      vi.useFakeTimers();
      setStateAndFlush('promptCompletionModel', 'openai/fast');
      setInputTextAndFlush('Add a feature');
      renderChatInput();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected composer');
      editor.focus();
      flushSolid();
      setCollapsedSelection(editor.firstChild, 'Add a feature'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(editor.dataset.promptSuggestion).toBe(' with tests');
      expect(editor.textContent).toBe('Add a feature');
      expect(inputText()).toBe('Add a feature');
      expect(sendMessageMock).not.toHaveBeenCalled();
      pressKey(editor, { key });
      await settle();
      if (key === 'Tab') {
        expect(inputText()).toBe('Add a feature with tests');
        await vi.advanceTimersByTimeAsync(1_000);
        flushSolid();
        expect(editor.dataset.promptSuggestion).toBeUndefined();
        expect(client.varro.completePrompt).toHaveBeenCalledOnce();
        expect(sendMessageMock).not.toHaveBeenCalled();
        pressKey(editor, { key: 'z', metaKey: true });
        flushSolid();
        expect(inputText()).toBe('Add a feature');
      } else if (key === 'Escape') {
        expect(inputText()).toBe('Add a feature');
        expect(editor.dataset.promptSuggestion).toBeUndefined();
        expect(sendMessageMock).not.toHaveBeenCalled();
      } else {
        expect(sendMessageMock).toHaveBeenCalledWith('Add a feature', expect.anything());
      }
      flushSolid();
    }
  );

  it('displays and accepts a suggestion without duplicating the trailing draft space', async () => {
    vi.useFakeTimers();
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    const draft = 'Add a feature ';
    setInputTextAndFlush(draft);
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, draft.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(editor.dataset.promptSuggestion).toBe('with tests');
    expect(inputText()).toBe(draft);
    pressKey(editor, { key: 'Tab' });
    await settle();
    expect(inputText()).toBe('Add a feature with tests');
    expect(sendMessageMock).not.toHaveBeenCalled();
    pressKey(editor, { key: 'z', metaKey: true });
    flushSolid();
    expect(inputText()).toBe(draft);
  });

  it('hides prompt suggestions during composition and a text selection', async () => {
    vi.useFakeTimers();
    setStateAndFlush('promptCompletionModel', 'openai/fast');
    setInputTextAndFlush('Add a feature');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected composer');
    editor.focus();
    flushSolid();
    setCollapsedSelection(editor.firstChild, 'Add a feature'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(editor.dataset.promptSuggestion).toBeTruthy();
    const range = document.createRange();
    range.selectNodeContents(editor);
    window.getSelection()?.removeAllRanges();
    flushSolid();
    window.getSelection()?.addRange(range);
    flushSolid();
    document.dispatchEvent(new Event('selectionchange'));
    flushSolid();
    expect(editor.dataset.promptSuggestion).toBeUndefined();
    setCollapsedSelection(editor.firstChild, 'Add a feature'.length);
    flushSolid();
    document.dispatchEvent(new Event('selectionchange'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(editor.dataset.promptSuggestion).toBeTruthy();
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    flushSolid();
    expect(editor.dataset.promptSuggestion).toBeUndefined();
  });

  describe('image preview fallback', () => {
    const broken = {
      id: 'broken-image',
      filename: 'Image 1',
      mime: 'image/gif',
      url: 'data:image/gif;base64,broken',
      size: 100,
    };

    beforeEach(() => {
      setupModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('clipboardImages', [{ ...broken }]);
      vi.mocked(imageLoading.loadImage).mockRejectedValue(new Error('Could not decode the image'));
    });

    it.each([false, true])(
      'initializes an existing image draft without reactive errors (delegation: %s)',
      async (delegation) => {
        if (delegation) setupVisionDelegationModelState();
        setInputText('[Image 1]');
        setManualWorkspaceSelection(true);
        flushSolid();
        const error = vi.spyOn(console, 'error');
        try {
          renderChatInput();
          await settle();
          expect(error).not.toHaveBeenCalled();
          expect(manualWorkspaceSelection()).toBe(true);
          setState(storePath('clipboardImages', []));
          setInputTextAndFlush('');
          expect(manualWorkspaceSelection()).toBe(false);
          expect(error).not.toHaveBeenCalled();
        } finally {
          error.mockRestore();
        }
      }
    );

    it('keeps the original attachment enabled, exposes the decode reason, and prevents previews', async () => {
      renderChatInput();
      await settle();
      const chip = container!.querySelector<HTMLElement>('.chat-attachment-chip')!;
      expect(chip.classList.contains('disabled')).toBe(false);
      expect(chip.title).toBe(
        'Preview unavailable: Could not decode the image. The original image is attached.'
      );
      expect(chip.getAttribute('role')).toBeNull();
      chip.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      chip.click();
      flushSolid();
      expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
      expect(document.querySelector('.chat-image-preview-overlay')).toBeNull();
      expect(container!.querySelector('.chat-send-button')?.classList).toContain('enabled');
      chip.querySelector<HTMLButtonElement>('.chip-remove')!.click();
      flushSolid();
      expect(state.clipboardImages).toEqual([]);
    });

    it.each([false, true])(
      'sends the original image and placeholder without enabling its preview (steering: %s)',
      async (steering) => {
        if (steering) setupMatchingActiveTurn();
        flushSolid();
        setIsLoading(steering);
        flushSolid();
        setInputTextAndFlush('Describe [Image 1]');
        renderChatInput();
        await settle();
        const chip = container!.querySelector<HTMLElement>('.inline-chip')!;
        expect(chip.classList.contains('disabled')).toBe(false);
        expect(chip.title).toBe(
          'Preview unavailable: Could not decode the image. The original image is attached.'
        );
        expect(chip.hasAttribute('data-preview-image')).toBe(false);
        chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        flushSolid();
        chip.click();
        flushSolid();
        expect(document.querySelector('.chat-attachment-image-preview')).toBeNull();
        expect(document.querySelector('.chat-image-preview-overlay')).toBeNull();
        container!
          .querySelector('.rich-composer')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, metaKey: steering })
          );
        await settle();
        expect(sendMessageMock).toHaveBeenCalledWith(
          'Describe [Image 1]',
          expect.objectContaining({
            queuedAttachments: expect.objectContaining({
              clipboardImages: [expect.objectContaining({ id: broken.id, url: broken.url })],
            }),
          })
        );
      }
    );

    it('retains original images and placeholders in inline edits after preview failure', async () => {
      setStateAndFlush('messages', [userMessageEntry({ providerID: 'openai', modelID: 'gpt-4o' })]);
      renderChatInput();
      startEditingMessage('message-1', 'session-1', 'Describe [Image 1]', {
        files: [],
        images: [{ ...broken }],
        terminalSelection: null,
      });
      await settle();
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(editMessageMock).toHaveBeenCalledWith(
        'message-1',
        'Describe [Image 1]',
        expect.objectContaining({
          queuedAttachments: expect.objectContaining({
            clipboardImages: [expect.objectContaining({ id: broken.id, url: broken.url })],
          }),
        })
      );
    });

    it('ignores decode failures from replaced image content', async () => {
      let rejectLoad: ((error: Error) => void) | undefined;
      vi.mocked(imageLoading.loadImage).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectLoad = reject;
          })
      );
      setInputTextAndFlush('[Image 1]');
      renderChatInput();
      const chip = container!.querySelector<HTMLElement>('.inline-chip')!;
      expect(chip.hasAttribute('data-preview-image')).toBe(false);
      chip.click();
      flushSolid();
      expect(document.querySelector('.chat-image-preview-overlay')).toBeNull();
      vi.mocked(imageLoading.loadImage).mockResolvedValue(document.createElement('img'));
      setState(storePath('clipboardImages', 0, 'url', 'data:image/gif;base64,repaired'));
      await settle();
      rejectLoad?.(new Error('Could not decode the old image'));
      await settle();
      expect(container!.querySelector('.inline-chip.disabled')).toBeNull();
      expect(container!.querySelector('.inline-chip[data-preview-image]')).not.toBeNull();
    });

    it('sends the original image-only draft after preview failure', async () => {
      setInputTextAndFlush('[Image 1]');
      renderChatInput();
      await settle();
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(sendMessageMock).toHaveBeenCalledWith(
        '[Image 1]',
        expect.objectContaining({
          queuedAttachments: expect.objectContaining({
            clipboardImages: [expect.objectContaining({ id: broken.id, url: broken.url })],
          }),
        })
      );
    });

    it('retains original images in queued messages even when one preview fails', async () => {
      const valid = {
        ...broken,
        id: 'valid-image',
        filename: 'Image 2',
        url: 'data:image/gif;base64,valid',
      };
      setStateAndFlush('clipboardImages', [{ ...broken }, valid]);
      vi.mocked(imageLoading.loadImage).mockImplementation(async (url) => {
        if (url === broken.url) throw new Error('Could not decode the image');
        return document.createElement('img');
      });
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      setInputTextAndFlush('Describe [Image 1] [Image 2]');
      renderChatInput();
      await settle();
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(state.queuedMessages[0]?.text).toBe('Describe [Image 1] [Image 2]');
      expect(state.queuedMessages[0]?.clipboardImages).toEqual([
        expect.objectContaining({ id: broken.id, url: broken.url }),
        expect.objectContaining({ id: valid.id }),
      ]);
    });

    it('allows original image sends while decoding is pending or timed out and recovers previews on replacement', async () => {
      sendMessageMock.mockResolvedValue(false);
      let rejectLoad: ((error: Error) => void) | undefined;
      vi.mocked(imageLoading.loadImage).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectLoad = reject;
          })
      );
      setInputTextAndFlush('Describe [Image 1]');
      cleanup = render(() => ChatInput({ newSession: true }), container!);
      flushSolid();
      expect(
        container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.disabled
      ).toBe(false);
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(sendMessageMock).toHaveBeenCalledWith(
        'Describe [Image 1]',
        expect.objectContaining({
          queuedAttachments: expect.objectContaining({
            clipboardImages: [expect.objectContaining({ id: broken.id, url: broken.url })],
          }),
        })
      );
      expect(showSessionActionFeedbackMock).not.toHaveBeenCalled();
      rejectLoad?.(new Error('Timed out decoding the image'));
      await settle();
      expect(container!.querySelector<HTMLElement>('.inline-chip')!.title).toBe(
        'Preview unavailable: Timed out decoding the image. The original image is attached.'
      );
      container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock.mock.calls[1]?.[1]?.queuedAttachments?.clipboardImages?.[0]?.url).toBe(
        broken.url
      );
      vi.mocked(imageLoading.loadImage).mockResolvedValue(document.createElement('img'));
      setState(storePath('clipboardImages', 0, 'url', 'data:image/gif;base64,repaired'));
      await settle();
      expect(container!.querySelector('.inline-chip.disabled')).toBeNull();
      expect(container!.querySelector('.inline-chip[data-preview-image]')).not.toBeNull();
    });

    it('stores and delegates the original image even when its preview fails', async () => {
      setupVisionDelegationModelState();
      setInputTextAndFlush('@vision Describe [Image 1]');
      const posted = vi.fn();
      fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
        posted;
      renderChatInput();
      await settle();
      expect(posted).toHaveBeenCalledWith({
        type: 'images/store',
        payload: {
          id: broken.id,
          name: broken.filename,
          content: broken.url.slice(broken.url.indexOf(',') + 1),
          size: broken.size,
        },
      });
      expect(
        container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.disabled
      ).toBe(true);
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'images/stored',
            payload: {
              id: broken.id,
              contextFile: {
                path: '/repo/original.gif',
                relativePath: 'original.gif',
                type: 'file',
              },
            },
          },
        })
      );
      await settle();
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(sendMessageMock).toHaveBeenCalled();
      expect(sendMessageMock.mock.calls[0]?.[1]?.queuedAttachments?.clipboardImages?.[0]?.url).toBe(
        broken.url
      );
    });
  });

  describe('image compression', () => {
    const original = {
      id: 'compress-one',
      filename: 'image.png',
      mime: 'image/png',
      url: 'data:image/png;base64,original',
      size: 3 * 1024 * 1024,
      attachmentSequence: 7,
    };
    const compressed = {
      url: 'data:image/png;base64,compressed',
      mime: 'image/png',
      size: 100_000,
      width: 2048,
      height: 1024,
    };
    beforeEach(() => {
      vi.spyOn(imageCompression, 'analyzeImageCompression').mockImplementation(async (image) =>
        image.url === original.url
          ? {
              width: 4000,
              height: 2000,
              recommended: compressed,
              smaller: { ...compressed, width: 1280, height: 640 },
            }
          : null
      );
      setupModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('clipboardImages', [{ ...original }]);
      setInputTextAndFlush('[image.png]');
    });
    afterEach(() => {
      vi.restoreAllMocks();
      flushSolid();
    });
    it('compresses and restores an inline image without changing its name, identity, marker or order', async () => {
      renderChatInput();
      await settle();
      container!
        .querySelector('.inline-chip')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      expect(document.querySelector('.image-compression-menu')?.textContent).toContain(
        '2048 × 1024'
      );
      Array.from(document.querySelectorAll<HTMLButtonElement>('.image-compression-menu button'))
        .find((button) => button.textContent?.startsWith('Recommended'))!
        .click();
      flushSolid();
      expect(state.clipboardImages[0]).toMatchObject({
        ...original,
        url: compressed.url,
        size: compressed.size,
        contentKey: original.url,
      });
      expect(inputText()).toBe('[image.png]');
      await flushAsyncWork();
      flushSolid();
      container!
        .querySelector('.inline-chip')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      Array.from(document.querySelectorAll<HTMLButtonElement>('.image-compression-menu button'))
        .find((button) => button.textContent === 'Restore original')!
        .click();
      flushSolid();
      expect(state.clipboardImages[0]).toMatchObject(original);
    });
    it('supports the attachment-row chip and refuses compression during image storage', async () => {
      setupVisionDelegationModelState();
      setInputTextAndFlush('@vision Look at this');
      renderChatInput();
      await settle();
      container!
        .querySelector('.chat-attachment-chip')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      document.querySelector<HTMLButtonElement>('.image-compression-menu button')!.click();
      await settle();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Wait for the current image operation'
      );
      expect(state.clipboardImages[0]).toMatchObject(original);
    });
    it('discards image analysis after the session changes', async () => {
      let complete:
        | ((result: imageCompression.ImageCompressionAnalysis | null) => void)
        | undefined;
      vi.mocked(imageCompression.analyzeImageCompression).mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
      renderChatInput();
      await settle();
      setStateAndFlush('activeSessionId', 'session-2');
      complete?.({ width: 4000, height: 2000, recommended: compressed, smaller: null });
      await flushAsyncWork();
      flushSolid();
      expect(state.clipboardImages[0]?.url).not.toBe(compressed.url);
      expect(document.querySelector('.image-compression-menu')).toBeNull();
      expect(container!.querySelector('.chip-image-size')).toBeNull();
    });
    it('does not mutate a queued image snapshot while compressing the draft', async () => {
      const queuedImage = { ...original };
      setStateAndFlush('queuedMessages', [
        {
          id: 'queue-compression',
          sessionId: 'session-1',
          text: 'queued',
          clipboardImages: [queuedImage],
        },
      ]);
      renderChatInput();
      await settle();
      container!
        .querySelector('.inline-chip')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      document.querySelector<HTMLButtonElement>('.image-compression-menu button')!.click();
      flushSolid();
      expect(state.clipboardImages[0]?.url).toBe(compressed.url);
      expect(state.queuedMessages[0]?.clipboardImages?.[0]?.url).toBe(original.url);
    });
    it('rejects a stale image-store acknowledgement after undo restores the original', async () => {
      setupVisionDelegationModelState();
      setStateAndFlush('clipboardImages', [
        {
          ...original,
          contextFile: { path: '/repo/original.png', relativePath: 'original.png', type: 'file' },
        },
      ]);
      setInputTextAndFlush('@vision inspect [image.png]');
      const posted = vi.fn();
      fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
        posted;
      renderChatInput();
      await settle();
      container!
        .querySelector('.inline-chip[data-chip-type="image"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      document.querySelector<HTMLButtonElement>('.image-compression-menu button')!.click();
      await settle();
      expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'images/store' }));
      container!
        .querySelector('.rich-composer')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
        );
      flushSolid();
      expect(state.clipboardImages[0]?.url).toBe(original.url);
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'images/stored',
            payload: {
              id: original.id,
              contextFile: {
                path: '/repo/compressed.png',
                relativePath: 'compressed.png',
                type: 'file',
              },
            },
          },
        })
      );
      flushSolid();
      expect(state.clipboardImages[0]?.contextFile?.path).toBe('/repo/original.png');
      expect(posted).toHaveBeenCalledWith({
        type: 'images/release',
        payload: { paths: ['/repo/compressed.png'], deferred: false },
      });
    });
  });
  it('attaches PDFs picked by the extension', async () => {
    setupModelState();
    renderChatInput();
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
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.nativePdfs).toMatchObject([pdf]);
    expect(container?.textContent).toContain('spec.pdf');
    const pdfChip = container?.querySelector('.chat-attachment-chip');
    expect(pdfChip).toBeInstanceOf(HTMLElement);
    expect(pdfChip?.textContent).toContain('PDF');

    setState(
      storePath('providers', 0, 'models', 'pdf-model', {
        id: 'pdf-model',
        name: 'PDF Model',
        capabilities: {
          input: { text: true, audio: false, image: false, video: false, pdf: true },
        },
        cost: { input: 0, output: 0 },
      })
    );
    flushSolid();
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'pdf-model' });
    expect(pdfChip?.textContent).toContain('PDF');

    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    expect(pdfChip?.textContent).toContain('PDF');
  });

  it.each([undefined, ['text']])(
    'keeps the PDF draft and explains capability %j on Enter',
    async (input) => {
      setupModelState();
      setState(storePath('providers', 0, 'models', 'gpt-4o', 'capabilities', { input }));
      flushSolid();
      const pdf = {
        id: 'pdf-blocked',
        mime: 'application/pdf' as const,
        filename: 'keep.pdf',
        size: 5,
        url: 'data:application/pdf;base64,JVBERi0=',
      };
      setStateAndFlush('nativePdfs', [pdf]);
      setInputTextAndFlush('Keep my draft');
      renderChatInput();
      pressComposerEnter();
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(inputText()).toBe('Keep my draft');
      expect(state.nativePdfs).toEqual([pdf]);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        expect.stringContaining(
          input ? 'does not support PDF input' : 'PDF input support is unknown'
        ),
        'warning'
      );
    }
  );

  it('does not attach a delayed pasted PDF after switching sessions', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('activeSessionId', 'session-a');
      renderChatInput();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      const pdf = new File(['%PDF-1.7\n'], 'delayed.pdf', { type: 'application/pdf' });
      dispatchImagePaste(editor, [pdf]);
      await settle();
      expect(fileReader.hasPending('delayed.pdf')).toBe(true);

      setStateAndFlush('activeSessionId', 'session-b');
      fileReader.resolve('delayed.pdf');
      await settle();

      expect(state.nativePdfs).toEqual([]);
      expect(container?.textContent).not.toContain('delayed.pdf');
    });
  });

  it('does not attach a delayed pasted PDF after sending clears the composer', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('activeSessionId', 'session-a');
      setInputTextAndFlush('Send this draft');
      renderChatInput();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      dispatchImagePaste(editor, [
        new File(['%PDF-1.7\n'], 'send-delayed.pdf', { type: 'application/pdf' }),
      ]);
      await settle();
      expect(fileReader.hasPending('send-delayed.pdf')).toBe(true);

      clickSelectorAndFlush('[aria-label="Send (Enter)"]');
      await settle();
      expect(inputText()).toBe('');

      fileReader.resolve('send-delayed.pdf');
      await settle();

      expect(state.nativePdfs).toEqual([]);
    });
  });

  it('does not attach a delayed pasted PDF after queuing clears the composer', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('activeSessionId', 'session-a');
      setState(storePath('sessionStatus', 'session-a', { type: 'busy' }));
      flushSolid();
      setInputTextAndFlush('Queue this draft');
      renderChatInput();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      dispatchImagePaste(editor, [
        new File(['%PDF-1.7\n'], 'queue-delayed.pdf', { type: 'application/pdf' }),
      ]);
      await settle();
      expect(fileReader.hasPending('queue-delayed.pdf')).toBe(true);

      clickSelectorAndFlush('[aria-label="Add to queue (Enter)"]');
      await settle();
      expect(inputText()).toBe('');
      expect(state.queuedMessages).toHaveLength(1);

      fileReader.resolve('queue-delayed.pdf');
      await settle();

      expect(state.nativePdfs).toEqual([]);
    });
  });

  it('does not attach a delayed pasted PDF after the composer is disposed', async () => {
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      dispatchImagePaste(editor, [
        new File(['%PDF-1.7\n'], 'disposed-delayed.pdf', { type: 'application/pdf' }),
      ]);
      await settle();
      expect(fileReader.hasPending('disposed-delayed.pdf')).toBe(true);

      cleanup!();
      flushSolid();
      cleanup = undefined;
      fileReader.resolve('disposed-delayed.pdf');
      await settle();

      expect(state.nativePdfs).toEqual([]);
    });
  });

  it('preserves image/PDF/image paste order when the PDF finishes first', async () => {
    await withControllableFileReader(async (fileReader) => {
      setupModelState();
      renderChatInput();
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      dispatchImagePaste(editor, [
        new File(['first'], 'first.png', { type: 'image/png' }),
        new File(['%PDF-1.7\n'], 'middle.pdf', { type: 'application/pdf' }),
        new File(['last'], 'last.png', { type: 'image/png' }),
      ]);
      await settle();
      fileReader.resolve('middle.pdf');
      await settle();
      fileReader.resolve('last.png');
      flushSolid();
      fileReader.resolve('first.png');
      await settle();
      expect(state.clipboardImages).toHaveLength(2);
      expect(state.nativePdfs).toHaveLength(1);
      const pdfSequence = state.nativePdfs[0]!.attachmentSequence!;
      expect(state.clipboardImages[0]!.attachmentSequence!).toBeLessThan(pdfSequence);
      expect(state.clipboardImages[1]!.attachmentSequence!).toBeGreaterThan(pdfSequence);
    });
  });

  it('keeps a delayed pasted PDF when the user types before it finishes', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('activeSessionId', 'session-a');
      renderChatInput();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      dispatchImagePaste(editor, [
        new File(['%PDF-1.7\n'], 'typing-delayed.pdf', { type: 'application/pdf' }),
      ]);
      await settle();
      expect(fileReader.hasPending('typing-delayed.pdf')).toBe(true);

      enterComposerText(editor, 'Keep typing');
      fileReader.resolve('typing-delayed.pdf');
      await settle();

      expect(inputText()).toBe('Keep typing');
      expect(state.nativePdfs).toMatchObject([{ filename: 'typing-delayed.pdf' }]);
    });
  });

  it('hides pre-input status blocks while a diff overlay is expanded', () => {
    setStateAndFlush('todos', [
      { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'medium' },
    ]);
    renderChatInput();

    expect(container?.querySelector('.todo-block')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.chat-input-shell')).toBeInstanceOf(HTMLElement);

    setExpandedDiffOverlay(testDiffOverlayOwner, true);
    flushSolid();

    expect(container?.querySelector('.todo-block')).toBeNull();
    expect(container?.querySelector('.chat-input-shell')).toBeInstanceOf(HTMLElement);

    setExpandedDiffOverlay(testDiffOverlayOwner, false);
    flushSolid();

    expect(container?.querySelector('.todo-block')).toBeInstanceOf(HTMLElement);
  });

  it('collapses an expanded diff overlay when sending a message', async () => {
    const collapse = vi.fn(() => setExpandedDiffOverlay(testDiffOverlayOwner, false));
    setExpandedDiffOverlay(testDiffOverlayOwner, true, collapse);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Continue with this change');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    expect(collapse).toHaveBeenCalledTimes(1);
    expect(hasExpandedDiffOverlay()).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledWith('Continue with this change', { noReply: false });
  });

  it('sends to the composer session when navigation races slash-command detection', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Send to the original chat');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    setStateAndFlush('activeSessionId', 'session-2');
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'Send to the original chat',
      expect.objectContaining({ targetSessionId: 'session-1' })
    );
    expect(inputText()).toBe('');
    setState(storePath('activeSessionId', 'session-1'));
    expect(inputText()).toBe('');
  });

  it('keeps a draft send separate when an existing session opens during detection', async () => {
    setInputTextAndFlush('Send to a new chat');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    setStateAndFlush('activeSessionId', 'session-2');
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'Send to a new chat',
      expect.objectContaining({ targetSessionId: null })
    );
  });

  it('keeps sending disabled until initial message hydration completes', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messagesLoading', true);
    setInputTextAndFlush('Send after hydration');
    renderChatInput();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(true);
    sendButton?.click();
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setStateAndFlush('messagesLoading', false);
    await settle();

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
      flushSolid();

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

  it.each([false, true])(
    'attaches pathless external folders after the drop data expires, remote=%s',
    async (remoteExtensionHost) => {
      const bridgeWindow = fixture<{
        __sendToExtension?: (message: WebviewMessage) => void;
        __initialWebviewState?: { remoteExtensionHost: boolean };
      }>(window);
      const originalSend = bridgeWindow.__sendToExtension;
      const originalState = bridgeWindow.__initialWebviewState;
      const sent: WebviewMessage[] = [];
      bridgeWindow.__sendToExtension = (message) => sent.push(message);
      bridgeWindow.__initialWebviewState = { remoteExtensionHost };
      const file = new File(['hello'], 'note.txt');
      const child = fixture<FileSystemFileEntry>({
        name: 'note.txt',
        isFile: true,
        isDirectory: false,
        file: (resolve: (value: File) => void) => resolve(file),
      });
      const root = fixture<FileSystemDirectoryEntry>({
        name: 'external',
        isDirectory: true,
        createReader: () => {
          let read = false;
          return {
            readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
              resolve(read ? [] : [child]);
              read = true;
            },
          };
        },
      });
      const folderFile = new File([], 'external');
      const transfer = fixture<DataTransfer>({
        types: ['Files'],
        files: [folderFile],
        items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => folderFile }],
        getData: () => '',
      });
      try {
        renderChatInput();
        dispatchDragEvent(container!.querySelector('.chat-input-container')!, 'drop', transfer);
        flushSolid();
        Object.defineProperties(transfer, {
          files: { value: [] },
          items: { value: [] },
        });
        await vi.waitFor(() =>
          expect(sent).toContainEqual({
            type: 'files/drop-content',
            payload: {
              directory: { name: 'external', directories: [] },
              files: [{ name: 'note.txt', content: btoa('hello'), size: 5 }],
            },
          })
        );
        flushSolid();
        expect(sent.filter((message) => message.type === 'files/drop-content')).toHaveLength(1);
      } finally {
        bridgeWindow.__sendToExtension = originalSend;
        bridgeWindow.__initialWebviewState = originalState;
      }
    }
  );

  it('keeps external folder drops path-based when the host exposes their path', async () => {
    const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    const createReader = vi.fn();
    const root = fixture<FileSystemDirectoryEntry>({
      name: 'external',
      isDirectory: true,
      createReader,
    });
    const file = fixture<File>({ name: 'external', path: '/outside/external' });
    const transfer = fixture<DataTransfer>({
      types: ['Files'],
      files: [file],
      items: [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => root }],
      getData: () => '',
    });
    try {
      renderChatInput();
      dispatchDragEvent(container!.querySelector('.chat-input-container')!, 'drop', transfer);
      flushSolid();
      await vi.waitFor(() =>
        expect(sent).toContainEqual({
          type: 'files/drop',
          payload: { paths: ['/outside/external'] },
        })
      );
      flushSolid();
      expect(createReader).not.toHaveBeenCalled();
    } finally {
      bridgeWindow.__sendToExtension = originalSend;
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
      flushSolid();

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
    setInputTextAndFlush('Ask the sub-agent');
    setIsLoadingAndFlush(true);

    expect(() => {
      cleanup = render(() => ChatInput(), container!);
    }).not.toThrow();
  });

  it.each([
    ['/stats', false],
    ['/stats all', true],
  ] as const)(
    'runs %s without opening or sending a chat message',
    async (command, includeAllTime) => {
      // SAFETY: The fixture provides the unknown fields read by this statement.
      const bridgeWindow = window as {
        __sendToExtension?: (message: WebviewMessage) => void;
      };
      const originalSend = bridgeWindow.__sendToExtension;
      const sent: WebviewMessage[] = [];
      const onBeforeSend = vi.fn();
      bridgeWindow.__sendToExtension = (message) => sent.push(message);
      setInputTextAndFlush(command);

      try {
        cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);
        flushSolid();
        pressComposerEnter();
        await settle();

        expect(sent).toContainEqual({
          type: 'usage/report',
          payload: { includeAllTime },
        });
        expect(onBeforeSend).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
      } finally {
        if (originalSend) bridgeWindow.__sendToExtension = originalSend;
        else delete bridgeWindow.__sendToExtension;
      }
    }
  );

  it('shows an active hidden session model without falling back to the first visible model', () => {
    setStateAndFlush('providers', [
      apiProvider('zai-coding-plan', 'Z.AI Coding Plan', [toolModel('glm-5.2', 'GLM-5.2')]),
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-5.6-luna', 'GPT-5.6 Luna', { variants: { max: {} } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { 'zai-coding-plan': 'glm-5.2' });
    setStateAndFlush('hiddenModels', ['openai:gpt-5.6-luna']);
    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
      variant: 'max',
    });

    renderChatInput();

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(modelButton?.textContent).toContain('GPT-5.6 Luna');
    expect(modelButton?.textContent).not.toContain('GLM-5.2');
  });

  it('uses the busy placeholder while a child session is still working', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
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
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'busy' },
    });

    renderChatInput();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'idle' },
    });
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Queue a follow-up or steer'
    );

    await vi.advanceTimersByTimeAsync(700);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
      'Describe what to build'
    );
  });

  it('links to the Varro repository when no status metadata is available', () => {
    setStateAndFlush('activeSessionId', null);
    setStateAndFlush('mcpStatus', {});
    setStateAndFlush('lspStatus', []);
    setStateAndFlush('providerLimits', {});
    renderChatInput();

    const repositoryLink = container?.querySelector<HTMLAnchorElement>('.toolbar-repository-link');
    expect(repositoryLink?.href).toBe(packageJson.repository);
    expect(repositoryLink?.textContent).toBe(`v${packageJson.version}`);
    expect(repositoryLink?.getAttribute('aria-label')).toBe(
      `Varro v${packageJson.version} on GitHub`
    );
  });

  it('shows configured MCP selections independently of connection status and toggles the picker', async () => {
    renderChatInput();

    expect(container?.querySelector('.toolbar-mcp-count')).toBeNull();

    setStateAndFlush('mcpStatus', {
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
      gamma: { status: 'connected' },
      delta: { status: 'failed' },
    });
    setStateAndFlush('mcpDefaults', {
      global: { alpha: true, beta: false, gamma: true, delta: false },
      project: {},
      effective: { alpha: true, beta: false, gamma: true, delta: false },
      editable: true,
    });

    const mcpCount = container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count');
    expect(mcpCount?.textContent).toContain('MCPs:');
    expect(mcpCount?.textContent).toContain('2/4');
    expect(mcpCount?.getAttribute('aria-label')).toBe('2 of 4 MCPs enabled');
    expect(mcpCount?.querySelector('.toolbar-mcp-count-separator')?.textContent).toBe('/');

    mcpCount?.click();
    flushSolid();
    await waitForDropdown();
    flushSolid();

    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('alpha');
    expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('gamma');

    mcpCount?.click();
    flushSolid();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();

    mcpCount?.click();
    flushSolid();
    await waitForDropdown();
    flushSolid();

    document.body.click();
    flushSolid();
    expect(container?.querySelector('.dropdown-menu')).toBeNull();

    setStateAndFlush('mcpStatus', {
      alpha: { status: 'failed' },
      beta: { status: 'needs_auth' },
      gamma: { status: 'failed' },
      delta: { status: 'disabled' },
    });
    expect(container?.querySelector('.toolbar-mcp-count')?.textContent).toContain('2/4');

    setStateAndFlush('mcpStatus', {
      alpha: { status: 'disabled' },
      beta: { status: 'disabled' },
      gamma: { status: 'disabled' },
      delta: { status: 'disabled' },
    });
    setState(
      storePath('mcpDefaults', 'effective', {
        alpha: false,
        beta: false,
        gamma: false,
        delta: false,
      })
    );
    flushSolid();
    const disconnectedCount = container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count');
    expect(disconnectedCount?.textContent).toContain('0/4');
  });

  it.each(['/mcp', '/mcps'])(
    'opens Manage MCPs for %s when no servers are configured',
    async (command) => {
      setShowMcpSettings(false);
      flushSolid();
      setState((draft) => {
        const current = draft['mcpStatus'];
        const incoming = {} satisfies typeof current;
        if (
          incoming === null ||
          incoming === undefined ||
          current === null ||
          current === undefined
        )
          draft['mcpStatus'] = incoming;
        else reconcile(incoming)(current);
      });
      flushSolid();
      setState((draft) => {
        const current = draft['mcpDefaults'];
        const incoming = {
          global: {},
          project: {},
          effective: {},
          editable: true,
        } satisfies typeof current;
        if (
          incoming === null ||
          incoming === undefined ||
          current === null ||
          current === undefined
        )
          draft['mcpDefaults'] = incoming;
        else reconcile(incoming)(current);
      });
      flushSolid();
      setInputTextAndFlush(command);
      renderChatInput();
      pressComposerEnter();
      await settle();
      expect(showMcpSettings()).toBe(true);
      expect(container?.querySelector('.dropdown-menu')).toBeNull();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(inputText()).toBe('');
      setShowMcpSettings(false);
      flushSolid();
    }
  );

  it('shows cumulative active-turn duration only while the turn is working', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(70_000);
    flushSolid();
    setShowTurnTimer(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 70_000)]);
    const userMessage = {
      info: {
        id: 'user-1',
        sessionID: 'session-1',
        role: 'user',
        time: { created: 70_000 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      },
      parts: [
        {
          id: 'prompt-text',
          messageID: 'user-1',
          sessionID: 'session-1',
          type: 'text',
          text: 'Fix the scrollbar regression',
        },
      ],
    } satisfies MessageEntry<UserMessage>;
    const assistantMessage = assistantMessageEntry({ input: 0, output: 0 });
    assistantMessage.info.time.created = 70_000;
    setStateAndFlush('messages', [userMessage, assistantMessage]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setLoadingLastActivityAt(70_000);
    flushSolid();

    renderChatInput();

    expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    const timer = container?.querySelector('.toolbar-turn-timer');
    expect(timer?.textContent).toBe('1s');
    expect(timer?.getAttribute('aria-label')).toBe('Active turn duration: 1s');
    await vi.advanceTimersByTimeAsync(9_000);
    flushSolid();
    expect(timer?.textContent).toBe('10s');
    expect(timer?.getAttribute('aria-label')).toBe('Active turn duration: 10s');
    expect(
      timer
        ?.querySelector<HTMLElement>('.toolbar-turn-timer-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(runningIcon));

    expect(container?.querySelector('.toolbar-turn-timer-icon.is-stale')).toBeNull();

    setLoadingLastActivityAt(Date.now());
    flushSolid();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer-icon.is-stale')).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer-icon.is-stale')).not.toBeNull();

    setLoadingLastActivityAt(Date.now());
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer-icon.is-stale')).toBeNull();

    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer')).not.toBeNull();

    setStateAndFlush('messages', [
      userMessage,
      {
        ...assistantMessage,
        info: {
          ...assistantMessage.info,
          finish: 'stop',
          time: { ...assistantMessage.info.time, completed: Date.now() },
        },
      },
    ]);
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();
  });

  it.each([false, true])(
    'keeps cumulative turn duration during background waiting, initially pending: %s',
    async (initiallyPending) => {
      vi.useFakeTimers();
      vi.setSystemTime(80_000);
      flushSolid();
      setShowTurnTimer(true);
      flushSolid();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 70_000)]);
      const userMessage = {
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 70_000 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4o' },
        },
        parts: [
          {
            id: 'prompt-text',
            messageID: 'user-1',
            sessionID: 'session-1',
            type: 'text',
            text: 'Fix the scrollbar regression',
          },
        ],
      } satisfies MessageEntry<UserMessage>;
      const assistant = assistantMessageEntry({ input: 0, output: 0 });
      assistant.info.time = { created: 71_000 };
      const interim = {
        ...assistant,
        info: { ...assistant.info, finish: 'stop', time: { created: 71_000, completed: 80_000 } },
      };
      setStateAndFlush('messages', [userMessage, initiallyPending ? interim : assistant]);
      setState(
        storePath(
          'sessionStatus',
          'session-1',
          initiallyPending
            ? { type: 'busy', background: true, backgroundStartedAt: 79_000 }
            : { type: 'busy' }
        )
      );
      flushSolid();
      renderChatInput();
      const timer = container?.querySelector('.toolbar-turn-timer');
      expect(timer?.textContent).toBe('10s');
      setState(
        storePath('sessionStatus', 'session-1', {
          type: 'busy',
          background: true,
          backgroundStartedAt: 79_000,
        })
      );
      flushSolid();
      setStateAndFlush('messages', [userMessage, interim]);
      await vi.advanceTimersByTimeAsync(20_000);
      flushSolid();
      expect(container?.querySelector('.toolbar-turn-timer')).toBe(timer);
      expect(timer?.textContent).toBe('30s');

      const resumed = {
        ...assistant,
        info: { ...assistant.info, id: 'assistant-resumed', time: { created: Date.now() } },
      };
      setStateAndFlush('messages', [userMessage, interim, resumed]);
      setState((draft) => {
        const current = draft['sessionStatus']['session-1'];
        const incoming = { type: 'busy' } satisfies typeof current;
        if (
          incoming === null ||
          incoming === undefined ||
          current === null ||
          current === undefined
        )
          draft['sessionStatus']['session-1'] = incoming;
        else reconcile(incoming)(current);
      });
      flushSolid();
      await vi.advanceTimersByTimeAsync(10_000);
      flushSolid();
      expect(timer?.textContent).toBe('40s');
      setStateAndFlush('messages', [
        userMessage,
        interim,
        {
          ...resumed,
          info: {
            ...resumed.info,
            finish: 'stop',
            time: { ...resumed.info.time, completed: Date.now() },
          },
        },
      ]);
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();
    }
  );

  it.each([
    'background notice',
    'compaction',
    'continuation',
    'recovery',
    'pending steer',
    'delivered steer',
  ])('keeps timing the original prompt through a %s', async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_188_000);
    flushSolid();
    setShowTurnTimer(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 100_000)]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    const prompt: MessageEntry<UserMessage> = {
      info: {
        id: 'user-1',
        sessionID: 'session-1',
        role: 'user',
        time: { created: 100_000 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      },
      parts: [
        {
          id: 'prompt-text',
          messageID: 'user-1',
          sessionID: 'session-1',
          type: 'text',
          text: 'Fix the scrollbar regression',
        },
      ],
    };
    const assistant: MessageEntry<AssistantMessage> = assistantMessageEntry({
      input: 0,
      output: 0,
    });
    assistant.info.time.created = 101_000;
    assistant.info.time.completed = 200_000;
    assistant.info.finish = 'tool_calls';
    setStateAndFlush('messages', [prompt, assistant]);
    renderChatInput();
    const timer = container?.querySelector('.toolbar-turn-timer');
    expect(timer?.textContent).toBe('18m 8s');

    const notice: MessageEntry<UserMessage> = {
      info: {
        ...prompt.info,
        id: 'notice',
        time: { created: 1_154_000 },
        pendingDelivery: kind === 'pending steer' ? 'steer' : undefined,
      },
      parts: [],
    };
    setStateAndFlush('messages', [prompt, assistant, notice]);
    expect(timer?.textContent).toBe('18m 8s');

    const identity = { id: 'notice-part', messageID: 'notice', sessionID: 'session-1' };
    const part: Part =
      kind === 'compaction'
        ? { ...identity, type: 'compaction', auto: true, status: 'running' }
        : {
            ...identity,
            type: 'text',
            synthetic: kind !== 'pending steer' && kind !== 'delivered steer',
            text:
              kind === 'background notice'
                ? '<shell id="test" state="completed">Done</shell>'
                : kind === 'recovery'
                  ? 'The previous response was interrupted. Continue working.'
                  : kind === 'continuation'
                    ? 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.'
                    : 'Run the remaining tests',
          };
    setStateAndFlush('messages', [prompt, assistant, { ...notice, parts: [part] }]);
    expect(timer?.textContent).toBe('18m 8s');
    const resumed = {
      ...assistant,
      info: { ...assistant.info, id: 'assistant-resumed', time: { created: Date.now() } },
    };
    setStateAndFlush('messages', [prompt, assistant, { ...notice, parts: [part] }, resumed]);
    await vi.advanceTimersByTimeAsync(2_000);
    flushSolid();
    expect(timer?.textContent).toBe('18m 10s');
    expect(container?.querySelector('.toolbar-turn-timer')).toBe(timer);

    cleanup!();
    flushSolid();
    renderChatInput();
    expect(container?.querySelector('.toolbar-turn-timer')?.textContent).toBe('18m 10s');

    const completed = {
      ...resumed,
      info: {
        ...resumed.info,
        finish: 'stop',
        time: { ...resumed.info.time, completed: Date.now() },
      },
    };
    const history = [prompt, assistant, { ...notice, parts: [part] }, completed];
    setStateAndFlush('messages', history);
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();

    const nextPrompt = {
      ...prompt,
      info: { ...prompt.info, id: 'next-prompt', time: { created: Date.now() } },
      parts: [{ ...prompt.parts[0]!, id: 'next-prompt-text', messageID: 'next-prompt' }],
    };
    const nextAssistant = {
      ...resumed,
      info: {
        ...resumed.info,
        id: 'next-assistant',
        parentID: 'next-prompt',
        time: { created: Date.now() },
      },
    };
    setStateAndFlush('messages', [...history, nextPrompt, nextAssistant]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    // A stale loading clock from the prior turn must not carry into the new turn.
    setLoadingStartedAt(100_000);
    flushSolid();
    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(container?.querySelector('.toolbar-turn-timer')?.textContent).toBe('10s');
  });

  it('hides the active-turn timer in the new-session composer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000);
    flushSolid();
    setShowTurnTimer(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setIsLoadingAndFlush(true);
    setLoadingStartedAt(70_000);
    flushSolid();

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    expect(container?.querySelector('.toolbar-turn-timer')).toBeNull();
  });

  it('hides the MCP control while editing a message', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('mcpStatus', {
      alpha: { status: 'disabled' },
    });
    renderChatInput();

    expect(container?.querySelector('.toolbar-mcp-count')).not.toBeNull();

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.toolbar-mcp-count')).toBeNull();
  });

  it('shows one MCP count when every available MCP is enabled', () => {
    setStateAndFlush('mcpStatus', { alpha: { status: 'connected' } });
    const availableNames = Object.keys(state.mcpStatus);
    setStateAndFlush('draftSelectedMcps', availableNames);
    renderChatInput();

    const mcpValue = container?.querySelector('.toolbar-mcp-count-value');
    expect(mcpValue?.textContent).toBe(String(availableNames.length));
    expect(mcpValue?.textContent).not.toContain('/');
    expect(mcpValue?.querySelector('.toolbar-mcp-count-separator')).toBeNull();
  });

  it('shows active LSPs before MCPs and opens a read-only list', async () => {
    setStateAndFlush('mcpStatus', { docs: { status: 'connected' } });
    renderChatInput();

    expect(container?.querySelector('.toolbar-lsp-count')).toBeNull();

    setStateAndFlush('lspStatus', [
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
    flushSolid();
    await waitForDropdown();
    flushSolid();

    const dropdown = container?.querySelector('.dropdown-menu');
    expect(dropdown?.textContent).toContain('LSPs');
    expect(dropdown?.textContent).toContain('Oxlint');
    expect(dropdown?.textContent).toContain('TypeScript');
    expect(dropdown?.querySelectorAll('.lsp-picker-item')).toHaveLength(2);
    expect(dropdown?.querySelector('button')).toBeNull();
  });

  it('shows weekly quota warnings above the composer and gives hard-limit notices priority', () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', Date.now())]);
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': {
        providerID: 'openai',
        modelID: 'gpt-4o',
        status: 'available',
        source: 'provider',
        checkedAt: Date.now(),
        usageLimitResets: { availableCount: 1, credits: null },
        windows: [
          {
            id: 'five_hour',
            label: '5-hour limit',
            unit: 'unknown',
            remaining: 90,
            limit: 100,
            resetAt: Date.now() + 60_000,
          },
          {
            id: 'seven_day',
            label: 'Weekly limit',
            unit: 'unknown',
            remaining: 8,
            limit: 100,
            resetAt: Date.now() + 86_400_000,
          },
        ],
      },
    });
    renderChatInput();
    const warning = container?.querySelector('.chat-quota-warning');
    expect(warning?.textContent).toContain('Weekly limit: 8% left');
    expect(warning?.textContent).not.toContain('5-hour limit');
    expect(warning?.nextElementSibling?.classList.contains('chat-input-shell')).toBe(true);
    container?.querySelector<HTMLButtonElement>('.chat-quota-warning-usage')?.click();
    flushSolid();
    expect(container?.querySelector('.provider-limit-reset-rows')).not.toBeNull();
    expect(container?.querySelector<HTMLAnchorElement>('.provider-limit-reset-link')?.href).toBe(
      'https://chatgpt.com/settings/usage?tab=overview'
    );

    setSessionUsageLimit('session-1', {
      source: 'status',
      statusCode: 429,
      message: 'messages exhausted',
      unit: 'messages',
      retryAt: null,
      attempt: 1,
      sessionID: 'session-1',
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
    flushSolid();
    expect(container?.querySelector('.chat-quota-warning')).toBeNull();
    expect(container?.querySelector('.provider-limit-popup')).toBeNull();
    expect(container?.querySelector('.chat-usage-limit-banner')).not.toBeNull();
  });

  it('shows all available provider-limit windows under the fixed threshold', async () => {
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [toolModel('gpt-4o', 'GPT-4o')]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-4o' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setStateAndFlush('providerLimits', {
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

    renderChatInput();

    const chip = container?.querySelector('.toolbar-limit-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('41%');
    expect(chip?.textContent).toContain('80%');
    expect(container?.querySelector('.chat-quota-warning')).toBeNull();
    setStateAndFlush('debugShowQuotaWarning', true);
    expect(container?.querySelector('.chat-quota-warning')?.textContent).toContain(
      '5-Hour Limit: 41% left'
    );
    setStateAndFlush('debugShowQuotaWarning', false);
    expect(container?.querySelector('.chat-quota-warning')).toBeNull();

    const checkedAt = Date.now() - 120_000;
    setState(
      storePath('providerLimits', 'openai:gpt-4o', {
        checkedAt,
        note: 'Refresh failed; showing last known limits.',
      })
    );
    flushSolid();
    expect(chip?.getAttribute('aria-label')).toContain(
      'Refresh failed; showing last known limits.'
    );
    expect(chip?.getAttribute('aria-label')).not.toContain('Snapshot age:');
    container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip')?.click();
    await settle();
    const popup = container?.querySelector('.provider-limit-popup');
    expect(popup).not.toBeNull();
    expect(popup?.textContent).not.toContain('Refresh failed; showing last known limits.');
    expect(popup?.textContent).not.toContain('Snapshot age:');
    expect(popup?.querySelector('.provider-limit-row-meta')?.textContent).toBe('41 left');
    expect(state.providerLimits['openai:gpt-4o']?.checkedAt).toBe(checkedAt);
  });

  it.each(['zai', 'zai-coding-plan'])(
    'hides unavailable %s limits and restores the control after recovery',
    async (providerID) => {
      setStateAndFlush('providers', [
        {
          id: providerID,
          name: 'Z.ai',
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
      setStateAndFlush('providerDefaults', { [providerID]: 'glm-4.5' });
      setStateAndFlush('selectedModel', { providerID, modelID: 'glm-4.5' });
      const key = `${providerID}:glm-4.5`;
      const fresh = availableProviderLimit({
        providerID,
        modelID: 'glm-4.5',
        checkedAt: Date.now(),
      });
      setStateAndFlush('providerLimits', {
        [key]: {
          providerID,
          modelID: 'glm-4.5',
          status: 'unsupported',
          source: 'provider',
          checkedAt: Date.now(),
          note: 'Provider quota checks are not supported in attach-only mode without a server-owned limits endpoint.',
        },
      });
      renderChatInput();
      expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
      expect(container?.querySelector('.provider-limit-popup')).toBeNull();

      setStateAndFlush('providerLimits', { [key]: fresh });
      const chip = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
      expect(chip).not.toBeNull();
      chip?.click();
      await settle();
      expect(chip?.getAttribute('aria-expanded')).toBe('true');

      setStateAndFlush('providerLimits', {
        [key]: {
          ...fresh,
          stale: true,
          retryAt: Date.now() + 15_000,
          note: 'Z.ai quota endpoint returned invalid quota data',
        },
      });
      expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('Stale');
      expect(container?.querySelector('.provider-limit-popup')?.textContent).toContain(
        'Quota data is stale'
      );

      setStateAndFlush('providerLimits', {
        [key]: {
          providerID,
          modelID: 'glm-4.5',
          status: 'unsupported',
          source: 'provider',
          checkedAt: Date.now(),
          failureKind: 'authentication',
          retryAt: Date.now() + 5 * 60_000,
          note: 'Z.ai quota endpoint rejected credentials (401)',
        },
      });
      expect(container?.querySelector('.toolbar-limit-chip')).toBeNull();
      expect(container?.querySelector('.provider-limit-popup')).toBeNull();

      setStateAndFlush('providerLimits', { [key]: fresh });
      expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
      expect(container?.querySelector('.toolbar-limit-chip')?.textContent).not.toContain(
        'Unavailable'
      );
      expect(container?.querySelector('.toolbar-limit-chip')?.textContent).not.toContain('Stale');
      expect(container?.querySelector('.toolbar-limit-chip')?.getAttribute('aria-expanded')).toBe(
        'false'
      );
      expect(container?.querySelector('.provider-limit-popup')).toBeNull();
      container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip')?.click();
      await settle();
      expect(container?.querySelector('.provider-limit-popup')?.textContent).not.toContain(
        'Authentication failed'
      );
      expect(container?.querySelector('.provider-limit-row')).not.toBeNull();
    }
  );

  it('shows Z.ai quota windows and available resets', async () => {
    setStateAndFlush('providers', [
      apiProvider('zai-coding-plan', 'Z.AI Coding Plan', [toolModel('glm-4.5', 'GLM-4.5')]),
    ]);
    setStateAndFlush('providerDefaults', { 'zai-coding-plan': 'glm-4.5' });
    setStateAndFlush('selectedModel', { providerID: 'zai-coding-plan', modelID: 'glm-4.5' });
    setStateAndFlush('providerLimits', {
      'zai-coding-plan:glm-4.5': {
        providerID: 'zai-coding-plan',
        modelID: 'glm-4.5',
        status: 'available',
        source: 'provider',
        checkedAt: 1,
        usageLimitResets: {
          availableCount: 1,
          credits: [
            {
              title: 'Weekly quota reset',
              expiresAt: Date.parse('2026-09-20T12:00:00Z'),
            },
          ],
        },
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

    renderChatInput();

    const chip = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(chip?.textContent).toContain('87%');
    expect(chip?.textContent).toContain('98%');
    expect(chip?.textContent).not.toContain('100%');

    clickAndFlush(chip);
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector('.provider-limit-popup');
    expect(popup?.textContent).toContain('5 Hours Quota');
    expect(popup?.textContent).toContain('Weekly Quota');
    expect(popup?.textContent).toContain('MCP Quota');
    expect(popup?.textContent).toContain('13% used');
    expect(popup?.textContent).toContain('2% used');
    expect(popup?.textContent).not.toContain('87 left');
    expect(popup?.textContent).not.toContain('98 left');
    expect(popup?.textContent).toContain('1,000 left');
    const resetToggle = popup?.querySelector<HTMLButtonElement>('.provider-limit-reset-toggle');
    expect(resetToggle?.textContent).toContain('Usage limit resets (1)');

    resetToggle?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(popup?.textContent).not.toContain('Weekly quota reset');
    expect(popup?.textContent).toContain('Expires');
    expect(popup?.querySelector<HTMLAnchorElement>('.provider-limit-reset-link')?.href).toBe(
      'https://z.ai/manage-apikey/coding-plan/personal/usage'
    );
  });

  it('shows OpenAI usage-limit resets in a collapsed read-only popup section', async () => {
    setupModelState();
    const expiresAt = Date.parse('2026-09-20T19:23:00Z');
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        usageLimitResets: {
          availableCount: 3,
          credits: [
            { title: 'Full reset', expiresAt },
            { title: 'Non-expiring reset', expiresAt: null },
          ],
        },
      }),
    });

    renderChatInput();

    container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip')?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const toggle = container?.querySelector<HTMLButtonElement>('.provider-limit-reset-toggle');
    expect(toggle?.textContent).toContain('Usage limit resets (3)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.provider-limit-reset-rows')).toBeNull();

    toggle?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const expectedExpiration = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(expiresAt);
    const rows = container?.querySelector('.provider-limit-reset-rows');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(rows?.tagName).toBe('UL');
    expect(rows?.querySelectorAll('li')).toHaveLength(3);
    expect(rows?.textContent).not.toContain('Full reset');
    expect(rows?.textContent).toContain(`Expires ${expectedExpiration}`);
    expect(rows?.textContent).toContain('Non-expiring reset');
    expect(rows?.textContent).toContain('Does not expire');
    expect(rows?.textContent).toContain('Expiration details unavailable for 1 reset.');
    const usageLink = container?.querySelector<HTMLAnchorElement>('.provider-limit-reset-link');
    expect(usageLink?.textContent).toContain('ChatGPT Usage');
    expect(usageLink?.href).toBe('https://chatgpt.com/settings/usage?tab=overview');
    expect(container?.querySelector('button')?.textContent).not.toContain('Use reset');

    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({
        usageLimitResets: {
          availableCount: 0,
          credits: [],
        },
      }),
    });
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.provider-limit-reset-section')).toBeNull();
  });

  it('filters provider-limit badges and popup rows for the selected model', async () => {
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [toolModel('gpt-4o', 'GPT-4o')]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-4o' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setStateAndFlush('providerLimits', {
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

    renderChatInput();

    const chip = container?.querySelector('.toolbar-limit-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('39%');
    expect(chip?.textContent).toContain('80%');
    expect(chip?.textContent).not.toContain('10%');

    clickAndFlush(chip);
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector('.provider-limit-popup');
    expect(popup?.textContent).toContain('5-Hour Limit');
    expect(popup?.textContent).toContain('Monthly Limit');
    expect(popup?.textContent).not.toContain('5-Hour Spark Limit');
  });

  it('shows provider-limit UI for a monthly-only Copilot-style limit', () => {
    setStateAndFlush('providers', [
      apiProvider('github-copilot', 'GitHub Copilot', [toolModel('gpt-5-mini', 'GPT-5 mini')]),
    ]);
    setStateAndFlush('providerDefaults', { 'github-copilot': 'gpt-5-mini' });
    setStateAndFlush('selectedModel', { providerID: 'github-copilot', modelID: 'gpt-5-mini' });
    setStateAndFlush('providerLimits', {
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

    renderChatInput();

    expect(container?.querySelector('.toolbar-limit-chip')).not.toBeNull();
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('Limits:');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('60%');
  });

  it('keeps the selected provider-limit window after limit refreshes', async () => {
    setupModelState();
    setStateAndFlush('providerLimits', {
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

    renderChatInput();

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('80%');

    setStateAndFlush('providerLimits', {
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
    flushSolid();

    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('39%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('30%');
    expect(container?.querySelector('.toolbar-limit-chip')?.textContent).toContain('1%');
  });

  it('shows context usage before assistant tokens are available', async () => {
    setupModelState();
    setState(storePath('providers', 0, 'models', 'gpt-4o', 'name', 'GPT-5.6 Fast'));
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 0, output: 0 })]);

    renderChatInput();

    const button = container?.querySelector<HTMLButtonElement>('.chat-context-usage');
    expect(button?.getAttribute('aria-label')).toBe('Context usage unavailable');
    expect(button?.getAttribute('title')).toBeNull();

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.context-popup-pct')?.textContent).toBe('--');
    expect(container?.querySelector('.context-popup-pct')?.classList).toContain('unavailable');
    expect(container?.querySelector('.context-popup-stat')?.textContent).toBe('--/1,000tokens');
    expect(container?.querySelector('.context-popup-model')?.textContent).toBe(
      'OpenAI / GPT-5.6 Fast'
    );

    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    await Promise.resolve();
    flushSolid();

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
    flushSolid();

    expect(container?.querySelector('.chat-context-usage')).toBeNull();
  });

  it('keeps the context button accessible while the popup is open', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();

    const button = container?.querySelector<HTMLButtonElement>('.chat-context-usage');
    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.context-popup')).not.toBeNull();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('Context usage (50%)');
  });

  it('shows the compact action starting at 30% context usage', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 290, output: 0 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.context-popup-action')).toBeNull();

    setStateAndFlush('messages', [assistantMessageEntry({ input: 300, output: 0 })]);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.context-popup-action')?.textContent).toBe('Compact session');
  });

  it('includes descendant session snapshots in the session token total', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, {
        parentID: 'session-1',
        tokens: {
          input: 500,
          output: 100,
          reasoning: 0,
          cache: { read: 50, write: 25 },
        },
      }),
    ]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const sections = [...(container?.querySelectorAll('.context-popup-section') || [])];
    expect(sections.map((section) => section.textContent)).toEqual([
      'Session Tokens',
      'Agents (1)625',
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
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(subagentToggle.getAttribute('aria-expanded')).toBe('true');
    expect(subagentToggle.querySelector('.context-popup-section-summary')).toBeNull();
    expect(readContextRows(sections[1])).toMatchObject({
      Input: '525',
      Output: '100',
      'Cache read': '50',
      'Cache write': '25',
      Total: '625',
    });
    const agentCacheReadRow = subagentToggle.nextElementSibling?.querySelector(
      '.context-popup-row-cache-read'
    );
    expect(agentCacheReadRow?.querySelector('.context-popup-cache-read-info')).not.toBeNull();
    const agentCacheWriteRow = subagentToggle.nextElementSibling?.querySelector(
      '.context-popup-row-cache-write'
    );
    expect(agentCacheWriteRow?.querySelector('.context-popup-cache-write-info')).not.toBeNull();
    expect(container?.querySelector('.context-popup-overall-total')?.textContent).toContain(
      'Overall1,125'
    );
  });

  it('shows unavailable root token details when only agents report usage', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
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
    setStateAndFlush('messages', [assistantMessageEntry({ input: 0, output: 0 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const sections = [...(container?.querySelectorAll('.context-popup-section') || [])];
    expect(sections.map((section) => section.textContent)).toEqual([
      'Session Tokens',
      'Agents (1)600',
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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000, {
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 25 },
        },
      }),
    ]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const sessionSection = container?.querySelector('.context-popup-section');
    expect(readContextRows(sessionSection ?? undefined)).toEqual({
      Input: '1,025',
      Output: '250',
      Reasoning: '50',
      'Cache read': '100',
      'Cache write': '25',
      Total: '1,275',
    });
  });

  it('dims cache reads and explains why they are excluded from session totals', async () => {
    vi.useFakeTimers();
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000, {
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 0,
          cache: { read: 100, write: 0 },
        },
      }),
    ]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const cacheReadRow = container?.querySelector('.context-popup-row-cache-read');
    const info = cacheReadRow?.querySelector<HTMLElement>('.context-popup-cache-read-info');
    const icon = info?.querySelector<HTMLElement>('.ui-icon');
    expect(cacheReadRow?.querySelector('.context-popup-row-label')?.textContent).toBe('Cache read');
    expect(cacheReadRow?.querySelector('.context-popup-row-value')?.textContent).toBe('100');
    expect(info?.tabIndex).toBe(0);
    expect(info?.getAttribute('aria-describedby')).toBeTruthy();
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(databaseBackupIcon));

    info?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Tokens reused from the provider's prompt cache. They count toward the context window but are excluded from session totals."
    );
  });

  it('dims cache writes and explains how they contribute to session totals', async () => {
    vi.useFakeTimers();
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000, {
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 25 },
        },
      }),
    ]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const cacheWriteRow = container?.querySelector('.context-popup-row-cache-write');
    const info = cacheWriteRow?.querySelector<HTMLElement>('.context-popup-cache-write-info');
    const icon = info?.querySelector<HTMLElement>('.ui-icon');
    expect(cacheWriteRow?.querySelector('.context-popup-row-label')?.textContent).toBe(
      'Cache write'
    );
    expect(cacheWriteRow?.querySelector('.context-popup-row-value')?.textContent).toBe('25');
    expect(info?.tabIndex).toBe(0);
    expect(info?.getAttribute('aria-describedby')).toBeTruthy();
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(databaseScriptPlusIcon));

    info?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Tokens stored in the provider's prompt cache for reuse by later requests. They count toward session input and totals."
    );
  });

  it('shows OpenCode session cost as a separate context detail row', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000, { cost: 0.01 })]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');
    await Promise.resolve();
    flushSolid();

    const costRow = container?.querySelector('.context-popup-cost-row');
    expect(costRow?.querySelector('.context-popup-row-label')?.textContent).toBe('Cost');
    expect(costRow?.querySelector('.context-popup-row-value')?.textContent).toBe('$0.01');
    expect(costRow?.querySelector('.context-popup-cost-info')).toBeNull();
  });

  it('loads tokens and costs for subagent sessions whose messages and snapshots are not loaded', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_000, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    vi.mocked(client.varro.session.diffSummary).mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 1_400,
      tokenBreakdown: {
        session: {
          cost: 0.004,
          total: 500,
          input: 400,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        subagents: {
          cost: 0.066,
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

    renderChatInput();
    clickSelectorAndFlush('.chat-context-usage');

    await vi.waitFor(() => {
      expect(container?.querySelector('.context-popup-section-toggle')?.textContent).toContain(
        'Agents (1)850'
      );
    });
    flushSolid();
    expect(client.varro.session.diffSummary).toHaveBeenCalledWith('session-1', undefined, {
      directory: '/repo',
    });
    expect(container?.querySelector('.context-popup-cost-row')?.textContent).toBe('Cost$0.07');
    expect(container?.querySelector('.toolbar-session-cost')?.textContent).toBe('0.07');
    expect(container?.querySelector('.toolbar-session-cost')?.getAttribute('aria-label')).toBe(
      'Overall cost: $0.07'
    );
    const costInfo = container?.querySelector<HTMLElement>('.context-popup-cost-info');
    expect(costInfo?.tabIndex).toBe(0);
    costInfo?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.waitFor(
      () => {
        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
          'Cost includes all subagents.'
        );
      },
      { timeout: 2_000 }
    );
    flushSolid();
    costInfo?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.context-popup-section-toggle')?.click();
    flushSolid();
    expect(container?.querySelectorAll('.context-popup-cost-row')).toHaveLength(1);

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
    flushSolid();
    await Promise.resolve();
    flushSolid();

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
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit({ planName: 'Pro' }),
    });

    renderChatInput();

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 61% used');
    expect(button?.getAttribute('title')).toBeNull();

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector('.provider-limit-popup');

    expect(popup).not.toBeNull();
    expect(popup?.querySelector('.provider-limit-popup-provider')?.textContent).toBe(
      'OpenAI · Pro'
    );
    expect(popup?.textContent).not.toContain('GPT-4o');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-label')).toContain('5-Hour Limit: 61% used');
  });

  it('renders permission, context usage, and provider limits in the lower metadata row', () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    renderChatInput();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('sessionPermissionModes', { 'session-1': 'auto' });
    setStateAndFlush('sessionAutoPermissionActivity', {
      'session-1': [{ permissionId: 'one', status: 'reviewing', title: 'one', createdAt: 2 }],
      'child-1': [{ permissionId: 'two', status: 'auto-approved', title: 'two', createdAt: 1 }],
    });

    renderChatInput();

    const dots = container?.querySelectorAll('.toolbar-meta .permission-activity-item') ?? [];
    expect(dots).toHaveLength(2);
    expect(dots[0]?.className).toContain('auto-approved');
    expect(dots[1]?.className).toContain('reviewing');
  });

  it('shows auto-approve activity only for the latest prompt', () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('sessionPermissionModes', { 'session-1': 'auto' });
    setStateAndFlush('sessionAutoPermissionActivity', {
      'session-1': [
        { permissionId: 'old-root', status: 'auto-approved', title: 'old', createdAt: 2 },
      ],
      'child-1': [
        { permissionId: 'old-child', status: 'auto-approved', title: 'old', createdAt: 2 },
      ],
    });

    renderChatInput();
    expect(container?.querySelectorAll('.toolbar-meta .permission-activity-item')).toHaveLength(2);

    const latestPrompt = historyEntry('user-2', 'Next prompt');
    latestPrompt.info.time.created = 3;
    setStateAndFlush('messages', [latestPrompt]);
    expect(container?.querySelectorAll('.toolbar-meta .permission-activity-item')).toHaveLength(0);

    setState(
      storePath('sessionAutoPermissionActivity', 'child-1', [
        { permissionId: 'new-child', status: 'reviewing', title: 'new', createdAt: 4 },
      ])
    );
    flushSolid();
    const dots = container?.querySelectorAll('.toolbar-meta .permission-activity-item') ?? [];
    expect(dots).toHaveLength(1);
    expect(dots[0]?.className).toContain('reviewing');
  });

  it('uses the full composer controls and starts a new session only when sending', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'existing-session');
    setStateAndFlush('sessionStatus', { 'existing-session': { type: 'busy' } });
    setInputTextAndFlush('Build a fresh feature');
    setStateAndFlush('droppedFiles', [
      { path: '/repo/src/new.ts', relativePath: 'src/new.ts', type: 'file' },
    ]);
    const onBeforeSend = vi.fn(() => {
      setState(storePath('activeSessionId', null));
      setState(storePath('droppedFiles', []));
    });
    sendMessageMock.mockImplementation(async (_text, options) => {
      options?.onOptimisticPublish?.();
      return true;
    });

    cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);
    flushSolid();

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    editor?.focus();
    flushSolid();

    expect(container?.querySelector('.model-picker-btn')).not.toBeNull();
    expect(container?.querySelector('.permission-mode-button')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).not.toBeNull();
    expect(onBeforeSend).not.toHaveBeenCalled();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

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
        attachedDiagnostics: undefined,
      },
      newSessionWorkspace: { scope: 'folder', directory: null },
      onOptimisticPublish: expect.any(Function),
      targetSessionId: null,
    });
  });

  it('preserves text entered while a normal send is pending', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();
    expect(inputText()).toBe('');

    setInputTextAndFlush('new draft while sending');
    resolveSend?.(false);
    await settle();

    expect(inputText()).toBe('new draft while sending');
  });

  it.each([false, true])(
    'preserves shared input after navigating during a failed send, newer input: %s',
    async (newerInput) => {
      setState(storePath('activeSessionId', 'session-1'));
      setInputTextAndFlush('original prompt');
      let resolveSend: ((sent: boolean) => void) | undefined;
      sendMessageMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSend = resolve;
          })
      );
      renderChatInput();
      container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
      await settle();
      expect(inputText()).toBe('');
      setState(storePath('activeSessionId', 'session-2'));
      if (newerInput) setInputText('next prompt');
      flushSolid();
      resolveSend?.(false);
      await flushAsyncWork();
      flushSolid();

      expect(inputText()).toBe(newerInput ? 'next prompt' : 'original prompt');
      expect(errorRetry()).toBeNull();
      setState(storePath('activeSessionId', 'session-1'));
      expect(inputText()).toBe(newerInput ? 'next prompt' : 'original prompt');
    }
  );

  it('does not restore a failed new-chat send into another workspace', async () => {
    setState(storePath('editorContext', 'workspacePath', '/repo-a'));
    setInputTextAndFlush('Only for workspace A');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    renderChatInput();
    container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
    await flushAsyncWork();
    flushSolid();
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(inputText()).toBe('');
    setState((draft) => {
      draft.editorContext.workspacePath = '/repo-b';
      draft.activeSessionId = 'session-b';
    });
    flushSolid();
    resolveSend?.(false);
    await flushAsyncWork();
    flushSolid();
    expect(inputText()).toBe('');
    expect(errorRetry()).toBeNull();
  });

  it('does not restore a failed snapshot after the user edits the pending draft back to empty', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('original prompt');
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );
    renderChatInput();
    const editor = container?.querySelector<HTMLElement>('.rich-composer');

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    editor!.textContent = 'temporary draft';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();
    editor!.textContent = '';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();
    expect(inputText()).toBe('');

    resolveSend?.(false);
    await settle();

    expect(inputText()).toBe('');
  });

  it('restores a failed draft even when consecutive errors have identical text', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('retry this prompt');
    sendMessageMock.mockResolvedValue(false);
    renderChatInput();

    const send = () =>
      container
        ?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send();
    await settle();
    expect(inputText()).toBe('retry this prompt');

    send();
    await settle();
    expect(inputText()).toBe('retry this prompt');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('right-aligns the provider limit popup when no context is shown', async () => {
    setupModelState();
    const model = state.providers[0]?.models['gpt-4o'];
    if (!model) throw new Error('Expected GPT-4o fixture');
    const modelWithoutLimit = { ...model };
    delete modelWithoutLimit.limit;
    setState(storePath('providers', 0, 'models', 'gpt-4o', modelWithoutLimit));
    flushSolid();
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    renderChatInput();

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('right-aligns the provider limit popup when context is shown', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 400, output: 100 })]);
    setStateAndFlush('providerLimits', {
      'openai:gpt-4o': availableProviderLimit(),
    });

    renderChatInput();

    const button = container?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector<HTMLElement>('.provider-limit-popup');

    expect(container?.querySelector('.context-anchor')).not.toBeNull();
    expect(popup).not.toBeNull();
    expect(popup?.style.right).toBe('0px');
  });

  it('aligns the permission popup to the input frame left edge', async () => {
    setupModelState();

    renderChatInput();

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

    clickAndFlush(button);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const popup = container?.querySelector<HTMLElement>('.toolbar-popover');
    expect(popup?.style.left).toBe('24px');
  });

  it('marks the input shell as hosting a floating popover while the model picker is open', async () => {
    setupModelState();
    setShowModelPicker(true);
    flushSolid();

    renderChatInput();

    expect(container?.querySelector('.chat-input-shell')?.className).toContain(
      'showing-floating-popover'
    );
    await waitForDropdown();
    flushSolid();
  });

  it('uses distinct panel visibility modifiers for model and MCP pickers', () => {
    setupModelState();
    setShowChangedFiles(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1_000, {
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: 'src/app.ts', before: '', after: 'updated', additions: 1, deletions: 0 }],
        },
      }),
    ]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
      { id: 'queue-1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);
    setStateAndFlush('todos', [
      { id: 'todo-1', content: 'Keep working', status: 'in_progress', priority: 'medium' },
    ]);

    renderChatInput();

    const inputPart = container?.querySelector('.interactive-input-part');
    const queue = container?.querySelector('.chat-queue-container');
    const todo = container?.querySelector('.todo-block:not(.changed-files-block)');
    const files = container?.querySelector('.changed-files-block');
    expect(queue).not.toBeNull();
    expect(todo).not.toBeNull();
    expect(files).not.toBeNull();

    setShowModelPicker(true);
    flushSolid();

    expect(inputPart?.classList.contains('model-picker-open')).toBe(true);
    expect(inputPart?.classList.contains('mcp-picker-open')).toBe(false);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);

    setShowModelPicker(false);
    flushSolid();
    setStateAndFlush('mcpStatus', { docs: { status: 'connected' } });
    container?.querySelector<HTMLButtonElement>('.toolbar-mcp-count')?.click();
    flushSolid();

    expect(inputPart?.classList.contains('model-picker-open')).toBe(false);
    expect(inputPart?.classList.contains('mcp-picker-open')).toBe(true);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);
  });

  it('closes toolbar popups when the composer changes', async () => {
    setupModelState();
    setShowModelPicker(true);
    flushSolid();
    renderChatInput();

    expect(container?.querySelector('.model-picker-menu')).not.toBeNull();

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    editor!.textContent = 'Test';
    editor?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await settle();

    expect(showModelPicker()).toBe(false);
    expect(container?.querySelector('.model-picker-menu')).toBeNull();
  });

  it('keeps queue, todo, and file panels mounted while the @ menu is open', async () => {
    setShowChangedFiles(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1_000, {
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: 'src/app.ts', before: '', after: 'updated', additions: 1, deletions: 0 }],
        },
      }),
    ]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
      { id: 'queue-1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);
    setStateAndFlush('todos', [
      { id: 'todo-1', content: 'Keep working', status: 'in_progress', priority: 'medium' },
    ]);
    setStateAndFlush('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputTextAndFlush('@hel');

    renderChatInput();

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
    flushSolid();
    setCollapsedSelection(editor.firstChild, '@hel'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    await settle();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();
    expect(inputPart?.classList.contains('mention-completion-open')).toBe(true);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);

    setInputText('');
    await settle();

    expect(inputPart?.classList.contains('mention-completion-open')).toBe(false);
    expect(container?.querySelector('.chat-queue-container')).toBe(queue);
    expect(container?.querySelector('.todo-block:not(.changed-files-block)')).toBe(todo);
    expect(container?.querySelector('.changed-files-block')).toBe(files);
  });

  it.each([false, true])(
    'hides only Varro vision from mentions (native vision model: %s)',
    async (nativeVision) => {
      setupVisionDelegationModelState();
      if (nativeVision) setSelectedModel({ providerID: 'vision-provider', modelID: 'viewer' });
      flushSolid();
      setStateAndFlush('allAgents', [
        {
          name: 'vision',
          description: VARRO_VISION_AGENT_DESCRIPTION,
          prompt: VARRO_VISION_AGENT_PROMPT,
          mode: 'subagent',
          permission: [],
          model: { providerID: 'vision-provider', modelID: 'viewer' },
        },
        { name: 'general', description: 'General tasks', mode: 'subagent', permission: [] },
      ]);
      renderChatInput();
      await settle();
      const editor = focusComposer();
      enterComposerText(editor, '@');
      await flushAsyncWork();
      flushSolid();

      const menu = container?.querySelector('.composer-completion-menu');
      expect(menu?.textContent).toContain('general');
      expect(menu?.textContent).not.toContain('vision');
      expect(state.allAgents.some((agent) => agent.name === 'vision')).toBe(true);

      setState(storePath('allAgents', 0, 'prompt', 'Custom instructions for my image reviewer'));
      await settle();
      expect(container?.querySelector('.composer-completion-menu')?.textContent).toContain(
        'vision'
      );
    }
  );

  it('reissues an active file search when the workspace changes', async () => {
    const messages = captureBridgeMessages();
    setStateAndFlush('editorContext', {
      workspacePath: '/repo-a',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setInputTextAndFlush('@app');
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '@app'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'p', bubbles: true }));
    flushSolid();

    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === 'files/search')).toHaveLength(1)
    );
    flushSolid();

    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    expect(inputText()).toBe('');
    enterComposerText(editor, '@app');
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'p', bubbles: true }));
    flushSolid();

    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === 'files/search')).toHaveLength(2)
    );
    flushSolid();
    const searches = messages.filter((message) => message.type === 'files/search');
    expect(searches[1]).toEqual({
      type: 'files/search',
      payload: {
        requestId: expect.any(Number),
        query: 'app',
        limit: 12,
      },
    });
    expect(searches[1]?.payload.requestId).not.toBe(searches[0]?.payload.requestId);
  });

  it.each(['success', 'error', 'switched'] as const)(
    'attaches @ table selections with guarded %s replies',
    async (outcome) => {
      const messages = captureBridgeMessages();
      setStateAndFlush('editorContext', idleEditorContext('/repo'));
      setInputTextAndFlush('@users');
      renderChatInput();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.firstChild) throw new Error('Expected populated composer');
      editor.focus();
      flushSolid();
      setCollapsedSelection(editor.firstChild, 6);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 's', bubbles: true }));
      flushSolid();
      await vi.waitFor(() =>
        expect(messages.some((message) => message.type === 'files/search')).toBe(true)
      );
      flushSolid();
      const search = messages.find((message) => message.type === 'files/search');
      if (search?.type !== 'files/search') throw new Error('Expected file search');
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'files/search-results',
            payload: {
              requestId: search.payload.requestId,
              query: 'users',
              files: [],
              tables: [{ id: 'users-table', name: 'main.users', dataSource: 'Demo SQLite' }],
            },
          },
        })
      );
      await settle();
      const item = container?.querySelector<HTMLButtonElement>('.completion-table');
      expect(item?.textContent).toContain('main.users');
      expect(item?.querySelector('[data-chip-icon="table"]')).not.toBeNull();
      item?.click();
      await settle();
      const request = messages.find((message) => message.type === 'database/attach');
      if (request?.type !== 'database/attach') throw new Error('Expected table attachment request');
      expect(request.payload.id).toBe('users-table');
      expect(inputText()).not.toContain('@users');
      expect(state.droppedFiles).toHaveLength(0);
      setInputText('Explain');
      await settle();
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      if (outcome === 'switched')
        setState(storePath('editorContext', 'workspacePath', '/another-repo'));
      flushSolid();
      const file = {
        path: '/snapshots/main.users-context.json',
        relativePath: 'main.users-context.json',
        type: 'file',
      };
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'database/attached',
            payload:
              outcome === 'error'
                ? { requestId: request.payload.requestId, error: 'Table removed' }
                : { requestId: request.payload.requestId, file },
          },
        })
      );
      await settle();
      expect(state.droppedFiles.map((attachment) => attachment.path)).toEqual(
        outcome === 'success' ? [file.path] : []
      );
      if (outcome === 'error')
        expect(showSessionActionFeedbackMock).toHaveBeenCalledWith('Table removed', 'warning');
    }
  );

  it.each([
    { trigger: '@', initial: '@hel', shortened: '@he' },
    { trigger: '&', initial: '&aut', shortened: '&au' },
    { trigger: '/', initial: '/zzv', shortened: '/zz' },
  ])(
    'keeps the $trigger completion menu mounted on backspace',
    async ({ trigger, initial, shortened }) => {
      setStateAndFlush('allAgents', [
        {
          name: 'helper',
          description: 'Help with the task',
          mode: 'subagent',
          builtIn: false,
          permission: [],
        },
      ]);
      setStateAndFlush('sessions', [session('session-auth', 2_000, { title: 'Authentication' })]);
      setStateAndFlush('commands', [
        {
          name: 'zzvarrotest',
          description: 'Run tests',
          template: 'Run tests',
        },
      ]);
      setInputTextAndFlush(initial);

      renderChatInput();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, initial.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: initial.at(-1), bubbles: true }));
      await settle();

      const menu = container?.querySelector('.composer-completion-menu');
      const slashItem = trigger === '/' ? menu?.querySelector('.completion-slash') : null;
      expect(menu).not.toBeNull();

      editor.textContent = shortened;
      if (!editor.firstChild) throw new Error('Expected updated composer editor');
      setCollapsedSelection(editor.firstChild, shortened.length);
      flushSolid();
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })
      );
      await settle();

      expect(inputText()).toBe(shortened);
      expect(container?.querySelector('.composer-completion-menu')).toBe(menu);
      if (slashItem) expect(container?.querySelector('.completion-slash')).toBe(slashItem);
    }
  );

  it.each(['&session-auth', '&sessions:session-auth'])(
    'looks up session titles from %s and inserts a session reference',
    async (lookup) => {
      vi.useFakeTimers();
      const result = session('session-auth', 2_000, { title: 'Investigate authentication' });
      vi.mocked(client.session.list).mockResolvedValue({ items: [result], hasMore: false });
      setInputTextAndFlush(lookup);

      renderChatInput();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, lookup.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'h', bubbles: true }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(120);
      await settle();

      expect(client.session.list).toHaveBeenCalledWith({
        limit: 30,
        search: 'session-auth',
        roots: true,
        signal: expect.any(AbortSignal),
      });
      const item = container?.querySelector<HTMLButtonElement>('.completion-session');
      expect(item?.querySelector('.composer-completion-title')?.textContent).toBe(
        'Investigate authentication'
      );
      expect(item?.querySelector('.composer-completion-age')).not.toBeNull();

      item?.click();
      flushSolid();
      expect(inputText()).toBe('session:session-auth ');
      const reference = container?.querySelector<HTMLElement>(
        '.composer-session-reference[data-chip-type="mention-session"]'
      );
      expect(reference?.textContent).toBe('Investigate authentication');
      expect(reference?.dataset.chipId).toBeUndefined();
    }
  );

  it('selects a session completion on Enter for a bare ampersand', async () => {
    setStateAndFlush('sessions', [
      session('session-auth', 2_000, { title: 'Investigate authentication' }),
    ]);
    setInputTextAndFlush('Run both commands &');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 'Run both commands &'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '&', bubbles: true }));
    await settle();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('Run both commands session:session-auth ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('selects an agent completion on Enter without sending the message', async () => {
    setStateAndFlush('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputTextAndFlush('Ask @hel');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 'Ask @hel'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    await settle();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('Ask @helper ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('inserts a parameterless slash completion before running it', async () => {
    setStateAndFlush('commands', [
      {
        name: 'zzvarrotest',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputTextAndFlush('/zzv');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/zzv'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    await settle();

    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('/zzvarrotest');
    expect(container?.querySelector('.composer-completion-menu')).toBeNull();
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('');
    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('zzvarrotest', '');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each(['click', 'Tab', 'Enter'])(
    'dismisses overlapping slash completions after %s so Enter runs the selected command',
    async (selection) => {
      setStateAndFlush('commands', [
        { name: 'a-helper', description: 'Run zzvarrotest checks', template: 'Run checks' },
        { name: 'zzvarrotest', description: 'Run tests', template: 'Run tests' },
      ]);
      setInputTextAndFlush('/zzv');

      renderChatInput();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, '/zzv'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
      await settle();

      const items = [...container!.querySelectorAll<HTMLButtonElement>('.completion-slash')];
      expect(
        items.map((item) => item.querySelector('.composer-completion-title')?.textContent)
      ).toEqual(['/a-helper', '/zzvarrotest']);
      if (selection === 'click') items[1]!.click();
      else {
        pressKey(editor, { key: 'ArrowDown' });
        flushSolid();
        pressKey(editor, { key: selection });
        flushSolid();
      }
      await settle();

      expect(inputText()).toBe('/zzvarrotest');
      expect(container?.querySelector('.composer-completion-menu')).toBeNull();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();

      pressKey(editor, { key: 'Enter' });
      await settle();

      expect(inputText()).toBe('');
      expect(runSlashCommandByNameMock).toHaveBeenCalledExactlyOnceWith('zzvarrotest', '');
      expect(sendMessageMock).not.toHaveBeenCalled();
    }
  );

  it.each(
    ['skills', 'problems'].flatMap((name) =>
      ['click', 'Tab', 'Enter'].map((selection) => ({ name, selection }))
    )
  )('keeps the /$name picker open after $selection completion', async ({ name, selection }) => {
    setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
    vi.mocked(client.varro.workspaceProblems).mockResolvedValue({
      total: 1,
      diagnostics: [{ path: '/repo/a.ts', line: 1, severity: 'error', message: 'A error' }],
    });
    const draft = `/${name.slice(0, 3)}`;
    setInputTextAndFlush(draft);

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, draft.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: draft.at(-1), bubbles: true }));
    await settle();

    const items = [...container!.querySelectorAll<HTMLButtonElement>('.completion-slash')];
    const item = items.find(
      (button) => button.querySelector('.composer-completion-title')?.textContent === `/${name}`
    );
    if (!item) throw new Error(`Expected /${name} completion`);
    if (selection === 'click') item.click();
    else {
      for (let index = 0; index < items.indexOf(item); index++) {
        pressKey(editor, { key: 'ArrowDown' });
        flushSolid();
      }
      pressKey(editor, { key: selection });
      flushSolid();
    }
    await settle();

    expect(inputText()).toBe(`/${name} `);
    expect(container?.querySelector('.composer-completion-header')?.textContent).toBe(
      name === 'skills' ? 'Skills' : 'Problems'
    );
    expect(container?.querySelector('.composer-completion-title')?.textContent).toBe(
      name === 'skills' ? 'browser-bridge' : 'All'
    );
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('selects /stats from the completion menu before sending it', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    const bridgeWindow = window as {
      __sendToExtension?: (message: WebviewMessage) => void;
    };
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    setInputTextAndFlush('/stat');

    try {
      renderChatInput();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, '/stat'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 't', bubbles: true }));
      await settle();

      expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();

      pressKey(editor, { key: 'Enter' });
      await settle();

      expect(inputText()).toBe('/stats');
      expect(sent).not.toContainEqual({
        type: 'usage/report',
        payload: { includeAllTime: false },
      });
      expect(sendMessageMock).not.toHaveBeenCalled();

      pressKey(editor, { key: 'Enter' });
      await settle();

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
    setStateAndFlush('commands', [
      {
        name: 'zzvarrotest',
        description: 'Run matching tests',
        template: 'Run matching tests',
        hints: ['pattern'],
      },
    ]);
    setInputTextAndFlush('/zzv');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/zzv'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
    await settle();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('/zzvarrotest');
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('opens the skills completion list on Enter', async () => {
    setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
    setInputTextAndFlush('/skills');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/skills'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 's', bubbles: true }));
    await settle();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('/skills ');
    expect(container?.querySelector('.composer-completion-header')?.textContent).toBe('Skills');
    expect(container?.querySelector('.completion-skill-icon')).toBeInstanceOf(HTMLImageElement);
    expect(container?.querySelector('.composer-completion-title')?.textContent).toBe(
      'browser-bridge'
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each(['/docs test', '/docs', '  /DOCS test', '/docs\ntest\ntest', '/docs\n\ntest'])(
    'renders the leading skill command %s as a chip without changing its send path',
    async (draft) => {
      setStateAndFlush('commands', [skillCommand('docs', 'Write a document')]);
      setInputTextAndFlush(draft);
      renderChatInput();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      const chip = editor?.querySelector<HTMLElement>('[data-chip-type="mention-skill"]');
      expect(chip?.textContent).toBe('docs');
      expect(chip?.dataset.chipMarker).toBe(draft.trimStart().split(/\s/, 1)[0]);
      expect(inputText()).toBe(draft);
      if (draft.includes('test')) expect(editor?.textContent).toContain('test');
      const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
      if (!sendButton) throw new Error('Expected send button');
      sendButton.click();
      await settle();
      expect(runSlashCommandByNameMock).toHaveBeenCalledWith(
        'docs',
        draft.trim().replace(/^\/docs\s*/i, '')
      );
      flushSolid();
      expect(sendMessageMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Enter', 'control', 'skill', 'check machines'],
    ['button', 'control', 'skill', 'check machines'],
    ['Enter', 'goal', 'command', 'Wait for 1 minute'],
    ['button', 'goal', 'command', 'Wait for 1 minute'],
  ] as const)(
    'starts a new session from the sessions list with %s for /%s',
    async (sendMethod, commandName, source, args) => {
      setStateAndFlush('activeSessionId', 'existing-session');
      setStateAndFlush('commands', [{ name: commandName, template: '', source }]);
      setInputTextAndFlush(`/${commandName} ${args}`);
      const onBeforeSend = vi.fn();
      cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);
      flushSolid();
      if (source === 'skill')
        expect(container?.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
          commandName
        );

      if (sendMethod === 'Enter') {
        pressComposerEnter();
        flushSolid();
      } else {
        container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.click();
        flushSolid();
      }
      await settle();

      expect(runSlashCommandByNameMock).toHaveBeenCalledWith(commandName, args, {
        targetSessionId: null,
        newSessionWorkspace: { scope: 'folder', directory: null },
        onAccepted: onBeforeSend,
      });
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(inputText()).toBe('');
    }
  );

  it.each([
    [false, 'control', 'skill'],
    [true, 'control', 'skill'],
    [false, 'goal', 'command'],
    [true, 'goal', 'command'],
  ] as const)(
    'restores a failed sessions-list command without sending it as a prompt (throws: %s, /%s)',
    async (throws, commandName, source) => {
      setStateAndFlush('activeSessionId', 'existing-session');
      setStateAndFlush('commands', [{ name: commandName, template: '', source }]);
      const draft = `/${commandName} check machines`;
      setInputTextAndFlush(draft);
      if (throws) runSlashCommandByNameMock.mockRejectedValueOnce(new Error('Command failed'));
      else runSlashCommandByNameMock.mockResolvedValueOnce(false);
      const onBeforeSend = vi.fn();
      cleanup = render(() => ChatInput({ newSession: true, onBeforeSend }), container!);
      flushSolid();
      container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.click();
      await settle();

      expect(inputText()).toBe(draft);
      if (source === 'skill')
        expect(container?.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
          commandName
        );
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(onBeforeSend).not.toHaveBeenCalled();
    }
  );

  it('preserves a newer draft when a sessions-list skill command fails', async () => {
    setStateAndFlush('commands', [
      { name: 'control', template: 'Check machines', source: 'skill' },
    ]);
    setInputTextAndFlush('/control check machines');
    let resolveCommand: ((sent: boolean) => void) | undefined;
    runSlashCommandByNameMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCommand = resolve;
        })
    );
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();
    container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.click();
    await settle();
    setInputTextAndFlush('New draft');
    resolveCommand?.(false);
    await settle();

    expect(inputText()).toBe('New draft');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each(['session', 'workspace'] as const)(
    'restores a failed slash command only in its shared draft after %s navigation',
    async (navigation) => {
      setState((draft) => {
        draft.activeSessionId = 'session-1';
        draft.editorContext.workspacePath = '/repo-a';
        draft.commands = [{ name: 'goal', template: '', source: 'command' }];
      });
      setInputTextAndFlush('/goal check machines');
      let resolveCommand: ((sent: boolean) => void) | undefined;
      runSlashCommandByNameMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCommand = resolve;
          })
      );
      renderChatInput();
      container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
      await flushAsyncWork();
      flushSolid();
      expect(runSlashCommandByNameMock).toHaveBeenCalledOnce();
      expect(inputText()).toBe('');
      setState((draft) => {
        draft.activeSessionId = 'session-2';
        if (navigation === 'workspace') draft.editorContext.workspacePath = '/repo-b';
      });
      flushSolid();
      resolveCommand?.(false);
      await flushAsyncWork();
      flushSolid();
      expect(inputText()).toBe(navigation === 'session' ? '/goal check machines' : '');
      expect(sendMessageMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Please use /docs test', 'skill'],
    ['/docs-other test', 'skill'],
    ['/docs test', 'command'],
  ] as const)(
    'keeps non-leading, partial, and ordinary slash commands as text: %s %s',
    (draft, source) => {
      setStateAndFlush('commands', [
        { name: 'docs', description: 'Write a document', template: 'Write a document', source },
      ]);
      setInputTextAndFlush(draft);
      renderChatInput();
      expect(container?.querySelector('[data-chip-type="mention-skill"]')).toBeNull();
      expect(inputText()).toBe(draft);
    }
  );

  it('renders a skill selected from the leading skills picker as a chip', async () => {
    setStateAndFlush('commands', [skillCommand('docs', 'Write a document')]);
    setInputTextAndFlush('/skills do');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/skills do'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'o', bubbles: true }));
    await settle();
    pressKey(editor, { key: 'Enter' });
    await settle();
    expect(inputText()).toBe('/docs');
    expect(editor.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe('docs');
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('removes the mixed-view prefix from an existing skill row when jumping to skills', async () => {
    setStateAndFlush('commands', [skillCommand('skill-helper', 'Helpful skill')]);
    setInputTextAndFlush('/ski');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 4);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'i', bubbles: true }));
    await settle();
    const row = Array.from(container?.querySelectorAll('.composer-completion-item') ?? []).find(
      (item) => item.textContent?.includes('/skill:skill-helper')
    );
    expect(row).toBeDefined();
    pressKey(editor, { key: 'Enter' });
    await settle();
    expect(inputText()).toBe('/skills ');
    expect(container?.querySelector('.composer-completion-header')?.textContent).toBe('Skills');
    expect(container?.querySelector('.composer-completion-item')).toBe(row);
    expect(row?.querySelector('.composer-completion-title')?.textContent).toBe('skill-helper');
    expect(row?.querySelector('.completion-skill-icon')).toBeInstanceOf(HTMLImageElement);
  });

  it('shows matching skills after one slash query character', async () => {
    setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
    setInputTextAndFlush('/b');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/b'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'b', bubbles: true }));
    await settle();

    const titles = Array.from(
      container?.querySelectorAll<HTMLElement>('.composer-completion-title') ?? []
    ).map((element) => element.textContent);
    expect(titles).toContain('/skill:browser-bridge');
    expect(container?.querySelector('.composer-completion-header')).toBeNull();
    expect(container?.querySelector('.completion-skill-icon')).toBeNull();
  });

  it('does not show skills for a bare slash', async () => {
    setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
    setInputTextAndFlush('/');

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '/'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '/', bubbles: true }));
    await settle();

    const titles = Array.from(
      container?.querySelectorAll<HTMLElement>('.composer-completion-title') ?? []
    ).map((element) => element.textContent);
    expect(titles).not.toContain('/skill:browser-bridge');
  });

  it.each(
    ['bro', 'browser-bridge', 'BROWSER-BRIDGE', 'web'].flatMap((query) =>
      ['Enter', 'Tab', 'click'].flatMap((selection) =>
        [' for this', '', '\nKeep this line'].map((suffix) => ({ query, selection, suffix }))
      )
    )
  )(
    'preserves surrounding draft text when selecting /$query with $selection before "$suffix"',
    async ({ query, selection, suffix }) => {
      setStateAndFlush('commands', [
        {
          name: 'browser-bridge',
          description: 'Control a browser',
          template: 'Control a browser',
          source: 'skill',
          hints: ['web'],
        },
      ]);
      const prefix = 'Please use ';
      setInputTextAndFlush(`${prefix}/${query}${suffix}`);
      renderChatInput();
      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, prefix.length + query.length + 1);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'o', bubbles: true }));
      await settle();

      const items = [...container!.querySelectorAll<HTMLButtonElement>('.completion-slash')];
      const index = items.findIndex(
        (item) =>
          item.querySelector('.composer-completion-title')?.textContent === '/skill:browser-bridge'
      );
      expect(index).toBeGreaterThanOrEqual(0);
      if (selection === 'click') {
        items[index]!.click();
        flushSolid();
      } else {
        for (let i = 0; i < index; i++) {
          pressKey(editor, { key: 'ArrowDown' });
          flushSolid();
        }
        pressKey(editor, { key: selection });
        flushSolid();
      }
      await settle();

      const expected = `Please use $[browser-bridge]${suffix || ' '}`;
      expect(inputText()).toBe(expected);
      expect(editor.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
        'browser-bridge'
      );
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();

      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe(expected);
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    '/docs/README.md',
    'Inspect /docs/README.md',
    'Inspect /docs\\README.md',
    '//docs/share',
    'C:\\docs\\README.md',
    'https://example.com/docs',
    'prefix/docs',
    'cost$5',
    '$5',
    '$HOME',
    '$docs-other',
    'Use /docs-other',
    'Use $[%ZZ]',
    'Use $[]',
  ])('keeps skill-like input %s as ordinary draft text', async (draft) => {
    setStateAndFlush('commands', [skillCommand('docs', 'Write a document')]);
    setInputTextAndFlush(draft);
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, editor.childNodes.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', bubbles: true }));
    await settle();

    expect(inputText()).toBe(draft);
    expect(editor.querySelector('[data-chip-type="mention-skill"]')).toBeNull();
    expect(container?.querySelector('.composer-completion-menu')).toBeNull();
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Tab', 'click'])(
    'selects a dollar skill inline with %s and sends it with the prompt',
    async (selection) => {
      setStateAndFlush('commands', [
        {
          name: 'browser-bridge',
          description: 'Control a browser',
          template: 'Control a browser',
          source: 'skill',
          hints: ['web'],
        },
        {
          name: 'browser-command',
          description: 'A command',
          template: 'A command',
          source: 'command',
        },
        skillCommand('another-skill', 'Another skill'),
      ]);
      const draft = 'Please use $WEB for this';
      setInputTextAndFlush(draft);
      renderChatInput();
      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, 'Please use $WEB'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'B', bubbles: true }));
      await settle();

      expect(container?.querySelector('.composer-completion-header')?.textContent).toBe('Skills');
      const titles = Array.from(
        container?.querySelectorAll('.composer-completion-title') ?? []
      ).map((element) => element.textContent);
      expect(titles).toEqual(['browser-bridge']);
      expect(container?.querySelector('.completion-skill-icon')).toBeInstanceOf(HTMLImageElement);
      if (selection === 'click') {
        container?.querySelector<HTMLButtonElement>('.completion-slash')?.click();
        flushSolid();
      } else {
        pressKey(editor, { key: selection });
        flushSolid();
      }
      await settle();
      expect(inputText()).toBe('Please use $[browser-bridge] for this');
      expect(editor.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
        'browser-bridge'
      );
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe('Please use $[browser-bridge] for this');
    }
  );

  it.each(['$', '/'])(
    'adds another %s skill without replacing an existing skill chip',
    async (trigger) => {
      setStateAndFlush('commands', [skillCommand('unslop', 'Edit writing')]);
      setInputTextAndFlush(`Use $[browser-bridge] then ${trigger}un`);
      renderChatInput();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor?.lastChild) throw new Error('Expected populated composer editor');
      editor.focus();
      flushSolid();
      setCollapsedSelection(editor.lastChild, editor.lastChild.textContent?.length ?? 0);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'n', bubbles: true }));
      await settle();
      pressKey(editor, { key: 'Tab' });
      await settle();
      expect(inputText()).toBe('Use $[browser-bridge] then $[unslop] ');
      expect(
        Array.from(editor.querySelectorAll('[data-chip-type="mention-skill"]')).map(
          (chip) => chip.textContent
        )
      ).toEqual(['browser-bridge', 'unslop']);
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe('Use $[browser-bridge] then $[unslop] ');
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    }
  );

  it('shows only skills for a bare dollar and dismisses without clearing the draft', async () => {
    setStateAndFlush('commands', [
      skillCommand('browser-bridge', 'Control a browser'),
      { name: 'custom-command', description: 'Command', template: 'Command', source: 'command' },
    ]);
    setInputTextAndFlush('$');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 1);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '$', bubbles: true }));
    await settle();
    expect(
      Array.from(container?.querySelectorAll('.composer-completion-title') ?? []).map(
        (element) => element.textContent
      )
    ).toEqual(['browser-bridge']);
    pressKey(editor, { key: 'Escape' });
    await settle();
    expect(inputText()).toBe('$');
    expect(container?.querySelector('.composer-completion-menu')).toBeNull();
  });

  it.each(['Enter', 'Tab', 'click'])(
    'opens Skills inline as a dollar picker with %s and inserts a chip',
    async (selection) => {
      setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
      const draft = 'Please use /ski for this';
      setInputTextAndFlush(draft);
      renderChatInput();
      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, 'Please use /ski'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'i', bubbles: true }));
      await settle();
      const skillsRow = Array.from(
        container?.querySelectorAll<HTMLButtonElement>('.completion-slash') ?? []
      ).find((row) => row.querySelector('.composer-completion-title')?.textContent === '/skills');
      if (!skillsRow) throw new Error('Expected Skills lookup option');
      if (selection === 'click') skillsRow.click();
      else pressKey(editor, { key: selection });
      await settle();
      expect(inputText()).toBe('Please use $ for this');
      expect(container?.querySelector('.composer-completion-header')?.textContent).toBe('Skills');
      expect(container?.querySelector('.composer-completion-title')?.textContent).toBe(
        'browser-bridge'
      );
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(inputText()).toBe('Please use $[browser-bridge] for this');
      expect(editor.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
        'browser-bridge'
      );
    }
  );

  it('selects an inline /skills alias as a dollar skill and sends it with the prompt', async () => {
    setStateAndFlush('commands', [skillCommand('browser-bridge', 'Control a browser')]);
    const draft = 'Please use /skills bro for this';
    const completionEnd = 'Please use /skills bro'.length;
    setInputTextAndFlush(draft);

    renderChatInput();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, completionEnd);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'o', bubbles: true }));
    await settle();

    expect(container?.querySelector('.composer-completion-title')?.textContent).toBe(
      'browser-bridge'
    );
    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('Please use $[browser-bridge] for this');
    expect(editor.querySelector('[data-chip-type="mention-skill"]')?.textContent).toBe(
      'browser-bridge'
    );
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe('Please use $[browser-bridge] for this');
    expect(inputText()).toBe('');
  });

  it.each(['session:ses_otherProject', 'ses_otherProject'])(
    'resolves pasted cross-project marker %s to a titled link without rewriting the prompt',
    async (marker) => {
      const result = {
        id: 'ses_otherProject',
        title: 'Investigate authentication',
        directory: '/other-project',
        external: true,
      };
      setStateAndFlush('serverStatus', { state: 'running', url: `http://localhost/${marker}` });
      vi.mocked(client.varro.session.reference).mockResolvedValue(result);
      setInputTextAndFlush(`Review ${marker}`);

      renderChatInput();
      await settle();

      expect(client.varro.session.reference).toHaveBeenCalledWith('ses_otherProject');
      await vi.waitFor(() =>
        expect(
          container?.querySelector<HTMLElement>(
            '.composer-session-reference[data-chip-type="mention-session"]'
          )
        ).not.toBeNull()
      );
      flushSolid();
      const reference = container?.querySelector<HTMLElement>(
        '.composer-session-reference[data-chip-type="mention-session"]'
      );
      expect(reference?.textContent).toBe('Investigate authentication');
      expect(reference?.dataset.chipMarker).toBe(marker);
      expect(inputText()).toBe(`Review ${marker}`);
      expect(state.sessions.some((candidate) => candidate.id === result.id)).toBe(false);
    }
  );

  it('renders HTTPS URLs as editable links without replacing their DOM while typing', () => {
    setInputTextAndFlush("What's this https://iconoir.com?");

    renderChatInput();

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
    flushSolid();
    trailingText.textContent = '/1?';
    setCollapsedSelection(trailingText, 2);
    flushSolid();
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();

    expect(inputText()).toBe("What's this https://iconoir.com/1?");
    expect(container?.querySelector('.composer-external-link')).toBe(reference);
    expect(reference.textContent).toBe('https://iconoir.com/1');
    expect(reference.querySelector('.composer-external-link-icon')).not.toBeNull();
    expect(document.activeElement).toBe(editor);

    trailingText.textContent = '2?';
    setCollapsedSelection(trailingText, 1);
    flushSolid();
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();

    expect(inputText()).toBe("What's this https://iconoir.com/12?");
    expect(container?.querySelector('.composer-external-link')).toBe(reference);
    expect(reference.textContent).toBe('https://iconoir.com/12');
    expect(document.activeElement).toBe(editor);
  });

  it('escapes a URL into plain text when typing a trailing space', () => {
    setInputTextAndFlush('https://iconoir.com');

    renderChatInput();

    const editor = container?.querySelector<HTMLElement>('.rich-composer');
    const reference = container?.querySelector<HTMLElement>('.composer-external-link');
    const linkText = reference?.lastChild;
    if (!editor || !linkText || linkText.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected editable external link');
    }
    editor.focus();
    flushSolid();
    setCollapsedSelection(linkText, 'ttps://iconoir.com'.length);
    flushSolid();
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: ' ',
      })
    );
    flushSolid();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
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
    renderChatInput();

    expect(
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent)
    ).toEqual(['Owned follow-up']);

    await sendQueuedAsSteer(state.queuedMessages[1]!);
    flushSolid();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['owned', 'other-view']);

    syncQueuedMessages();
    flushSolid();
    expect(sendToExtension).toHaveBeenLastCalledWith({
      type: 'queued-messages/update',
      payload: {
        messages: [expect.objectContaining({ id: 'owned', ownerViewId: 'editor-a' })],
        mutationId: expect.any(String),
      },
    });
  });

  describe('save draft shortcut', () => {
    function pressSave(options: KeyboardEventInit = {}) {
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      editor.focus();
      const event = new KeyboardEvent('keydown', {
        key: 's',
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...options,
      });
      editor.dispatchEvent(event);
      return event;
    }

    it.each([
      ['Cmd+S', false, true],
      ['Cmd+S', true, true],
      ['Ctrl+S', false, false],
      ['Ctrl+S', true, false],
    ] as const)('saves with %s when busy is %s', async (_shortcut, busy, metaKey) => {
      vi.useFakeTimers();
      setupModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setIsLoading(busy);
      flushSolid();
      setState(storePath('sessionStatus', 'session-1', { type: busy ? 'busy' : 'idle' }));
      flushSolid();
      setInputTextAndFlush('Keep this draft');
      setStateAndFlush('droppedFiles', [
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
      ]);
      setStateAndFlush('terminalSelection', { text: 'npm test', terminalName: 'zsh' });
      const sendToExtension = vi.fn(defaultBridgeSend);
      fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
        sendToExtension;
      renderChatInput();

      expect(pressSave({ metaKey, ctrlKey: !metaKey }).defaultPrevented).toBe(true);
      flushSolid();

      expect(inputText()).toBe('');
      expect(state.droppedFiles).toEqual([]);
      expect(state.terminalSelection).toBeNull();
      expect(state.queuedMessages).toHaveLength(1);
      expect(state.queuedMessages[0]).toMatchObject({
        sessionId: 'session-1',
        text: 'Keep this draft',
        paused: true,
        droppedFiles: [{ path: '/repo/src/a.ts' }],
        terminalSelection: { text: 'npm test', terminalName: 'zsh' },
        queuedContext: {
          editorContext: {
            queuedModel: { selection: { providerID: 'openai', modelID: 'gpt-4o' } },
          },
        },
      });
      expect(sendToExtension).toHaveBeenCalledWith({
        type: 'queued-messages/update',
        payload: {
          messages: [expect.objectContaining({ sessionId: 'session-1', paused: true })],
          mutationId: expect.any(String),
        },
      });
      expect(container?.querySelector('.chat-queue-item.is-paused')).not.toBeNull();
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')?.disabled
      ).toBe(false);

      setIsLoadingAndFlush(false);
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(state.queuedMessages[0]?.paused).toBe(true);
    });

    it('keeps a saved draft paused through edits and session switches until explicitly played', async () => {
      vi.useFakeTimers();
      setStateAndFlush('activeSessionId', 'session-1');
      setInputTextAndFlush('Draft for later');
      sendMessageMock.mockResolvedValue(true);
      renderChatInput();
      pressSave();
      flushSolid();

      container!.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click();
      flushSolid();
      expect(inputText()).toBe('Draft for later');
      setInputTextAndFlush('Revised draft');
      container!
        .querySelector<HTMLDivElement>('.rich-composer')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(inputText()).toBe('');
      expect(state.queuedMessages).toHaveLength(1);
      expect(state.queuedMessages[0]).toMatchObject({ text: 'Revised draft', paused: true });

      setStateAndFlush('activeSessionId', 'session-2');
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      setStateAndFlush('activeSessionId', 'session-1');
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(sendMessageMock).not.toHaveBeenCalled();

      container!.querySelector<HTMLButtonElement>('[aria-label="Play queued message"]')!.click();
      flushSolid();
      await vi.advanceTimersByTimeAsync(300);
      await settle();
      expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith(
        'Revised draft',
        expect.objectContaining({ targetSessionId: 'session-1' })
      );
      expect(state.queuedMessages).toEqual([]);
    });

    it('pauses an existing queue row when saving its edit without duplicating it', async () => {
      vi.useFakeTimers();
      setStateAndFlush('activeSessionId', 'session-1');
      setIsLoadingAndFlush(true);
      setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Original' }]);
      renderChatInput();
      container!.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click();
      flushSolid();
      setInputTextAndFlush('Saved revision');
      pressSave();
      flushSolid();
      setIsLoadingAndFlush(false);
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();

      expect(inputText()).toBe('');
      expect(state.queuedMessages).toHaveLength(1);
      expect(state.queuedMessages[0]).toMatchObject({ text: 'Saved revision', paused: true });
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it.each(['/pause', '/stop', '/mcp', '/btw later', '/compact', '/problems'])(
      'saves %s as draft text without executing it',
      async (text) => {
        vi.useFakeTimers();
        setStateAndFlush('serverStatus', runningV2Server());
        setStateAndFlush('activeSessionId', 'session-1');
        setInputTextAndFlush(text);
        renderChatInput();
        pressSave();
        flushSolid();
        await vi.advanceTimersByTimeAsync(1_000);
        flushSolid();

        expect(inputText()).toBe('');
        expect(state.queuedMessages).toHaveLength(1);
        expect(state.queuedMessages[0]).toMatchObject({ text, paused: true });
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
        expect(abortSessionMock).not.toHaveBeenCalled();
        expect(sideQuestionView()).toBeNull();
      }
    );

    it.each<KeyboardEventInit>([
      { metaKey: false },
      { shiftKey: true },
      { altKey: true },
      { isComposing: true },
      { repeat: true },
    ])('does not save with unsupported key state %j', (options) => {
      setStateAndFlush('activeSessionId', 'session-1');
      setInputTextAndFlush('Unfinished draft');
      renderChatInput();
      pressSave(options);
      flushSolid();

      expect(inputText()).toBe('Unfinished draft');
      expect(state.queuedMessages).toEqual([]);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('does not save an empty draft or handle the shortcut outside the input', () => {
      setStateAndFlush('activeSessionId', 'session-1');
      setInputTextAndFlush('   ');
      renderChatInput();
      pressSave();
      flushSolid();
      expect(state.queuedMessages).toEqual([]);

      setInputTextAndFlush('Keep typing');
      const event = new KeyboardEvent('keydown', {
        key: 's',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      container!.dispatchEvent(event);
      flushSolid();
      expect(event.defaultPrevented).toBe(false);
      expect(inputText()).toBe('Keep typing');
      expect(state.queuedMessages).toEqual([]);
    });

    it.each([false, true])(
      'preserves a draft without a current session, newSession=%s',
      (newSession) => {
        if (newSession) setState(storePath('activeSessionId', 'session-1'));
        flushSolid();
        setInputTextAndFlush('No session yet');
        cleanup = render(() => ChatInput({ newSession }), container!);
        flushSolid();
        pressSave();
        flushSolid();

        expect(inputText()).toBe('No session yet');
        expect(state.queuedMessages).toEqual([]);
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
          'Open a conversation',
          'warning'
        );
      }
    );

    it('preserves the draft while messages are still loading', () => {
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('messagesLoading', true);
      setInputTextAndFlush('Wait for the session');
      renderChatInput();
      pressSave();
      flushSolid();

      expect(inputText()).toBe('Wait for the session');
      expect(state.queuedMessages).toEqual([]);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'Messages are still loading',
        'warning'
      );
    });

    it('does not submit an inline message edit', () => {
      const warn = vi.spyOn(console, 'warn');
      onTestFinished(() => warn.mockRestore());
      setStateAndFlush('activeSessionId', 'session-1');
      startEditingMessage('user-1', 'session-1', 'Original prompt');
      flushSolid();
      renderChatInput();
      expect(inputText()).toBe('Original prompt');
      setInputTextAndFlush('Edited prompt');
      pressSave();
      flushSolid();

      expect(inputText()).toBe('Edited prompt');
      expect(state.queuedMessages).toEqual([]);
      expect(editMessageMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[STRICT_READ_UNTRACKED]'));
    });
  });

  it('queues busy composer attachments and clears them from the input', async () => {
    setupModelState();

    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('selectedAgent', 'build');
    setStateAndFlush('droppedFiles', [
      { path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' },
    ]);
    setStateAndFlush('clipboardImages', [
      { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
    ]);
    setStateAndFlush('terminalSelection', { text: 'npm test', terminalName: 'zsh' });

    setInputTextAndFlush('Follow up with context');
    renderChatInput();
    await settle();

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    clickAndFlush(queueButton);

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
      queuedContext: {
        editorContext: {
          queuedModel: {
            selection: { providerID: 'openai', modelID: 'gpt-4o' },
            capabilities: { vision: true, pdf: false, tools: true },
          },
        },
      },
    });
  });

  it('keeps the active file selection visible on a queued message', async () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/menus.css',
        relativePath: 'src/menus.css',
        language: 'css',
      },
      selection: { startLine: 6, endLine: 26 },
      diagnostics: [],
    });
    setInputTextAndFlush('Test');
    renderChatInput();

    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton).not.toBeNull();
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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
        workspaceFolders: undefined,
        activeWorkspacePath: null,
        activeFile: {
          path: '/repo/src/menus.css',
          relativePath: 'src/menus.css',
          language: 'css',
        },
        selection: { startLine: 6, endLine: 26 },
        editorText: undefined,
        diagnostics: [],
      },
      currentDocumentEnabled: true,
      autoAttachedFilePath: '/repo/src/menus.css',
      issuesEnabled: true,
      visionDelegationAvailable: false,
    });
    expect(container?.querySelector('.chat-queue-meta-item')?.getAttribute('aria-label')).toBe(
      '1 attachment'
    );
  });

  it('does not generate a queued file attachment when active-file auto-attachment is disabled', async () => {
    setStateAndFlush('autoAttachActiveFile', false);

    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/app.ts', relativePath: 'app.ts', language: 'typescript' },
      selection: { startLine: 2, endLine: 3 },
      diagnostics: [],
    });
    setInputTextAndFlush('Review');
    renderChatInput();
    container!.querySelector<HTMLButtonElement>('[aria-label="Add to queue (Enter)"]')!.click();
    await settle();
    expect(state.queuedMessages[0]?.droppedFiles).toEqual([]);
    expect(state.queuedMessages[0]?.queuedContext?.autoAttachedFilePath).toBeUndefined();
  });

  it('queues under the composer session when navigation races slash-command detection', async () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    setInputTextAndFlush('Queue in the original chat');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Add to queue (Enter)"]');
    setStateAndFlush('activeSessionId', 'session-2');
    setIsLoading(false);
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ sessionId: 'session-1', text: 'Queue in the original chat' }),
    ]);
  });

  it.each([undefined, 'Implement plan'])(
    'dispatches a queued message on authoritative idle, followupTitle=%s',
    async (followupTitle) => {
      vi.useFakeTimers();
      setIsLoadingAndFlush(true);
      setStateAndFlush('activeSessionId', 'session-1');
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      setStateAndFlush('selectedAgent', 'plan');
      setStateAndFlush('queuedMessages', [
        {
          id: 'q1',
          sessionId: 'session-1',
          text: 'Implement the plan',
          followupTitle,
          agent: 'build',
        },
      ]);

      renderChatInput();
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();

      setIsLoading(false);
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();

      for (const handler of serverEventHandlers.get('session.status') ?? []) {
        handler({
          type: 'session.status',
          properties: { sessionID: 'session-1', status: { type: 'idle' } },
        });
      }
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      await settle();

      const expectedOptions = {
        messageId: expect.stringMatching(/^msg_/),
        agent: 'build',
        queuedAttachments: NO_QUEUED_ATTACHMENTS,
        queuedContext: expect.any(Object),
        preserveComposer: true,
        targetSessionId: 'session-1',
        queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
      };
      if (followupTitle) Object.assign(expectedOptions, { followupTitle, omitContext: true });
      expect(sendMessageMock).toHaveBeenCalledWith('Implement the plan', expectedOptions);
      expect(client.session.messages).not.toHaveBeenCalled();
    }
  );

  it('does not dispatch queued messages after an API failure', async () => {
    vi.useFakeTimers();
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'Do not send after failure' },
    ]);

    renderChatInput();
    await settle();

    setStateAndFlush('failedSessionIds', ['session-1']);
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setIsLoadingAndFlush(false);
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
    flushSolid();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);

    setStateAndFlush('failedSessionIds', []);
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('dispatches a queued message for an idle background session', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-2', text: 'Continue in the background' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('Continue in the background', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: NO_QUEUED_ATTACHMENTS,
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-2',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.activeSessionId).toBe('session-1');
    expect(state.queuedMessages).toEqual([]);
  });

  it('dispatches a queued message through its original workspace after switching workspaces', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-2');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setStateAndFlush('sessions', [
      session('session-2', 1, { title: 'Current workspace', directory: '/repo-b' }),
    ]);
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Continue in the original workspace',
        queuedContext: {
          editorContext: {
            workspacePath: '/repo-a',
            activeFile: null,
            selection: null,
            diagnostics: [],
          },
          currentDocumentEnabled: false,
        },
      },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'Continue in the original workspace',
      expect.objectContaining({
        targetSessionId: 'session-1',
        workspaceDirectory: '/repo-a',
      })
    );
    expect(state.activeSessionId).toBe('session-2');
    expect(state.queuedMessages).toEqual([]);
  });

  it('uses the queued model snapshot instead of the displayed workspace catalog', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-2');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setStateAndFlush('providers', [
      {
        id: 'custom',
        name: 'Workspace B',
        source: 'custom',
        models: {
          shared: {
            id: 'shared',
            name: 'Shared text model',
            capabilities: { vision: false, toolcall: false, input: ['audio'] },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Describe the attachment',
        queuedContext: {
          editorContext: {
            workspacePath: '/repo-a',
            activeFile: null,
            selection: null,
            diagnostics: [],
            queuedModel: {
              selection: { providerID: 'custom', modelID: 'shared', variant: 'original' },
              capabilities: { vision: true, pdf: true, tools: true },
            },
          },
          currentDocumentEnabled: false,
        },
      },
    ]);
    let capturedModel: unknown;
    sendMessageMock.mockImplementation(async (_text, options) => {
      capturedModel = options?.queuedContext?.editorContext.queuedModel;
      expect(options).toMatchObject({
        selectedModel: { providerID: 'custom', modelID: 'shared', variant: 'original' },
        targetSessionId: 'session-1',
        workspaceDirectory: '/repo-a',
      });
      return true;
    });

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(capturedModel).toMatchObject({
      capabilities: {
        vision: true,
        tools: true,
        pdf: true,
      },
      selection: { providerID: 'custom', modelID: 'shared', variant: 'original' },
    });
    expect(state.providers[0]?.models.shared?.capabilities).toMatchObject({
      vision: false,
      toolcall: false,
      input: ['audio'],
    });
    expect(state.providers[0]?.models.shared?.variants).toBeUndefined();
  });

  it('dispatches two background queue items after busy then idle events', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-2');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setStateAndFlush('sessions', [session('session-2', 1, { directory: '/repo-b' })]);
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    const queuedContext = {
      editorContext: {
        workspacePath: '/repo-a',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      currentDocumentEnabled: false,
    };
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'First sibling prompt', queuedContext },
      { id: 'q2', sessionId: 'session-1', text: 'Second sibling prompt', queuedContext },
    ]);
    sendMessageMock.mockImplementation(async (_text, options) => {
      if (options?.targetSessionId) {
        setState(storePath('sessionStatus', options.targetSessionId, { type: 'busy' }));
      }
      return true;
    });

    renderChatInput();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();
    postQueuedSessionStatus('session-1', 'idle');
    await flushAsyncWork();
    flushSolid();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First sibling prompt']);
    expect(state.queuedMessages.map((message) => message.id)).toEqual(['q2']);

    postQueuedSessionStatus('session-1', 'busy');
    postQueuedSessionStatus('session-1', 'idle');
    await flushAsyncWork();
    flushSolid();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First sibling prompt',
      'Second sibling prompt',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('waits for busy then idle after a background send is admitted', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'Second prompt');
    let resolveFirstSend: ((sent: boolean) => void) | undefined;
    sendMessageMock
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSend = resolve;
          })
      )
      .mockResolvedValueOnce(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    postQueuedSessionStatus('session-1', 'idle');
    resolveFirstSend?.(true);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);
    expect(state.queuedMessages.map((message) => message.id)).toEqual(['q2']);

    postQueuedSessionStatus('session-1', 'busy');
    postQueuedSessionStatus('session-1', 'idle');
    await flushAsyncWork();
    flushSolid();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'Second prompt',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('dispatches the next background item when busy then idle complete before admission', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('Pending admission', 'Dispatch exactly once');
    let resolveFirstSend: ((sent: boolean) => void) | undefined;
    sendMessageMock
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSend = resolve;
          })
      )
      .mockResolvedValueOnce(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['Pending admission']);

    postQueuedSessionStatus('session-1', 'busy');
    postQueuedSessionStatus('session-1', 'idle');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['Pending admission']);
    expect(state.queuedMessages.map((message) => message.id)).toEqual(['q1', 'q2']);

    resolveFirstSend?.(true);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'Pending admission',
      'Dispatch exactly once',
    ]);
    expect(state.queuedMessages).toEqual([]);

    postQueuedSessionStatus('session-1', 'idle');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a delayed prior-turn idle until a fresh status snapshot is idle', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'After fresh snapshot');
    sendMessageMock.mockResolvedValue(true);
    vi.mocked(client.session.status).mockResolvedValue({ 'session-1': { type: 'idle' } });

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    postQueuedSessionStatus('session-1', 'idle');
    await flushAsyncWork();
    flushSolid();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);
    expect(state.queuedMessages.map((message) => message.id)).toEqual(['q2']);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(client.session.status).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'After fresh snapshot',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('reconciles authoritative status when the background busy event was missed', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'Recovered prompt');
    sendMessageMock.mockResolvedValue(true);
    vi.mocked(client.session.status).mockResolvedValue({});

    renderChatInput();
    postQueuedSessionStatus('session-1', 'idle');
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(client.session.status).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'Recovered prompt',
    ]);
  });

  it.each([false, true])(
    'recovers a running queue when idle arrives only through a snapshot, active=%s',
    async (activateQueuedSession) => {
      vi.useFakeTimers();
      queueForBackgroundSession('First prompt', 'Continue after completion');
      sendMessageMock.mockImplementation(async (_text, options) => {
        if (!options?.targetSessionId) throw new Error('Missing queued target session');
        setState(storePath('sessionStatus', options.targetSessionId, { type: 'busy' }));
        return true;
      });
      vi.mocked(client.session.status).mockResolvedValue({ 'session-1': { type: 'idle' } });

      renderChatInput();
      await vi.advanceTimersByTimeAsync(300);
      await settle();
      expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);
      postQueuedSessionStatus('session-1', 'busy');
      await flushAsyncWork();
      flushSolid();

      // A reconnect/status snapshot restores idle without replaying the idle event.
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      if (activateQueuedSession) setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();

      expect(client.session.status).toHaveBeenCalled();
      expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
        'First prompt',
        'Continue after completion',
      ]);
      expect(state.queuedMessages).toEqual([]);
    }
  );

  it('rechecks running dispatches at a bounded interval and stops after the queue drains', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'After confirmed idle');
    sendMessageMock.mockResolvedValue(true);
    vi.mocked(client.session.status)
      .mockResolvedValueOnce({ 'session-1': { type: 'busy' } })
      .mockResolvedValueOnce({ 'session-1': { type: 'idle' } });

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    postQueuedSessionStatus('session-1', 'busy');
    await flushAsyncWork();
    flushSolid();

    await vi.advanceTimersByTimeAsync(4_999);
    flushSolid();
    expect(client.session.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(client.session.status).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(client.session.status).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'After confirmed idle',
    ]);
    expect(state.queuedMessages).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    flushSolid();
    expect(client.session.status).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it.each(['snapshot', 'local', 'both'])(
    'releases an inactive parent queue after a fresh snapshot settles a descendant seen in %s status',
    async (observedBy) => {
      vi.useFakeTimers();
      setStateAndFlush('activeSessionId', 'session-2');
      setStateAndFlush('sessions', [
        session('session-1', 1_000),
        session('session-2', 1_000),
        session('child', 2_000, { parentID: 'session-1' }),
        session('grandchild', 3_000, { parentID: 'child' }),
      ]);
      setStateAndFlush('sessionStatus', { 'session-1': { type: 'idle' } });
      setStateAndFlush('queuedMessages', [
        { id: 'q1', sessionId: 'session-1', text: 'First prompt' },
        { id: 'q2', sessionId: 'session-1', text: 'After the child settles' },
      ]);
      sendMessageMock.mockResolvedValue(true);
      let resolveFirstStatus!: (
        statuses: Awaited<ReturnType<typeof client.session.status>>
      ) => void;
      vi.mocked(client.session.status)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstStatus = resolve;
            })
        )
        .mockResolvedValue({
          'session-1': { type: 'idle' },
          'session-2': { type: 'busy' },
        });

      renderChatInput();
      await vi.advanceTimersByTimeAsync(300);
      flushSolid();
      expect(sendMessageMock).toHaveBeenCalledOnce();
      postQueuedSessionStatus('session-1', 'busy');

      await vi.advanceTimersByTimeAsync(5_000);
      flushSolid();
      expect(client.session.status).toHaveBeenCalledOnce();
      if (observedBy !== 'snapshot')
        sessionStore.setSessionStatusEntry('grandchild', { type: 'busy' });
      flushSolid();
      resolveFirstStatus(
        observedBy === 'local'
          ? { 'session-1': { type: 'idle' } }
          : { 'session-1': { type: 'idle' }, grandchild: { type: 'busy' } }
      );
      await settle();
      expect(sendMessageMock).toHaveBeenCalledOnce();
      expect(state.queuedMessages.map(({ id }) => id)).toEqual(['q2']);
      postQueuedSessionStatus('session-1', 'idle');
      await vi.advanceTimersByTimeAsync(300);
      flushSolid();
      expect(sendMessageMock).toHaveBeenCalledOnce();

      // No descendant idle event. The newer snapshot must override the old busy entry.
      await vi.advanceTimersByTimeAsync(5_000);
      flushSolid();
      expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
        'First prompt',
        'After the child settles',
      ]);
      expect(state.queuedMessages).toEqual([]);
    }
  );

  it('retries an unresolved status reconciliation after remounting', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'After remount');
    sendMessageMock.mockResolvedValue(true);
    let resolveOldStatus: ((statuses: Record<string, { type: 'idle' }>) => void) | undefined;
    let resolveNewStatus: ((statuses: Record<string, { type: 'idle' }>) => void) | undefined;
    vi.mocked(client.session.status)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldStatus = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewStatus = resolve;
          })
      );

    renderChatInput();
    await vi.advanceTimersByTimeAsync(1_300);
    await settle();
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(client.session.status).toHaveBeenCalledOnce();

    cleanup!();
    flushSolid();
    renderChatInput();
    await vi.advanceTimersByTimeAsync(0);
    await settle();

    expect(client.session.status).toHaveBeenCalledTimes(2);
    resolveOldStatus?.({ 'session-1': { type: 'idle' } });
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    resolveNewStatus?.({ 'session-1': { type: 'idle' } });
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'After remount',
    ]);
  });

  it('does not duplicate a prompt when status reconciliation races an idle event', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'Exactly once');
    let resolveStatus: ((statuses: Record<string, { type: 'idle' }>) => void) | undefined;
    vi.mocked(client.session.status).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(1_300);
    await settle();
    expect(client.session.status).toHaveBeenCalledOnce();

    postQueuedSessionStatus('session-1', 'busy');
    resolveStatus?.({ 'session-1': { type: 'idle' } });
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    postQueuedSessionStatus('session-1', 'idle');
    postQueuedSessionStatus('session-1', 'idle');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'Exactly once',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('does not release an inactive queue when an older idle snapshot follows a retry event', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'After the retry');
    sendMessageMock.mockResolvedValue(true);
    let resolveStatus!: (statuses: Record<string, { type: 'idle' }>) => void;
    vi.mocked(client.session.status).mockImplementationOnce(
      () => new Promise((resolve) => (resolveStatus = resolve))
    );

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    flushSolid();
    postQueuedSessionStatus('session-1', 'busy');
    await vi.advanceTimersByTimeAsync(5_000);
    flushSolid();
    expect(client.session.status).toHaveBeenCalledOnce();

    const retry = { type: 'retry' as const, attempt: 1, message: 'Retrying', next: 8_000 };
    setState(storePath('sessionStatus', 'session-1', retry));
    flushSolid();
    emitServerEvent('session.status', { sessionID: 'session-1', status: retry });
    resolveStatus({ 'session-1': { type: 'idle' } });
    flushSolid();
    await vi.advanceTimersByTimeAsync(300);
    flushSolid();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);
    expect(state.queuedMessages.map(({ id }) => id)).toEqual(['q2']);

    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    emitServerEvent('session.status', { sessionID: 'session-1', status: { type: 'idle' } });
    await vi.advanceTimersByTimeAsync(300);
    flushSolid();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'After the retry',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('prunes admitted phases when queued-message ownership changes', async () => {
    vi.useFakeTimers();
    queueForBackgroundSession('First prompt', 'Transferred prompt');
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['First prompt']);

    setState(storePath('queuedMessages', 0, 'ownerViewId', 'editor'));
    await settle();
    setStateAndFlush('queuedMessages', [
      { id: 'q3', sessionId: 'session-1', text: 'New owned prompt', ownerViewId: 'sidebar' },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'First prompt',
      'New owned prompt',
    ]);
  });

  it('expires a stale authoritative idle status before dispatching a queued message', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-2');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Wait for a fresh status',
        paused: true,
        queuedContext: {
          editorContext: {
            workspacePath: '/repo-a',
            activeFile: null,
            selection: null,
            diagnostics: [],
          },
          currentDocumentEnabled: false,
        },
      },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    postQueuedSessionStatus('session-1', 'idle');
    await vi.advanceTimersByTimeAsync(5_001);
    flushSolid();
    setState(storePath('queuedMessages', 0, 'paused', false));
    flushSolid();
    await vi.advanceTimersByTimeAsync(300);
    flushSolid();

    expect(sendMessageMock).not.toHaveBeenCalled();

    postQueuedSessionStatus('session-1', 'idle');
    await flushAsyncWork();
    flushSolid();
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('removes a restored queued prompt that OpenCode already admitted', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageDispatchingId).toBeNull();
  });

  it('retains an attempted queued message when admission history cannot be read', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_ambiguous',
        sessionId: 'session-1',
        text: 'Keep this prompt',
      },
    ]);
    vi.mocked(client.session.messages).mockRejectedValue(new Error('History unavailable'));

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

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
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();

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
    flushSolid();
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
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);

    renderChatInput();

    const row = container?.querySelector('.chat-queue-item');
    const label = container?.querySelector('.chat-queue-label');
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 100 });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: 100 });

    label?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    expect(label?.getAttribute('title')).toBeNull();

    Object.defineProperty(label, 'clientWidth', { configurable: true, value: 50 });
    label?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();

    expect(label?.getAttribute('title')).toBe('Queued follow-up');
    expect(row?.getAttribute('title')).toBeNull();
  });

  it('pauses queued rows individually and toggles all session rows with Alt-click', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'other', sessionId: 'session-2', text: 'other session' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
    ]);

    renderChatInput();

    const firstRow = container?.querySelector<HTMLElement>('.chat-queue-item');
    const actions = firstRow?.querySelector<HTMLElement>('.chat-queue-actions');
    const actionButtons = Array.from(actions?.querySelectorAll('button') || []);
    const pauseButton = actions?.querySelector<HTMLButtonElement>(
      '[aria-label="Pause queued message"]'
    );
    const pauseIcon = pauseButton?.firstElementChild;

    clickAndFlush(pauseButton);

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
    flushSolid();

    expect(
      state.queuedMessages
        .filter((item) => item.sessionId === 'session-1')
        .every((item) => item.paused)
    ).toBe(true);
    expect(state.queuedMessages.find((item) => item.id === 'other')?.paused).toBeUndefined();

    container
      ?.querySelector<HTMLButtonElement>('[aria-label="Play queued message"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();

    expect(
      state.queuedMessages
        .filter((item) => item.sessionId === 'session-1')
        .every((item) => item.paused === undefined)
    ).toBe(true);
    expect(container?.querySelector('.chat-queue-item.is-paused')).toBeNull();
  });

  it('tracks hidden-scrollbar queue overflow at both edges', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush(
      'queuedMessages',
      Array.from({ length: 6 }, (_, index) => ({
        id: `q${index + 1}`,
        sessionId: 'session-1',
        text: `Queued follow-up ${index + 1}`,
      }))
    );

    renderChatInput();

    const list = container?.querySelector<HTMLElement>('.chat-queue-list');
    expect(list).not.toBeNull();
    Object.defineProperties(list!, {
      clientHeight: { configurable: true, value: 126 },
      scrollHeight: { configurable: true, value: 168 },
    });

    list!.scrollTop = 0;
    list!.dispatchEvent(new Event('scroll'));
    flushSolid();
    expect(list?.classList.contains('has-more-above')).toBe(false);
    expect(list?.classList.contains('has-more-below')).toBe(true);

    list!.scrollTop = 21;
    list!.dispatchEvent(new Event('scroll'));
    flushSolid();
    expect(list?.classList.contains('has-more-above')).toBe(true);
    expect(list?.classList.contains('has-more-below')).toBe(true);

    list!.scrollTop = 42;
    list!.dispatchEvent(new Event('scroll'));
    flushSolid();
    expect(list?.classList.contains('has-more-above')).toBe(true);
    expect(list?.classList.contains('has-more-below')).toBe(false);
  });

  it.each([
    ['all', 'copy'],
    ['uninitialized', 'copy'],
    ['copy', 'copy'],
    ['copyMove', 'copy'],
    ['copyLink', 'copy'],
    ['move', 'move'],
    ['link', 'link'],
    ['linkMove', 'link'],
    ['none', 'none'],
  ] as const)('uses an allowed attachment drop effect for %s drags', (allowed, expected) => {
    renderChatInput();
    const dataTransfer = createDragDataTransfer();
    dataTransfer.effectAllowed = allowed;
    const composer = container!.querySelector('.chat-input-container')!;

    for (const target of [document, composer]) {
      for (const type of ['dragenter', 'dragover']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          dataTransfer: { value: dataTransfer },
          shiftKey: { value: true },
        });
        target.dispatchEvent(event);
        flushSolid();
        expect(event.defaultPrevented).toBe(true);
        expect(dataTransfer.dropEffect).toBe(expected);
      }
    }
  });

  it.each(['text/plain', 'text/uri-list', 'text/html', 'Files'])(
    'ignores %s drags started in the chat even after leaving and re-entering',
    (dragType) => {
      renderChatInput();
      const source = document.createElement('div');
      container!.append(source);
      const composer = container!.querySelector('.chat-input-container')!;
      const dataTransfer = createDragDataTransfer();
      dataTransfer.setData(dragType, '/repo/src/a.ts');
      flushSolid();

      const start = dispatchDragEvent(source, 'dragstart', dataTransfer);
      flushSolid();
      expect(start.defaultPrevented).toBe(false);

      for (const target of [source, composer]) {
        for (const type of ['dragenter', 'dragover', 'dragleave', 'dragenter', 'dragover']) {
          const event = dispatchDragEvent(target, type, dataTransfer);
          flushSolid();
          expect(event.defaultPrevented).toBe(false);
          expect(dataTransfer.dropEffect).toBe('none');
          expect(document.querySelector('.chat-drop-overlay')).toBeNull();
        }
      }

      const drop = dispatchDragEvent(composer, 'drop', dataTransfer);
      flushSolid();
      expect(drop.defaultPrevented).toBe(false);
      expect(state.droppedFiles).toEqual([]);
      expect(document.querySelector('.chat-drop-overlay')).toBeNull();
      dispatchDragEvent(source, 'dragend', dataTransfer);
      flushSolid();

      const externalDrag = dispatchDragEvent(composer, 'dragenter', createDragDataTransfer());
      flushSolid();
      expect(externalDrag.defaultPrevented).toBe(true);
      expect(document.querySelector('.chat-drop-overlay')).not.toBeNull();
    }
  );

  it.each([
    { cancelled: false, shiftKey: false },
    { cancelled: false, shiftKey: true },
    { cancelled: true, shiftKey: false },
    { cancelled: true, shiftKey: true },
  ])(
    'accepts external file drops after an unfinished chat drag, cancelled=$cancelled, Shift=$shiftKey',
    async ({ cancelled, shiftKey }) => {
      const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(
        window
      );
      const originalSend = bridgeWindow.__sendToExtension;
      const sent: WebviewMessage[] = [];
      bridgeWindow.__sendToExtension = (message) => sent.push(message);
      try {
        renderChatInput();
        const source = document.createElement('a');
        container!.append(source);
        if (cancelled) source.addEventListener('dragstart', (event) => event.preventDefault());
        flushSolid();
        const outgoing = createDragDataTransfer();
        outgoing.setData('text/uri-list', 'https://example.com/chat-link');
        flushSolid();
        dispatchDragEvent(source, 'dragstart', outgoing);
        flushSolid();
        // Cancelled drags have no dragend; the host can also lose it after an outgoing drop.
        const incoming = Object.assign(createDragDataTransfer(), { files: [], items: [] });
        incoming.setData('CodeFiles', JSON.stringify(['/repo/src/incoming.ts']));
        flushSolid();
        const composer = container!.querySelector('.chat-input-container')!;
        for (const type of ['dragenter', 'dragover', 'drop']) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, shiftKey });
          Object.defineProperty(event, 'dataTransfer', { value: incoming });
          composer.dispatchEvent(event);
          flushSolid();
          expect(event.defaultPrevented).toBe(true);
        }
        await flushAsyncWork();
        flushSolid();
        expect(sent.filter((message) => message.type === 'files/drop')).toEqual([
          { type: 'files/drop', payload: { paths: ['/repo/src/incoming.ts'] } },
        ]);
        expect(document.querySelector('.chat-drop-overlay')).toBeNull();
      } finally {
        bridgeWindow.__sendToExtension = originalSend;
      }
    }
  );

  it.each([false, true])(
    'keeps accepted external drags out of VS Code window handlers, Shift=%s',
    (shiftKey) => {
      // VS Code installs these bubbling window handlers before loading the extension.
      // dragenter respects defaultPrevented, but dragover forwards even accepted drags.
      const forwarded = vi.fn();
      const hostDragEnter = (event: Event) => {
        if (!event.defaultPrevented) forwarded(event.type);
      };
      const hostDragOver = (event: Event) => forwarded(event.type);
      window.addEventListener('dragenter', hostDragEnter);
      flushSolid();
      window.addEventListener('dragover', hostDragOver);
      flushSolid();
      try {
        renderChatInput();
        const composer = container!.querySelector('.chat-input-container')!;
        for (const target of [document, container!, composer]) {
          for (const type of ['dragenter', 'dragover', 'dragover']) {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
              dataTransfer: { value: createDragDataTransfer() },
              shiftKey: { value: shiftKey },
            });
            target.dispatchEvent(event);
            flushSolid();
            expect(event.defaultPrevented).toBe(true);
          }
        }
        expect(forwarded).not.toHaveBeenCalled();
        expect(document.querySelector('.chat-drop-overlay')).not.toBeNull();
      } finally {
        window.removeEventListener('dragenter', hostDragEnter);
        flushSolid();
        window.removeEventListener('dragover', hostDragOver);
        flushSolid();
      }
    }
  );

  it.each(['dragend', 'blur', 'hidden'])('clears an incoming drop overlay on %s', (type) => {
    renderChatInput();
    dispatchDragEvent(container!, 'dragenter', createDragDataTransfer());
    flushSolid();
    expect(document.querySelector('.chat-drop-overlay')).not.toBeNull();

    if (type === 'hidden') {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        flushSolid();
      } finally {
        visibility.mockRestore();
      }
    } else if (type === 'blur') {
      window.dispatchEvent(new Event('blur'));
      flushSolid();
    } else {
      dispatchDragEvent(container!, 'dragend', createDragDataTransfer());
      flushSolid();
    }
    flushSolid();

    expect(document.querySelector('.chat-drop-overlay')).toBeNull();
  });

  it('keeps an outgoing drag internal after the window loses focus', () => {
    renderChatInput();
    const dataTransfer = createDragDataTransfer();
    dispatchDragEvent(container!, 'dragstart', dataTransfer);
    flushSolid();
    window.dispatchEvent(new Event('blur'));
    flushSolid();

    const event = dispatchDragEvent(container!, 'dragenter', dataTransfer);
    flushSolid();
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('.chat-drop-overlay')).toBeNull();
    dispatchDragEvent(container!, 'dragend', dataTransfer);
    flushSolid();
  });

  it('reorders queued rows by dragging the left handle without showing the file-drop overlay', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    renderChatInput();

    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message:"]'
    );
    const rows = container!.querySelectorAll<HTMLElement>('.chat-queue-item');
    const dataTransfer = createDragDataTransfer();

    expect(handles[0]?.draggable).toBe(true);
    dispatchDragEvent(handles[0]!, 'dragstart', dataTransfer);
    flushSolid();
    dispatchDragEvent(rows[1]!, 'dragover', dataTransfer);
    flushSolid();

    expect(rows[0]?.classList.contains('is-dragging')).toBe(true);
    expect(rows[1]?.classList.contains('is-drag-over')).toBe(true);
    expect(container?.querySelector('.chat-queue-container.is-reordering')).not.toBeNull();
    expect([...handles].map((handle) => handle.textContent?.trim())).toEqual(['1', '2', '3']);
    expect([...handles].every((handle) => handle.querySelector('svg') === null)).toBe(true);
    expect(document.querySelector('.chat-drop-overlay')).toBeNull();

    dispatchDragEvent(rows[1]!, 'drop', dataTransfer);
    flushSolid();
    dispatchDragEvent(handles[0]!, 'dragend', dataTransfer);
    flushSolid();

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

  it.each(['application/x-varro-provider', 'application/x-varro-model'])(
    'does not treat %s reordering as a file drop',
    (dragType) => {
      renderChatInput();
      const dataTransfer = createDragDataTransfer();
      dataTransfer.setData(dragType, 'openai:item');
      flushSolid();

      const dragEnter = dispatchDragEvent(container!, 'dragenter', dataTransfer);
      flushSolid();
      expect(dragEnter.defaultPrevented).toBe(false);
      expect(document.querySelector('.chat-drop-overlay')).toBeNull();

      const drop = dispatchDragEvent(container!, 'drop', dataTransfer);
      flushSolid();
      expect(drop.defaultPrevented).toBe(false);
      expect(state.droppedFiles).toEqual([]);
    }
  );

  it('shows queue positions in the drag handles while Alt is held', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    renderChatInput();

    const handles = container!.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message:"]'
    );
    expect([...handles].every((handle) => handle.querySelector('svg') !== null)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushSolid();

    expect([...handles].map((handle) => handle.textContent?.trim())).toEqual(['1', '2', '3']);
    expect([...handles].every((handle) => handle.querySelector('svg') === null)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    flushSolid();

    expect(container?.querySelector('.chat-queue-position')).toBeNull();
    expect([...handles].every((handle) => handle.querySelector('svg') !== null)).toBe(true);
  });

  it('keeps an edited queue row visible and cancels editing from the row', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(false);
    clickAndFlush(editButton);

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

    clickAndFlush(cancelButton);

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
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second', paused: true },
      { id: 'q3', sessionId: 'session-1', text: 'third' },
    ]);

    renderChatInput();

    container
      ?.querySelectorAll<HTMLButtonElement>('[aria-label="Edit queued message"]')[1]
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    setInputText('second edited');
    await settle();
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton).not.toBeNull();
    expect(inputText()).toBe('second edited');
    expect(queueButton?.disabled).toBe(false);
    queueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(state.queuedMessages.map((item) => item.text)).toEqual([
      'first',
      'second edited',
      'third',
    ]);
    expect(state.queuedMessages[0]?.id).toBe('q1');
    expect(state.queuedMessages[1]?.paused).toBe(true);
    expect(state.queuedMessages[2]?.id).toBe('q3');
  });

  it('can disable an automatically attached document while editing a queued message', async () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/CHANGELOG.md',
        relativePath: 'CHANGELOG.md',
        language: 'markdown',
      },
      selection: null,
      diagnostics: [],
    });
    setInputTextAndFlush('Also run performance tests');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Add to queue (Enter)"]');
    await settle();
    expect(state.queuedMessages[0]?.droppedFiles?.map((file) => file.path)).toEqual([
      '/repo/CHANGELOG.md',
    ]);

    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    expect(state.droppedFiles).toEqual([]);
    const documentChip = container?.querySelector<HTMLElement>(
      '.chat-attachments-container [role="button"][aria-pressed="true"]'
    );
    expect(documentChip?.textContent).toContain('CHANGELOG.md');
    clickAndFlush(documentChip);
    expect(documentChip?.getAttribute('aria-pressed')).toBe('false');

    clickSelectorAndFlush('[aria-label="Add to queue (Enter)"]');
    await settle();
    expect(state.queuedMessages[0]?.droppedFiles).toEqual([]);
    expect(state.queuedMessages[0]?.queuedContext?.currentDocumentEnabled).toBe(false);
  });

  it('keeps an explicitly attached active file when editing a queued message', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/CHANGELOG.md',
        relativePath: 'CHANGELOG.md',
        language: 'markdown',
      },
      selection: null,
      diagnostics: [],
    });
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Review changes',
        droppedFiles: [
          {
            path: '/repo/CHANGELOG.md',
            relativePath: 'CHANGELOG.md',
            type: 'file',
            attachmentSequence: 1,
          },
        ],
        queuedContext: { editorContext: state.editorContext, currentDocumentEnabled: true },
      },
    ]);
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    expect(state.droppedFiles).toEqual([
      expect.objectContaining({ path: '/repo/CHANGELOG.md', attachmentSequence: 1 }),
    ]);
  });

  it('restores the composer document toggle after cancelling a queued message edit', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/CHANGELOG.md',
        relativePath: 'CHANGELOG.md',
        language: 'markdown',
      },
      selection: null,
      diagnostics: [],
    });
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        sessionId: 'session-1',
        text: 'Review changes',
        droppedFiles: [],
        queuedContext: { editorContext: state.editorContext, currentDocumentEnabled: false },
      },
    ]);
    setStateAndFlush('currentDocumentEnabled', true);
    setState((draft) => {
      const current = draft['currentDocumentEnabledBySession'];
      const incoming = {} satisfies typeof current;
      if (incoming === null || incoming === undefined || current === null || current === undefined)
        draft['currentDocumentEnabledBySession'] = incoming;
      else reconcile(incoming)(current);
    });
    flushSolid();
    setStateAndFlush('draftCurrentDocumentEnabled', null);
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    expect(state.currentDocumentEnabledBySession['session-1']).toBe(false);
    expect(state.currentDocumentEnabled).toBe(true);

    clickSelectorAndFlush('[title="Cancel queued message edit"]');
    expect(state.queuedMessageEdit).toBeNull();
    expect(state.currentDocumentEnabledBySession['session-1']).toBeUndefined();
    expect(state.currentDocumentEnabled).toBe(true);
  });

  it('sends an edited attempted message with a fresh message id', async () => {
    vi.useFakeTimers();
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setStateAndFlush('queuedMessages', [
      {
        id: 'q1',
        messageId: 'msg_old_revision',
        sessionId: 'session-1',
        text: 'Old revision',
      },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    setInputText('Edited revision');
    await settle();
    clickSelectorAndFlush('[aria-label="Add to queue (Enter)"]');
    await settle();

    expect(state.queuedMessages[0]).not.toHaveProperty('messageId');
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    setIsLoadingAndFlush(false);
    await vi.advanceTimersByTimeAsync(300);
    await settle();

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
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'paused follow-up', paused: true },
    ]);

    renderChatInput();

    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    setInputTextAndFlush('edited paused follow-up');
    setIsLoading(false);
    await settle();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton).not.toBeNull();
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]?.text).toBe('edited paused follow-up');
    expect(state.queuedMessages[0]?.paused).toBe(true);
  });

  it('pauses automatic queue dispatch while a queued message is being edited', async () => {
    vi.useFakeTimers();
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'first' },
      { id: 'q2', sessionId: 'session-1', text: 'second' },
    ]);

    renderChatInput();

    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    setIsLoading(false);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    flushSolid();

    expect(sendMessageMock).not.toHaveBeenCalled();

    clickSelectorAndFlush('[aria-label="Cancel queued message edit"]');
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('first', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: NO_QUEUED_ATTACHMENTS,
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
  });

  it('does not overwrite existing composer content when editing a queued message', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Keep this draft');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'Queued follow-up' },
    ]);

    renderChatInput();

    const editButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
    expect(editButton?.disabled).toBe(true);
    clickAndFlush(editButton);

    expect(inputText()).toBe('Keep this draft');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);
  });

  it('waits for connection initialization before dispatching a restored queue', async () => {
    vi.useFakeTimers();
    setConnectionInitialized(false);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'restored follow-up' },
    ]);

    renderChatInput();

    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setConnectionInitialized(true);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('restored follow-up', {
      messageId: expect.stringMatching(/^msg_/),
      agent: undefined,
      queuedAttachments: NO_QUEUED_ATTACHMENTS,
      queuedContext: expect.any(Object),
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
  });

  it('skips paused rows and dispatches them after they are played', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'paused first', paused: true },
      { id: 'q2', sessionId: 'session-1', text: 'active second' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();

    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual(['active second']);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1']);

    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    clickSelectorAndFlush('[aria-label="Play queued message"]');
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock.mock.calls.map(([text]) => text)).toEqual([
      'active second',
      'paused first',
    ]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('blocks active-session queued actions until message hydration completes', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messagesLoading', true);
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'wait for hydration' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    const sendNowButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Send as Steer"]'
    );
    expect(sendNowButton?.disabled).toBe(true);
    sendNowButton?.click();
    flushSolid();
    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setStateAndFlush('messagesLoading', false);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'wait for hydration',
      expect.objectContaining({ targetSessionId: 'session-1' })
    );
  });

  it('dispatches a hydrated session queue while the active session is hydrating', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messagesLoading', true);
    setStateAndFlush('queuedMessages', [
      { id: 'active', sessionId: 'session-1', text: 'active waits' },
      { id: 'other', sessionId: 'session-2', text: 'other can send' },
    ]);
    sendMessageMock.mockResolvedValue(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'other can send',
      expect.objectContaining({ targetSessionId: 'session-2' })
    );
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['active']);
  });

  it('retains a failed automatic queue item and its attachments until an explicit retry', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();

    await vi.advanceTimersByTimeAsync(300);
    await settle();

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
    flushSolid();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const retry = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Retry queued message"]'
    );
    expect(retry?.disabled).toBe(false);
    expect(retry?.querySelector('svg')?.getAttribute('width')).toBe('14');
    expect(retry?.querySelector('svg')?.getAttribute('height')).toBe('14');
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 1' },
      { id: 'q2', sessionId: 'session-1', text: 'test 2' },
    ]);
    sendMessageMock.mockRejectedValueOnce(new Error('send failed'));

    renderChatInput();

    await vi.advanceTimersByTimeAsync(300);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    flushSolid();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe('test 1');
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')?.disabled
    ).toBe(false);
  });

  it('stops retrying a queue item missing from the host queue', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'not persisted' },
    ]);
    const claims: WebviewMessage[] = [];
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension = (
      message
    ) => {
      if (message.type !== 'queued-messages/claim') return;
      claims.push(message);
      queueMicrotask(() =>
        applyQueuedMessageClaimResult({
          ...message.payload,
          granted: false,
          deniedReason: 'missing',
        })
      );
    };

    renderChatInput();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(claims).toHaveLength(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.failedQueuedMessageIds).toEqual(['q1']);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Retry queued message"]')?.disabled
    ).toBe(false);
  });

  it('releases a queue lease granted after the claim timed out', async () => {
    vi.useFakeTimers();
    const sent = captureBridgeMessages();
    const item = { id: 'q1', sessionId: 'session-1', text: 'late claim' };

    const claim = claimQueuedMessageDispatch(item);
    const request = sent.find((message) => message.type === 'queued-messages/claim');
    if (request?.type !== 'queued-messages/claim') throw new Error('Expected queue claim');
    await vi.advanceTimersByTimeAsync(5_000);
    flushSolid();
    await expect(claim).resolves.toBeNull();
    flushSolid();
    applyQueuedMessageClaimResult({ ...request.payload, granted: true, lease: 7 });
    flushSolid();

    expect(sent.at(-1)).toEqual({
      type: 'queued-messages/release',
      payload: { itemId: 'q1', sessionId: 'session-1', lease: 7 },
    });
  });

  it('marks a queue item failed when the claim cannot reach the host', async () => {
    const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
    bridgeWindow.__sendToExtension = undefined;
    const item = { id: 'q1', sessionId: 'session-1', text: 'offline claim' };
    setStateAndFlush('queuedMessages', [item]);

    await expect(claimQueuedMessageDispatch(item)).resolves.toBeNull();
    flushSolid();

    expect(state.failedQueuedMessageIds).toEqual(['q1']);
  });

  it('does not duplicate an in-flight queued dispatch after remounting', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'pending follow-up' },
    ]);
    let resolveSend: ((sent: boolean) => void) | undefined;
    sendMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        })
    );

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessageDispatchingId).toBe('q1');

    cleanup!();
    flushSolid();
    renderChatInput();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    resolveSend?.(true);
    await settle();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageDispatchingId).toBeNull();
  });

  it('preserves a failed queued dispatch and allows retry after remounting', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'retry me' }]);
    sendMessageMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    renderChatInput();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(state.failedQueuedMessageIds).toEqual(['q1']);

    cleanup!();
    flushSolid();
    renderChatInput();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    clickSelectorAndFlush('[aria-label="Retry queued message"]');
    await settle();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(state.queuedMessages).toEqual([]);
    expect(state.failedQueuedMessageIds).toEqual([]);
  });

  it('preserves queued-message editing after remounting', async () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'edit this follow-up' },
    ]);

    renderChatInput();
    clickSelectorAndFlush('[aria-label="Edit queued message"]');
    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(inputText()).toBe('edit this follow-up');

    cleanup!();
    flushSolid();
    renderChatInput();
    await settle();

    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(container?.querySelector('.chat-queue-item.is-editing')).not.toBeNull();
    expect(inputText()).toBe('edit this follow-up');
  });

  it.each(['queued', 'inline'] as const)(
    'cancels a %s edit on its origin before carrying the shared draft to the child',
    (kind) => {
      setState(
        storePath('sessions', [session('root', 2000), session('child', 2000, { parentID: 'root' })])
      );
      const existing = assistantMessageEntry({ input: 1, output: 1 });
      setState(
        storePath(
          'messages',
          ['root', 'child'].map((id) => ({
            info: { ...existing.info, id: `${id}-answer`, sessionID: id },
            parts: [
              {
                type: 'text' as const,
                id: `${id}-text`,
                sessionID: id,
                messageID: `${id}-answer`,
                text: 'Existing answer',
              },
            ],
          }))
        )
      );
      setState(storePath('activeSessionId', 'root'));
      setInputText(kind === 'inline' ? 'root unsent' : '');
      setIsLoading(true);
      setStateAndFlush('queuedMessages', [
        { id: 'q', sessionId: 'root', text: 'queued edit', paused: true },
      ]);
      renderChatInput();
      if (kind === 'queued')
        container!.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!.click();
      else startEditingMessage('root-message', 'root', 'inline edit');
      flushSolid();
      expect(inputText()).toBe(`${kind} edit`);
      setState(storePath('activeSessionId', 'child'));
      const restoredDraft = kind === 'inline' ? 'root unsent' : '';
      expect(inputText()).toBe(restoredDraft);
      flushSolid();
      expect(container!.querySelector('.rich-composer')?.textContent).toBe(restoredDraft);
      expect(state.queuedMessageEdit).toBeNull();
      expect(state.queuedMessages[0]?.text).toBe('queued edit');
      setState(storePath('activeSessionId', 'root'));
      expect(inputText()).toBe(kind === 'inline' ? 'root unsent' : '');
    }
  );

  it('clears an edited draft when ownership transfer removes its queued row', async () => {
    const sendToExtension = vi.fn(defaultBridgeSend);
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      sendToExtension;
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'edit this follow-up' },
    ]);
    renderChatInput();
    clickSelectorAndFlush('[aria-label="Edit queued message"]');

    syncQueuedMessages();
    flushSolid();
    const update = sendToExtension.mock.calls.at(-1)?.[0];
    if (update?.type !== 'queued-messages/update') throw new Error('Queue update missing');
    // Acknowledge persistence before the host transfers ownership away from this view.
    applyQueuedMessagesSnapshot(update.payload.messages, update.payload.mutationId);
    await settle();
    cleanup!();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    renderChatInput();
    expect(state.queuedMessageEdit).toEqual({ id: 'q1', sessionId: 'session-1' });
    expect(inputText()).toBe('edit this follow-up');

    applyQueuedMessagesSnapshot([]);
    await settle();

    expect(state.queuedMessageEdit).toBeNull();
    expect(inputText()).toBe('');

    cleanup!();
    flushSolid();
    cleanup = undefined;
    resetDefaultAppState();
    flushSolid();
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedMessageEdit).toBeNull();
    expect(inputText()).toBe('');
  });

  it.each([undefined, 'Inspect failures'])(
    'sends queued rows as steers and removes them on success, followupTitle=%s',
    async (followupTitle) => {
      setupLoadingActiveTurn();
      setStateAndFlush('queuedMessages', [
        {
          id: 'q1',
          sessionId: 'session-1',
          text: 'test 2',
          followupTitle,
          droppedFiles: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' }],
          clipboardImages: [
            { id: 'img-1', url: 'blob:1', mime: 'image/png', filename: 'img-1.png', size: 10 },
          ],
          terminalSelection: { text: 'npm test', terminalName: 'zsh' },
        },
        { id: 'q2', sessionId: 'session-1', text: 'test 3' },
      ]);

      renderChatInput();

      clickSelectorAndFlush('[aria-label="Send as Steer"]');
      await settle();

      const expectedOptions = {
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
      };
      if (followupTitle) Object.assign(expectedOptions, { followupTitle, omitContext: true });
      expect(sendMessageMock).toHaveBeenCalledWith('test 2', expectedOptions);
      expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    }
  );

  it('shows inbox steers above the queue until the same message lands in the transcript', async () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'Later follow-up' },
    ]);
    const info: UserMessage = {
      id: 'msg_pending_steer',
      sessionID: 'session-1',
      role: 'user',
      pendingDelivery: 'steer',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'test-model' },
    };
    setStateAndFlush('messages', [
      {
        info,
        parts: [
          {
            id: 'part_pending',
            messageID: info.id,
            sessionID: info.sessionID,
            type: 'text',
            text: 'Change direction',
          },
        ],
      },
    ]);
    renderChatInput();

    expect(
      [...container!.querySelectorAll('[role="list"]')].map((list) =>
        list.getAttribute('aria-label')
      )
    ).toEqual(['Steered messages', 'Queued messages']);
    expect(container?.querySelector('[aria-label="Steered messages"]')?.textContent).toBe(
      'Change direction'
    );
    expect(getVisibleThreadMessages(state.messages, 'session-1')).toEqual([]);

    expect(container?.querySelector('button[title^="Resume the existing"]')).toBeNull();

    setStateAndFlush('activeSessionId', 'session-other');
    expect(container?.querySelector('[aria-label="Steered messages"]')).toBeNull();
    setStateAndFlush('activeSessionId', 'session-1');
    expect(container?.querySelector('[aria-label="Steered messages"]')?.textContent).toBe(
      'Change direction'
    );

    setIsLoadingAndFlush(false);
    setStateAndFlush('sessionStatus', { 'session-1': { type: 'idle' } });
    const resume = container?.querySelector<HTMLButtonElement>(
      'button[title^="Resume the existing"]'
    );
    expect(resume).toBeTruthy();
    expect(resume?.classList.contains('chat-queue-control')).toBe(true);
    expect(resume?.classList.contains('chat-steer-resume')).toBe(true);
    resume?.click();
    await settle();
    expect(client.session.resumeSteering).toHaveBeenCalledWith('session-1', {
      directory: undefined,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.messages[0]?.info).toMatchObject({ pendingDelivery: 'steer' });

    upsertMessageInfo({ ...info, pendingDelivery: undefined });
    await settle();
    expect(container?.querySelector('[aria-label="Steered messages"]')).toBeNull();
    expect(
      getVisibleThreadMessages(state.messages, 'session-1').map((entry) => entry.info.id)
    ).toEqual([info.id]);
    expect(container?.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
      'Later follow-up'
    );
  });

  it.each([false, true])(
    'matches queue annotation previews for canonical pending steers with deferred content: %s',
    (deferred) => {
      setIsLoadingAndFlush(true);
      setStateAndFlush('activeSessionId', 'session-1');
      const file = createChatAnnotation(
        'Original passage',
        'Test annotation. '.repeat(5),
        'session-source'
      );
      const text = `Steer @${file.relativePath}`;
      const info: UserMessage = {
        id: 'pending-annotation',
        sessionID: 'session-1',
        role: 'user',
        pendingDelivery: 'steer',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openai', modelID: 'test-model' },
      };
      setStateAndFlush('queuedMessages', [
        { id: 'queue-annotation', sessionId: 'session-1', text, droppedFiles: [file] },
      ]);
      setStateAndFlush('messages', [
        {
          info,
          parts: [
            {
              id: 'pending-text',
              messageID: info.id,
              sessionID: info.sessionID,
              type: 'text',
              text,
            },
            {
              id: 'pending-file',
              messageID: info.id,
              sessionID: info.sessionID,
              type: 'file',
              mime: 'text/plain',
              filename: file.relativePath,
              url: deferred
                ? 'varro-content:/part/pending-file'
                : pastedTextDataUrl(file.pastedText!),
              annotation: deferred ? readChatAnnotation(file)! : undefined,
            },
          ],
        },
      ]);
      renderChatInput();
      const labels = [...container!.querySelectorAll('.chat-queue-label')];
      expect(labels.map((label) => label.textContent)).toEqual(
        Array(2).fill(`Steer [${getChatAnnotationLabel('Test annotation. '.repeat(5))}]`)
      );
      expect(
        container!.querySelector('.chat-steer-container .chat-queue-label .ui-icon')
      ).toBeNull();
      expect(
        container!.querySelector('.chat-steer-container [aria-label="1 attachment"]')
      ).not.toBeNull();
      expect(state.messages[0]!.parts[0]).toMatchObject({ text });
    }
  );

  it('does not resend a restored queued steer that OpenCode already admitted', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();
    clickSelectorAndFlush('[aria-label="Send as Steer"]');
    await vi.waitFor(() => expect(state.queuedMessages).toEqual([]));
    flushSolid();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('keeps a queued steer visible and blocks later queue dispatch while pending', async () => {
    setupMatchingActiveTurn();
    vi.useFakeTimers();
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send as Steer"]');
    await settle();

    const queueLabels = () =>
      [...container!.querySelectorAll('.chat-queue-label')].map((item) => item.textContent);
    expect(sendMessageMock).toHaveBeenCalledWith('test 1', {
      agent: undefined,
      delivery: 'steer',
      messageId: expect.stringMatching(/^msg_/),
      queuedAttachments: NO_QUEUED_ATTACHMENTS,
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(queueLabels()).toEqual(['test 1', 'test 2']);
    expect(container?.querySelector('[aria-label="Steered messages"]')?.textContent).toBe('test 1');
    expect(container?.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
      'test 2'
    );
    expect(container?.querySelector('[aria-label="Queued messages"]')?.textContent).not.toContain(
      'test 1'
    );
    expect(container?.querySelector('[aria-label="Steered messages"] button')).toBeNull();

    setIsLoading(false);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(true);
    await settle();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);

    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]).toEqual([
      'test 2',
      {
        messageId: expect.stringMatching(/^msg_/),
        agent: undefined,
        queuedAttachments: NO_QUEUED_ATTACHMENTS,
        queuedContext: expect.any(Object),
        preserveComposer: true,
        targetSessionId: 'session-1',
        queuedMessageDispatch: { itemId: 'q2', lease: expect.any(Number) },
      },
    ]);
  });

  it.each(['response', 'event'] as const)(
    'does not reinsert an accepted steer into the queue during %s acknowledgement',
    async (acknowledgement) => {
      setupLoadingActiveTurn();
      setStateAndFlush('queuedMessages', [
        { id: 'q1', sessionId: 'session-1', text: 'Change direction' },
        { id: 'q2', sessionId: 'session-1', text: 'Later follow-up' },
      ]);
      let resolveSend: ((sent: boolean) => void) | undefined;
      sendMessageMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveSend = resolve))
      );
      renderChatInput();
      container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
      await settle();
      expect(resolveSend).toBeDefined();
      expect(container?.querySelector('[data-steered-message-id="q1"]')).not.toBeNull();

      const reinserted: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-queued-message-id="q1"]')) reinserted.push('q1');
            if (node.querySelector('[data-queued-message-id="q1"]')) reinserted.push('q1');
          }
        }
      });
      observer.observe(container!, { childList: true, subtree: true });
      flushSolid();
      try {
        if (acknowledgement === 'event') {
          emitServerEvent('session.next.prompt.admitted', {
            sessionID: 'session-1',
            delivery: 'steer',
            prompt: { text: 'Change direction' },
          });
          await flushAsyncWork();
          flushSolid();
        }
        flushSolid();
        resolveSend?.(true);
        await settle();

        expect(reinserted).toEqual([]);
        expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
      } finally {
        observer.disconnect();
      }
    }
  );

  it('removes a pending queued steer when the backend admits it', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [
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

    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send as Steer"]');
    await vi.waitFor(() => expect(resolveSteer).toBeDefined());
    flushSolid();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    emitServerEvent('session.next.prompt.admitted', {
      sessionID: 'session-1',
      delivery: 'steer',
      prompt: { text: 'test 1\n[Working directory: /repo]' },
    });
    await flushAsyncWork();
    flushSolid();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Steering...');

    expect(resolveSteer).toBeDefined();
    resolveSteer?.(false);
    await settle();

    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q2']);
    expect(container?.textContent).not.toContain('Retry Steer');
  });

  it('restores a queued row when steering it reports a send error', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'test 2' },
      { id: 'q2', sessionId: 'session-1', text: 'test 3' },
    ]);
    sendMessageMock.mockResolvedValueOnce(false);

    renderChatInput();

    clickSelectorAndFlush('[aria-label="Send as Steer"]');
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('test 2', {
      agent: undefined,
      delivery: 'steer',
      messageId: expect.stringMatching(/^msg_/),
      queuedAttachments: NO_QUEUED_ATTACHMENTS,
      preserveComposer: true,
      targetSessionId: 'session-1',
      queuedMessageDispatch: { itemId: 'q1', lease: expect.any(Number) },
    });
    expect(state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(container?.querySelector('[aria-label="Retry send as Steer"]')).not.toBeNull();
  });

  it.each(['steer', 'queue'] as const)(
    'retries a queued %s through the session directory instead of the selected workspace folder',
    async (mode) => {
      vi.useFakeTimers();
      setupMatchingActiveTurn();
      setIsLoading(mode === 'steer');
      flushSolid();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [
        session('session-1', 1, { directory: '/workspace-root', workspaceScope: 'workspace' }),
      ]);
      setState(storePath('editorContext', 'workspacePath', '/selected-folder'));
      flushSolid();
      const queuedContext = {
        editorContext: {
          workspacePath: '/selected-folder',
          workspaceDirectory: '/workspace-root',
          activeFile: null,
          selection: null,
          diagnostics: [],
        },
        currentDocumentEnabled: false,
      };
      setStateAndFlush('queuedMessages', [
        {
          id: 'q1',
          sessionId: 'session-1',
          messageId: 'msg_original',
          text: 'Retry in the owning workspace',
          queuedContext,
        },
      ]);
      queuedMessageWasAdmittedMock.mockResolvedValue(false);
      sendMessageMock.mockResolvedValue(true);
      renderChatInput();

      if (mode === 'steer') {
        container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
        flushSolid();
      } else {
        await vi.advanceTimersByTimeAsync(300);
        flushSolid();
      }
      await settle();

      expect(queuedMessageWasAdmittedMock).toHaveBeenCalledWith(
        'session-1',
        'msg_original',
        '/workspace-root',
        { itemId: 'q1', lease: expect.any(Number) }
      );
      expect(sendMessageMock).toHaveBeenCalledWith(
        'Retry in the owning workspace',
        expect.objectContaining({
          messageId: 'msg_original',
          targetSessionId: 'session-1',
          workspaceDirectory: '/workspace-root',
          queuedContext,
        })
      );
      expect(state.queuedMessages).toEqual([]);
    }
  );

  it('shows a steering retry history error and retries without changing the message identity', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', messageId: 'msg_original', text: 'Retry me' },
    ]);
    queuedMessageWasAdmittedMock.mockRejectedValueOnce(new Error('404 Session not found'));
    queuedMessageWasAdmittedMock.mockResolvedValueOnce(false);
    sendMessageMock.mockResolvedValue(true);
    renderChatInput();

    container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
    await settle();

    expect(sendError()).toContain('404 Session not found');
    flushSolid();
    expect(state.queuedMessages[0]?.messageId).toBe('msg_original');
    expect(sendMessageMock).not.toHaveBeenCalled();
    const retry = container?.querySelector<HTMLButtonElement>('[aria-label="Retry send as Steer"]');
    expect(retry).not.toBeNull();
    retry?.click();
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      'Retry me',
      expect.objectContaining({ messageId: 'msg_original' })
    );
    expect(sendError()).toBeNull();
    flushSolid();
    expect(state.queuedMessages).toEqual([]);
  });

  it('shows feedback when a steering dispatch claim is denied', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Retry me' }]);
    defaultBridgeSend = (message) => {
      if (message.type !== 'queued-messages/claim') return;
      queueMicrotask(() => applyQueuedMessageClaimResult({ ...message.payload, granted: false }));
    };
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      defaultBridgeSend;
    renderChatInput();

    container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
    await settle();

    expect(sendError()).toContain('dispatch');
    flushSolid();
    expect(state.queuedMessages).toHaveLength(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="Retry send as Steer"]')).not.toBeNull();
  });

  it('shows feedback when a steering dispatch claim times out', async () => {
    vi.useFakeTimers();
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Retry me' }]);
    defaultBridgeSend = () => {};
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      defaultBridgeSend;
    renderChatInput();

    container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
    flushSolid();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(sendError()).toContain('dispatch');
    flushSolid();
    expect(state.queuedMessages).toHaveLength(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="Retry send as Steer"]')).not.toBeNull();
  });

  it.each(['throws', 'returns false', 'reports error'] as const)(
    'shows steering send feedback when the send %s',
    async (result) => {
      setupLoadingActiveTurn();
      setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'Retry me' }]);
      sendMessageMock.mockImplementationOnce(async () => {
        if (result === 'throws') throw new Error('Backend unavailable');
        if (result === 'reports error') setError('Backend unavailable');
        return false;
      });
      renderChatInput();

      container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
      await settle();

      expect(sendError()).toContain(
        result === 'returns false' ? 'Could not send steering message' : 'Backend unavailable'
      );
      flushSolid();
      expect(state.queuedMessages).toHaveLength(1);
      expect(container?.querySelector('[aria-label="Retry send as Steer"]')).not.toBeNull();
    }
  );

  it('does not show a late steering history error in another session', async () => {
    setupLoadingActiveTurn();
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', messageId: 'msg_original', text: 'Retry me' },
    ]);
    let rejectHistory: ((error: Error) => void) | undefined;
    queuedMessageWasAdmittedMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectHistory = reject))
    );
    renderChatInput();

    container?.querySelector<HTMLButtonElement>('.chat-queue-action')?.click();
    await settle();
    expect(rejectHistory).toBeDefined();
    setStateAndFlush('activeSessionId', 'session-2');
    setError('Keep the current session error');
    flushSolid();
    rejectHistory?.(new Error('404 Session not found'));
    await settle();

    expect(sendError()).toBe('Keep the current session error');
    flushSolid();
    expect(state.queuedMessages[0]?.messageId).toBe('msg_original');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('accepts restored inline-edit images before their preview finishes decoding', async () => {
    setupModelState();
    setState(storePath('providers', 0, 'models', 'gpt-4o', 'capabilities', 'vision', true));
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [userMessageEntry({ providerID: 'openai', modelID: 'gpt-4o' })]);
    let finishDecode: ((image: HTMLImageElement) => void) | undefined;
    vi.mocked(imageLoading.loadImage).mockImplementationOnce(
      () => new Promise((resolve) => (finishDecode = resolve))
    );
    const image = {
      id: 'edit-img',
      url: 'data:image/png;base64,restored',
      mime: 'image/png',
      filename: 'Image 1',
      size: 10,
    };
    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [],
      images: [image],
      terminalSelection: null,
    });
    await settle();

    const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
    const send = container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!;
    expect(container!.querySelector('.chat-attachment-chip')).not.toBeNull();
    expect(send.disabled).toBe(false);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(editMessageMock).toHaveBeenCalledWith(
      'message-1',
      'edited prompt',
      expect.objectContaining({
        queuedAttachments: expect.objectContaining({
          clipboardImages: [expect.objectContaining(image)],
        }),
      })
    );
    expect(finishDecode).toBeDefined();
    finishDecode?.(document.createElement('img'));
    await flushAsyncWork();
    flushSolid();
    expect(editMessageMock).toHaveBeenCalledTimes(1);
  });

  it('restores edited message context and restores draft context on cancel', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('draft prompt');
    setStateAndFlush('droppedFiles', [
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    setStateAndFlush('clipboardImages', [
      { id: 'draft-img', url: 'blob:draft', mime: 'image/png', filename: 'draft.png', size: 10 },
    ]);
    setStateAndFlush('terminalSelection', { text: 'pwd', terminalName: 'draft-terminal' });

    renderChatInput();

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' }],
      images: [
        { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.toolbar-repository-link')).toBeNull();
    expect(inputText()).toBe('edited prompt');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' },
    ]);
    expect(state.clipboardImages).toEqual([
      { id: 'edit-img', url: 'blob:edit', mime: 'image/png', filename: 'edit.png', size: 0 },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });

    clickSelectorAndFlush('[title="Cancel editing (Esc)"]');

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('current', 'Current model', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, max: {} },
        }),
        toolModel('original', 'Original model', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, high: {} },
        }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'current' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'current', variant: 'max' });
    setStateAndFlush('messages', [
      userMessageEntry({ providerID: 'openai', modelID: 'original', variant: 'high' }),
    ]);

    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, {
      providerID: 'openai',
      modelID: 'original',
      variant: 'high',
    });
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Original model');
    expect(container?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain(
      'High'
    );
    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'current',
      variant: 'max',
    });

    clickSelectorAndFlush('[title="Cancel editing (Esc)"]');

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
    flushSolid();
    await Promise.resolve();
    flushSolid();
    container?.querySelector<HTMLElement>('.rich-composer')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await settle();

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

  it.each([
    { providerID: '', modelID: '' },
    { providerID: 'openai', modelID: '' },
    { providerID: '', modelID: 'current' },
  ])(
    'keeps the composer model when the edited prompt has an incomplete route %j',
    async (model) => {
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('providers', [
        apiProvider('openai', 'OpenAI', [
          toolModel('current', 'Current model', {
            capabilities: { toolcall: true, reasoning: true },
            variants: { low: {}, high: {} },
          }),
        ]),
      ]);
      const selection = { providerID: 'openai', modelID: 'current', variant: 'high' };
      setStateAndFlush('selectedModel', selection);
      setStateAndFlush('messages', [userMessageEntry(model)]);

      renderChatInput();
      startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, model);
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Current model');
      expect(container?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain(
        'High'
      );
      expect(state.selectedModel).toEqual(selection);

      container?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]')?.click();
      flushSolid();
      expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Current model');
      expect(state.selectedModel).toEqual(selection);

      startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, model);
      flushSolid();
      await Promise.resolve();
      flushSolid();
      container
        ?.querySelector<HTMLElement>('.rich-composer')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      await settle();

      expect(editMessageMock).toHaveBeenCalledWith(
        'message-1',
        'edited prompt',
        expect.objectContaining({ selectedModel: selection })
      );
      expect(state.selectedModel).toEqual(selection);
    }
  );

  it('retrieves provider limits as soon as a model is selected while editing', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [toolModel('current', 'Current model')]),
      apiProvider('xai', 'xAI', [toolModel('grok-code-fast-1', 'Grok Code Fast 1')]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'current', xai: 'grok-code-fast-1' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'current' });
    setStateAndFlush('messages', [userMessageEntry({ providerID: 'openai', modelID: 'current' })]);

    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'edited prompt');
    flushSolid();
    setShowModelPicker(true);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const grokOption = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.model-picker-item') ?? []),
    ].find((option) => option.textContent?.includes('Grok Code Fast 1'));
    grokOption?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(grokOption).toBeDefined();
    expect(refreshProviderLimitMock).toHaveBeenCalledWith('xai', 'grok-code-fast-1');
    expect(editMessageMock).not.toHaveBeenCalled();
  });

  it.each(['published', 'failed', 'session-switched'] as const)(
    'shows chat-loading dots while an edit reconciles and clears them when %s',
    async (outcome) => {
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('messages', [userMessageEntry({ providerID: 'openai', modelID: 'gpt-4o' })]);
      let finishEdit: ((sent: boolean) => void) | undefined;
      let publishEdit: (() => void) | undefined;
      editMessageMock.mockImplementationOnce(
        (_messageId, _text, options) =>
          new Promise((resolve) => {
            finishEdit = resolve;
            publishEdit = options?.onOptimisticPublish;
          })
      );
      renderChatInput();
      startEditingMessage('message-1', 'session-1', 'corrected prompt');
      await settle();
      const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();

      const loading = container!.querySelector(
        '[role="status"][aria-label="Updating conversation"]'
      );
      expect(loading?.querySelector('.composer-edit-loading-title')?.textContent).toBe(
        'Updating conversation'
      );
      expect(loading?.querySelectorAll('.chat-messages-loading-dot')).toHaveLength(3);
      expect(inputText()).toBe('');
      expect(container!.querySelector('.interactive-input-part')?.getAttribute('aria-busy')).toBe(
        'true'
      );
      expect(container!.querySelector('.composer-edit-banner')?.hasAttribute('inert')).toBe(true);
      expect(container!.querySelector('.chat-input-shell')?.hasAttribute('inert')).toBe(true);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      flushSolid();
      expect(editMessageMock).toHaveBeenCalledTimes(1);

      if (outcome === 'published') {
        publishEdit?.();
        flushSolid();
        expect(container!.querySelector('.composer-edit-loading')).toBeNull();
      }
      if (outcome === 'session-switched') {
        setStateAndFlush('activeSessionId', 'session-2');
        expect(container!.querySelector('.composer-edit-loading')).toBeNull();
      }
      flushSolid();
      finishEdit?.(outcome === 'published');
      await flushAsyncWork();
      flushSolid();

      expect(container!.querySelector('.composer-edit-loading')).toBeNull();
      expect(container!.querySelector('.chat-input-shell')?.hasAttribute('inert')).toBe(false);
      if (outcome === 'failed') {
        expect(inputText()).toBe('corrected prompt');
        expect(container!.querySelector('.composer-edit-banner')?.hasAttribute('inert')).toBe(
          false
        );
      }
    }
  );

  it('restores edited text and preserves the prior draft when an optimistic send fails', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('original draft');
    setStateAndFlush('droppedFiles', [
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    setStateAndFlush('terminalSelection', { text: 'pwd', terminalName: 'draft-terminal' });
    setStateAndFlush('messages', [userMessageEntry({ providerID: 'openai', modelID: 'gpt-4o' })]);
    editMessageMock.mockImplementationOnce(async (_messageId, _text, options) => {
      options?.onOptimisticPublish?.();
      return false;
    });

    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'corrected prompt', {
      files: [{ path: '/repo/edit.ts', relativePath: 'edit.ts', type: 'file' }],
      images: [],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container?.querySelector<HTMLElement>('.rich-composer')?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    await settle();

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

    clickSelectorAndFlush('[title="Cancel editing (Esc)"]');

    expect(inputText()).toBe('original draft');
    expect(state.droppedFiles).toEqual([
      { path: '/repo/draft.ts', relativePath: 'draft.ts', type: 'file' },
    ]);
    expect(state.terminalSelection).toEqual({ text: 'pwd', terminalName: 'draft-terminal' });
  });

  it('merges an edited whole-file attachment into the active document context', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: null,
      diagnostics: [],
    });

    renderChatInput();

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [{ path: 'app.ts', relativePath: 'app.ts', type: 'file' }],
      images: [],
      terminalSelection: null,
    });
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.droppedFiles).toEqual([]);
    const chips = container?.querySelectorAll('.chat-attachments-container .chat-attachment-chip');
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.textContent).toContain('app.ts');
    expect(chips?.[0]?.querySelector('.chip-remove')).toBeNull();
  });

  it('does not duplicate the active document when editing its ranged attachment', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/package.json',
        relativePath: 'package.json',
        language: 'json',
      },
      selection: { startLine: 391, endLine: 391 },
      diagnostics: [],
    });

    renderChatInput();

    startEditingMessage('message-1', 'session-1', 'edited prompt', {
      files: [
        {
          path: '/repo/package.json',
          relativePath: 'package.json',
          type: 'file',
          lineRanges: [{ startLine: 391, endLine: 391 }],
        },
      ],
      images: [],
      terminalSelection: null,
    });
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.droppedFiles).toHaveLength(1);
    const chips = container?.querySelectorAll('.chat-attachments-container .chat-attachment-chip');
    expect(chips).toHaveLength(1);
    expect(chips?.[0]?.textContent).toContain('package.json');
    expect(chips?.[0]?.textContent).toContain('L391');
  });

  it('does not keep edited message text in the composer after remounting into another session', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('draft prompt');

    renderChatInput();

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(inputText()).toBe('edited prompt');

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    setStateAndFlush('activeSessionId', 'session-2');
    renderChatInput();
    await Promise.resolve();
    flushSolid();

    expect(inputText()).toBe('draft prompt');
  });

  it('hides the workspace selector while editing a message', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));
    renderChatInput();
    expect(container?.querySelector('.workspace-picker-button')).not.toBeNull();

    startEditingMessage('message-1', 'session-1', 'edited prompt');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.workspace-picker-button')).toBeNull();
  });

  it('queues on modifier Enter while a question is pending and dispatches after it clears', async () => {
    vi.useFakeTimers();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setInputTextAndFlush('Wait for the answer');
    sendMessageMock.mockResolvedValueOnce(true);

    renderChatInput();

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
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ sessionId: 'session-1', text: 'Wait for the answer' }),
    ]);
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();

    setStateAndFlush('questions', []);
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('Wait for the answer', {
      workspaceDirectory: '/repo',
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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('permissions', [
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
    setInputTextAndFlush('Wait for permission');

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const queueButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Add to queue (Enter)"]'
    );
    expect(queueButton?.disabled).toBe(false);
    expect(container?.querySelector('[aria-label="More send options"]')).toBeNull();

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
    expect(state.queuedMessages).toEqual([
      expect.objectContaining({ sessionId: 'session-1', text: 'Wait for permission' }),
    ]);
  });

  it('shows a read-only workspace dropdown in an active chat', () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));
    setStateAndFlush('messages', [assistantMessageEntry({ input: 100, output: 20 })]);

    renderChatInput();

    clickSelectorAndFlush('.workspace-picker-button');

    expect(container?.querySelector('.workspace-popover-notice')?.textContent).toContain(
      "Workspace can't be changed in an active chat."
    );
    const option = container?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo-b"]');
    expect(option?.disabled).toBe(true);
    clickAndFlush(option);
    expect(container?.querySelector('.workspace-popover')).not.toBeNull();
  });

  it('sends a new no-project chat in scratch without presenting it as an open folder', async () => {
    setStateAndFlush('activeSessionId', null);
    setStateAndFlush('editorContext', {
      workspacePath: '/varro/scratch',
      workspaceDirectory: '/varro/scratch',
      workspaceFolders: [],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    renderChatInput();
    expect(container?.querySelector('.workspace-picker-button')).toBeNull();
    setInputTextAndFlush('Help me write notes');
    sendMessageMock.mockResolvedValue(true);
    await flushAsyncWork();
    flushSolid();
    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();
    expect(sendMessageMock).toHaveBeenCalledWith('Help me write notes', {
      noReply: false,
      queuedAttachments: undefined,
      newSessionWorkspace: { scope: 'folder', directory: '/varro/scratch' },
    });
  });

  it('switches an active blank workspace chat to a folder-scoped lazy chat', async () => {
    const messages = captureBridgeMessages();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1_000, {
        directory: '/repo-a',
        title: 'New Chat',
        workspaceScope: 'workspace',
        time: { created: 1_000, updated: 1_000 },
      }),
    ]);
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));

    renderChatInput();
    clickSelectorAndFlush('.workspace-picker-button');

    expect(container?.querySelector('.workspace-popover-notice')).toBeNull();
    const option = container?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo-b"]');
    expect(option?.disabled).toBe(false);
    clickAndFlush(option);
    expect(container?.querySelector('.workspace-popover')).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(manualWorkspaceSelection()).toBe(true);
    expect(
      container
        ?.querySelector<HTMLButtonElement>('.workspace-picker-button')
        ?.getAttribute('aria-label')
    ).toContain('Repo B');
    expect(messages).toContainEqual({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: expect.any(Number) },
    });

    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setInputTextAndFlush('Send from Repo B');
    sendMessageMock.mockResolvedValue(true);
    await flushAsyncWork();
    flushSolid();
    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('Send from Repo B', {
      noReply: false,
      queuedAttachments: undefined,
      newSessionWorkspace: { scope: 'folder', directory: '/repo-b' },
    });
  });

  it('switches an active blank folder chat back to workspace scope', () => {
    setManualWorkspaceSelection(true);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1_000, {
        directory: '/repo-a',
        title: 'New Chat',
        time: { created: 1_000, updated: 1_000 },
      }),
    ]);
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));

    renderChatInput();
    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('.workspace-popover-all');

    expect(state.activeSessionId).toBeNull();
    expect(manualWorkspaceSelection()).toBe(false);
    expect(
      container
        ?.querySelector<HTMLButtonElement>('.workspace-picker-button')
        ?.getAttribute('aria-label')
    ).toContain('Workspace');
  });

  it('selects the active file workspace for an empty new chat', async () => {
    setupModelState();
    const messages = captureBridgeMessages();
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a', '/repo-b'));

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    await settle();

    expect(messages).toContainEqual({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: expect.any(Number) },
    });
    expect(state.pendingWorkspaceSelectionPath).toBe('/repo-b');
    expect(state.workspaceSelectionRequestId).toEqual(expect.any(Number));

    const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
    enterComposerText(editor, 'Send after the workspace acknowledgement');
    const sendButton = container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!;
    expect(sendButton.disabled).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Send after the workspace acknowledgement');

    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    await settle();

    expect(state.pendingWorkspaceSelectionPath).toBeNull();
    expect(sendButton.disabled).toBe(false);
    sendButton.click();
    await settle();
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Send after the workspace acknowledgement',
      expect.objectContaining({ noReply: false })
    );
    expect(messages.filter((message) => message.type === 'workspace/select')).toHaveLength(1);
  });

  it.each(['', 'Keep this draft after the failed switch'])(
    'recovers from a failed automatic workspace switch with draft %j',
    async (draft) => {
      setupModelState();
      const messages = captureBridgeMessages();
      setStateAndFlush('editorContext', {
        workspacePath: '/repo-a',
        activeWorkspacePath: '/repo-b',
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      });
      cleanup = render(() => ChatInput({ newSession: true }), container!);
      await settle();

      const request = messages.find((message) => message.type === 'workspace/select');
      if (!request || request.type !== 'workspace/select')
        throw new Error('Expected workspace request');
      expect(request.payload).toEqual({ path: '/repo-b', requestId: expect.any(Number) });
      expect(state.workspaceSelectionRequestId).toBe(request.payload.requestId);
      expect(state.pendingWorkspaceSelectionPath).toBe('/repo-b');
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      if (draft) enterComposerText(editor, draft);
      const sendButton = container!.querySelector<HTMLButtonElement>(
        '[aria-label="Send (Enter)"]'
      )!;
      expect(sendButton.disabled).toBe(true);
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();

      handleWorkspaceSelectionFailure({ ...request.payload, error: 'Folder unavailable' });
      await flushAsyncWork();
      flushSolid();

      expect(state.pendingWorkspaceSelectionPath).toBeNull();
      expect(state.workspaceSelectionRequestId).toBeNull();
      expect(manualWorkspaceSelection()).toBe(true);
      expect(state.editorContext.workspacePath).toBe('/repo-a');
      expect(inputText()).toBe(draft);
      expect(editor.textContent).toBe(draft);
      expect(messages.filter((message) => message.type === 'workspace/select')).toEqual([request]);

      const text = draft || 'Send in the current workspace';
      if (!draft) enterComposerText(editor, text);
      flushSolid();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledWith(
        text,
        expect.objectContaining({ newSessionWorkspace: { scope: 'folder', directory: '/repo-a' } })
      );
    }
  );

  it.each(['/repo-a', '/repo-b'])(
    'allows a new chat after an unresolved plan with the active editor in %s',
    async (activeWorkspacePath) => {
      vi.useFakeTimers();
      setupModelState();
      const messages = captureBridgeMessages();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 2_000, { directory: '/repo-a' })]);
      const assistant = assistantMessageEntry({ input: 100, output: 20 });
      setStateAndFlush('messages', [
        {
          ...assistant,
          info: {
            ...assistant.info,
            agent: 'plan',
            finish: 'stop',
            time: { created: 1_000, completed: 2_000 },
            path: { cwd: '/repo-a', root: '/repo-a' },
          },
          parts: [
            {
              id: 'plan-text',
              sessionID: 'session-1',
              messageID: assistant.info.id,
              type: 'text',
              text: 'Plan: add validation, then cover invalid input with tests.',
            },
          ],
        },
      ]);
      setStateAndFlush('editorContext', {
        workspacePath: '/repo-a',
        activeWorkspacePath,
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      });
      renderChatInput();
      expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));

      startNewChatDraft();
      await settle();
      expect(state.activeSessionId).toBeNull();
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      enterComposerText(editor, 'Start a separate task');
      const sendButton = container!.querySelector<HTMLButtonElement>(
        '[aria-label="Send (Enter)"]'
      )!;
      if (activeWorkspacePath === '/repo-b') {
        expect(messages.filter((message) => message.type === 'workspace/select')).toEqual([
          { type: 'workspace/select', payload: { path: '/repo-b', requestId: expect.any(Number) } },
        ]);
        expect(sendButton.disabled).toBe(true);
        setState(storePath('editorContext', 'workspacePath', '/repo-b'));
        flushSolid();
      } else {
        expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));
      }
      flushSolid();
      await vi.advanceTimersByTimeAsync(50);
      flushSolid();
      expect(state.messages).toEqual([]);
      expect(state.pendingWorkspaceSelectionPath).toBeNull();
      expect(inputText()).toBe('Start a separate task');
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledWith(
        'Start a separate task',
        expect.objectContaining({ noReply: false })
      );
    }
  );

  it('does not reselect an equivalent UNC workspace for an empty new chat', async () => {
    const messages = captureBridgeMessages();
    setStateAndFlush('editorContext', {
      workspacePath: '\\\\BuildServer\\Projects\\Varro',
      workspaceFolders: [{ name: 'Varro', path: '\\\\BuildServer\\Projects\\Varro' }],
      activeWorkspacePath: '//buildserver/PROJECTS/varro/',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    await settle();

    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));
  });

  it('does not override a workspace selected outside the composer', async () => {
    const messages = captureBridgeMessages();
    setManualWorkspaceSelection(true);
    flushSolid();
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-b', '/repo-a'));

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    await settle();

    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));
  });

  it('waits for a typed new-chat draft to become empty before selecting the active workspace', async () => {
    const messages = captureBridgeMessages();

    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a', '/repo-b'));

    setInputTextAndFlush('Keep this workspace');
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    await settle();
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));

    setInputText('');
    await settle();

    expect(messages).toContainEqual({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: expect.any(Number) },
    });
  });

  it('preserves a manual composer workspace until the draft becomes empty again', async () => {
    const messages = captureBridgeMessages();
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a', '/repo-a'));
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('button[data-workspace-path="/repo-b"]');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setState(storePath('editorContext', 'activeWorkspacePath', '/repo-a'));
    await settle();

    expect(messages.filter((message) => message.type === 'workspace/select')).toEqual([
      { type: 'workspace/select', payload: { path: '/repo-b', requestId: expect.any(Number) } },
    ]);

    setInputTextAndFlush('Reset the manual choice');
    setInputText('');
    await settle();

    expect(messages.filter((message) => message.type === 'workspace/select')).toEqual([
      { type: 'workspace/select', payload: { path: '/repo-b', requestId: expect.any(Number) } },
      { type: 'workspace/select', payload: { path: '/repo-a', requestId: expect.any(Number) } },
    ]);
  });

  it('treats attachment-only drafts as nonempty for workspace auto-follow', async () => {
    const messages = captureBridgeMessages();
    setManualWorkspaceSelection(true);
    flushSolid();
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-b', '/repo-a'));
    addContextFile({ path: '/repo-b/context.ts', relativePath: 'context.ts', type: 'file' });
    flushSolid();

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    await settle();
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));

    removeContextFile('/repo-b/context.ts');
    await settle();

    expect(messages).toContainEqual({
      type: 'workspace/select',
      payload: { path: '/repo-a', requestId: expect.any(Number) },
    });
  });

  it('keeps a manual workspace selected until send capture', async () => {
    const sequence: string[] = [];
    let resolveSend: ((value: boolean) => void) | undefined;
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension = (
      message
    ) => {
      if (message.type === 'workspace/select') sequence.push(`select:${message.payload.path}`);
    };
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a', '/repo-a'));
    sendMessageMock.mockImplementation(() => {
      sequence.push('send');
      return new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      });
    });
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('button[data-workspace-path="/repo-b"]');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setState(storePath('editorContext', 'activeWorkspacePath', '/repo-a'));
    flushSolid();
    setInputText('Send from Repo B');
    await settle();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    expect(sequence).toEqual(['select:/repo-b', 'send']);

    resolveSend?.(true);
    await settle();

    expect(sequence).toEqual(['select:/repo-b', 'send', 'select:/repo-a']);
  });

  it('keeps the selected folder until the first message is ready to replace the composer', async () => {
    let publishOptimisticMessage: (() => void) | undefined;
    let resolveSend: ((value: boolean) => void) | undefined;
    setStateAndFlush('editorContext', {
      workspacePath: '/repo-a',
      workspaceDirectory: '/workspace',
      workspaceFolders: [
        { name: 'Repo A', path: '/repo-a' },
        { name: 'Repo B', path: '/repo-b' },
      ],
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    cleanup = render(
      () =>
        ChatInput({
          newSession: true,
          onBeforeSend: () => setManualWorkspaceSelection(false),
        }),
      container!
    );
    flushSolid();

    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('button[data-workspace-path="/repo-b"]');
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    setInputTextAndFlush('Stay in Repo B');
    sendMessageMock.mockImplementation(
      (_text, options) =>
        new Promise<boolean>((resolve) => {
          publishOptimisticMessage = options?.onOptimisticPublish;
          resolveSend = resolve;
        })
    );
    await flushAsyncWork();
    flushSolid();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    expect(manualWorkspaceSelection()).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Stay in Repo B',
      expect.objectContaining({
        noReply: false,
        queuedAttachments: expect.any(Object),
        newSessionWorkspace: { scope: 'folder', directory: '/repo-b' },
        onOptimisticPublish: expect.any(Function),
      })
    );

    publishOptimisticMessage?.();
    flushSolid();
    expect(manualWorkspaceSelection()).toBe(false);

    resolveSend?.(true);
    await settle();
  });

  it('restores a failed send before releasing its manual workspace selection', async () => {
    const messages = captureBridgeMessages();
    setManualWorkspaceSelection(true);
    flushSolid();
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-b', '/repo-a'));
    setInputTextAndFlush('Keep this failed prompt in Repo B');
    sendMessageMock.mockResolvedValue(false);
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    clickSelectorAndFlush('[aria-label="Send (Enter)"]');
    await settle();

    expect(inputText()).toBe('Keep this failed prompt in Repo B');
    expect(manualWorkspaceSelection()).toBe(true);
    expect(messages).not.toContainEqual({
      type: 'workspace/select',
      payload: { path: '/repo-a', requestId: expect.any(Number) },
    });
  });

  it('does not switch an established chat to the active file workspace', async () => {
    const messages = captureBridgeMessages();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 100, output: 20 })]);
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a', '/repo-b'));

    renderChatInput();
    await settle();

    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'workspace/select' }));
  });

  it('does not submit a new chat on Enter while a workspace switch is pending', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));
    setInputTextAndFlush('Send after switching');

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    const mainRow = container?.querySelector('.toolbar-main');
    const metaLeftButtons = container?.querySelectorAll<HTMLButtonElement>(
      '.toolbar-meta-left button'
    );
    expect(mainRow?.querySelector('.workspace-picker-button')).toBeNull();
    expect(metaLeftButtons?.[0]?.getAttribute('aria-label')).toContain(
      'Selected workspace filter: Workspace'
    );
    expect(metaLeftButtons?.[0]?.classList.contains('workspace-picker-button')).toBe(true);
    expect(metaLeftButtons?.[1]?.classList.contains('permission-mode-button')).toBe(true);

    clickSelectorAndFlush('.workspace-picker-button');
    expect(container?.querySelector('.chat-input-shell')?.className).toContain(
      'showing-floating-popover'
    );
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(container?.querySelector('.workspace-popover')).toBeNull();

    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('button[data-workspace-path="/repo-b"]');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(true);

    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Send after switching');
  });

  it('keeps a preserved draft disabled until workspace catalogs reload', async () => {
    setStateAndFlush('workspaceCatalogReloadPending', true);
    setInputTextAndFlush('Preserved draft');
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
    ).toBe(true);
    pressComposerEnter();
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Preserved draft');
  });

  it('keeps sending available while a provider refresh waits for active work', async () => {
    setStateAndFlush('providerRefreshPending', true);
    setInputTextAndFlush('Send with the loaded provider configuration');
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(false);
  });

  it('shows queue controls while a provider refresh waits for the active turn', () => {
    setStateAndFlush('providerRefreshPending', true);
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Queue against the loaded provider configuration');

    renderChatInput();

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).not.toBeNull();
  });

  it('keeps the selected model visible while workspace catalogs reload', async () => {
    setupModelState();
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    expect(modelButton?.textContent).toContain('GPT-4o');

    setStateAndFlush('workspaceCatalogReloadPending', true);
    setStateAndFlush('providers', []);
    setStateAndFlush('providerDefaults', {});
    await Promise.resolve();
    flushSolid();

    expect(modelButton?.textContent).toContain('GPT-4o');
    expect(modelButton?.textContent).not.toBe('Model');
    expect(modelButton?.dataset.providerId).toBe('openai');
    expect(modelButton?.dataset.modelId).toBe('gpt-4o');

    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-4o', 'Workspace GPT-4o', { limit: { context: 2_000, output: 1_000 } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-4o' });
    setStateAndFlush('workspaceCatalogReloadPending', false);
    await Promise.resolve();
    flushSolid();

    expect(modelButton?.textContent).toContain('Workspace GPT-4o');
  });

  it.each(['openrouter', 'github-copilot'])(
    'keeps the selected provider visible when only %s offers the same model',
    async (providerID) => {
      setupModelState();
      cleanup = render(() => ChatInput({ newSession: true }), container!);
      flushSolid();
      const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
      const models = { ...state.providers[0]!.models };

      setStateAndFlush('providers', [{ id: providerID, name: providerID, source: 'api', models }]);
      setStateAndFlush('providerDefaults', { [providerID]: 'gpt-4o' });
      await Promise.resolve();
      flushSolid();

      expect(modelButton?.dataset.providerId).toBe('openai');
      expect(modelButton?.dataset.modelId).toBe('gpt-4o');
      expect(modelButton?.textContent).toContain('GPT-4o');
    }
  );

  it('still selects a completion on Enter before queueing a pending-request message', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setStateAndFlush('allAgents', [
      {
        name: 'helper',
        description: 'Help with the task',
        mode: 'subagent',
        builtIn: false,
        permission: [],
      },
    ]);
    setInputTextAndFlush('@hel');

    renderChatInput();
    await settle();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '@hel'.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    flushSolid();
    pressKey(editor, { key: 'Enter' });
    await settle();

    expect(inputText()).toBe('@helper ');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('runs /abort with attachments while a question blocks normal sends', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setStateAndFlush('droppedFiles', [
      { path: '/repo/question.ts', relativePath: 'question.ts', type: 'file' },
    ]);
    setInputTextAndFlush('/abort');

    renderChatInput();
    pressComposerEnter();
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/abort');
    expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo/question.ts' })]);
  });

  it('runs /pause immediately on V2 and parks owned session-tree queues before interrupting', async () => {
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1_000),
      { ...session('child', 1_000), parentID: 'session-1' },
    ]);
    setStateAndFlush('sessionStatus', { 'session-1': { type: 'busy' }, child: { type: 'busy' } });
    setIsLoadingAndFlush(true);
    setStateAndFlush('questions', [{ id: 'question-1', sessionID: 'session-1', questions: [] }]);
    setStateAndFlush('droppedFiles', [{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }]);
    setStateAndFlush('queuedMessages', [
      { id: 'q1', sessionId: 'session-1', text: 'next' },
      { id: 'q2', sessionId: 'child', text: 'child next' },
      { id: 'q3', sessionId: 'session-2', text: 'other session' },
      { id: 'q4', sessionId: 'session-1', text: 'other view', ownerViewId: 'editor-other' },
    ]);
    abortSessionMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      expect(state.queuedMessages.filter((item) => item.paused).map((item) => item.id)).toEqual([
        'q1',
        'q2',
      ]);
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      setIsLoading(false);
    });
    const pausedSession = session('session-1', 1_000);
    const pausedMetadata = {
      varro: { pauses: [{ messageId: 'paused-message', pausedAt: 2_000 }] },
    };
    vi.mocked(client.session.get).mockResolvedValueOnce(pausedSession);
    vi.mocked(client.session.messages).mockResolvedValueOnce([
      {
        info: fixture<AssistantMessage>({
          id: 'paused-message',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1_000 },
        }),
        parts: [],
      },
    ]);
    vi.mocked(client.session.update).mockResolvedValueOnce({
      ...pausedSession,
      metadata: pausedMetadata,
    });
    setInputTextAndFlush('/pause');

    renderChatInput();
    pressComposerEnter();
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(4);
    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo/a.ts' })]);
    expect(client.session.update).toHaveBeenCalledWith(
      'session-1',
      {
        metadata: {
          varro: { pauses: [{ messageId: 'paused-message', pausedAt: expect.any(Number) }] },
        },
      },
      { directory: pausedSession.directory }
    );
    expect(state.sessions.find((entry) => entry.id === 'session-1')?.metadata).toEqual(
      pausedMetadata
    );
  });

  it('keeps /pause and its queue available for retry when interruption fails', async () => {
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('sessionStatus', { 'session-1': { type: 'busy' } });
    setIsLoadingAndFlush(true);
    setStateAndFlush('queuedMessages', [{ id: 'q1', sessionId: 'session-1', text: 'next' }]);
    abortSessionMock.mockRejectedValueOnce(new Error('Connection lost'));
    setInputTextAndFlush('/pause');

    renderChatInput();
    pressComposerEnter();
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(inputText()).toBe('/pause');
    expect(state.queuedMessages[0]?.paused).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(showSessionActionFeedbackMock).not.toHaveBeenCalled();
  });

  it('runs /stop with attachments while a permission blocks normal sends', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1_000)]);
    setStateAndFlush('permissions', [
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
    setStateAndFlush('clipboardImages', [
      {
        id: 'permission-image',
        url: 'data:image/png;base64,permission',
        mime: 'image/png',
        filename: 'permission.png',
        size: 1,
      },
    ]);
    setInputTextAndFlush('/stop');

    renderChatInput();
    pressComposerEnter();
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/stop');
    expect(state.clipboardImages).toEqual([expect.objectContaining({ id: 'permission-image' })]);
  });

  it('runs /abort with attachments while a new-chat workspace switch blocks normal sends', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('editorContext', multiRootEditorContext('/repo-a'));
    setStateAndFlush('droppedFiles', [
      { path: '/repo-a/workspace.ts', relativePath: 'workspace.ts', type: 'file' },
    ]);
    setInputTextAndFlush('/abort');

    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();
    clickSelectorAndFlush('.workspace-picker-button');
    clickSelectorAndFlush('button[data-workspace-path="/repo-b"]');

    pressComposerEnter();
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('/abort');
    expect(state.droppedFiles).toEqual([expect.objectContaining({ path: '/repo-a/workspace.ts' })]);
  });

  it('shows only the stop button while loading with nothing sendable', () => {
    setIsLoadingAndFlush(true);

    renderChatInput();

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();
    expect(container?.querySelector('.stop-button .toolbar-picker-label')).toBeNull();
    expect(container?.textContent).not.toContain('Stop');
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).toBeNull();
  });

  it('handles a rejected direct stop without an unhandled promise', async () => {
    abortSessionMock.mockRejectedValueOnce(new Error('abort failed'));
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    renderChatInput();

    clickSelectorAndFlush('[aria-label="Stop"]');
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stop button through a short idle gap', async () => {
    vi.useFakeTimers();
    setIsLoadingAndFlush(true);

    renderChatInput();

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();

    setIsLoadingAndFlush(false);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(700);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
  });

  it.each([false, true])(
    'shows unfinished subagents after the parent completes (queued messages: %s)',
    async (hasQueue) => {
      vi.useFakeTimers();
      const rootId = 'waiting-root';
      setStateAndFlush('activeSessionId', rootId);
      setStateAndFlush('sessions', [
        session(rootId, 1),
        session('child-1', 2, { parentID: rootId, title: 'Migrate catalog' }),
        session('child-2', 3, { parentID: 'child-1', title: 'Validate protocol' }),
        session('other', 4, { title: 'Unrelated work' }),
      ]);
      setStateAndFlush('sessionStatus', {
        [rootId]: { type: 'busy' },
        'child-1': { type: 'busy' },
        'child-2': { type: 'retry', attempt: 1, message: 'Retrying', next: 100 },
        other: { type: 'busy' },
      });
      const assistant = assistantMessageEntry({ input: 1, output: 1 });
      assistant.info.sessionID = rootId;
      setStateAndFlush('messages', [assistant]);
      if (hasQueue) {
        setStateAndFlush('queuedMessages', [
          { id: 'waiting-queue', sessionId: rootId, text: 'Build and install' },
        ]);
      }
      flushSolid();
      sendMessageMock.mockResolvedValue(true);
      renderChatInput();
      expect(container?.querySelector('.chat-subagent-waiting')).toBeNull();

      setStateAndFlush('messages', [
        {
          ...assistant,
          info: { ...assistant.info, time: { created: 2, completed: 3 }, finish: 'stop' },
        },
      ]);
      setState(storePath('sessionStatus', rootId, { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();

      const waiting = container?.querySelector('.chat-subagent-waiting');
      expect(waiting?.getAttribute('role')).toBe('status');
      expect(waiting?.textContent).toContain('Waiting for 2 subagents');
      expect(waiting?.textContent).toContain('Migrate catalog');
      expect(waiting?.textContent).toContain('Validate protocol');
      expect(waiting?.textContent).not.toContain('Unrelated work');
      expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();
      expect(container?.querySelector('.rich-composer')?.getAttribute('data-placeholder')).toBe(
        'Queue a follow-up or steer'
      );
      expect(sendMessageMock).not.toHaveBeenCalled();

      setState(storePath('sessionStatus', 'child-1', { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(300);
      flushSolid();
      expect(waiting?.textContent).toContain('Waiting for 1 subagent');
      expect(waiting?.textContent).not.toContain('Migrate catalog');
      expect(waiting?.textContent).toContain('Validate protocol');
      expect(sendMessageMock).not.toHaveBeenCalled();

      setState(storePath('sessionStatus', 'child-2', { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      expect(container?.querySelector('.chat-subagent-waiting')).toBeNull();
      expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
      expect(sendMessageMock).toHaveBeenCalledTimes(hasQueue ? 1 : 0);
      expect(state.queuedMessages).toEqual([]);
    }
  );

  it('scopes the subagent waiting status to the composer session', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 1),
      session('child-1', 2, { parentID: 'session-1', title: 'Background task' }),
      session('session-2', 3),
    ]);
    setStateAndFlush('sessionStatus', {
      'session-1': { type: 'idle' },
      'child-1': { type: 'busy' },
      'session-2': { type: 'idle' },
    });
    renderChatInput();
    expect(container?.querySelector('.chat-subagent-waiting')?.textContent).toContain(
      'Background task'
    );

    setStateAndFlush('activeSessionId', 'session-2');
    await settle();
    expect(container?.querySelector('.chat-subagent-waiting')).toBeNull();

    setStateAndFlush('activeSessionId', 'session-1');
    cleanup!();
    flushSolid();
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();
    expect(container?.querySelector('.chat-subagent-waiting')).toBeNull();
    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
  });

  it('hides stale busy controls for a terminal response but keeps them for a continuation', () => {
    const terminalAssistant: AssistantMessage = {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      parentID: 'user-1',
      time: { created: 2, completed: 3 },
      modelID: 'gpt-5',
      providerID: 'openai',
      mode: 'build',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop',
    };
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [
      historyEntry('user-1', 'Prompt'),
      { info: terminalAssistant, parts: [] },
    ]);
    setStateAndFlush('sessionStatus', { 'session-1': { type: 'busy' } });

    renderChatInput();

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).not.toBeNull();

    setStateAndFlush('messages', [
      historyEntry('user-1', 'Prompt'),
      { info: { ...terminalAssistant, finish: 'tool_calls' }, parts: [] },
    ]);

    expect(container?.querySelector('[aria-label="Stop"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).toBeNull();
  });

  it('shows send controls instead of stop while loading with sendable content', () => {
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Follow up');

    renderChatInput();

    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).not.toBeNull();
  });

  it('captures the displayed queued model when a session snapshot still names the previous model', async () => {
    setupLoadingActiveTurn();
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-4o' },
      { sessionId: 'session-1', persistGlobal: false }
    );
    flushSolid();
    setState(
      storePath('providers', 0, 'models', 'other', {
        id: 'other',
        name: 'Other model',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
      })
    );
    flushSolid();
    const displayedModel = { providerID: 'openai', modelID: 'other' };
    setStateAndFlush('selectedModel', displayedModel);
    setInputTextAndFlush('Keep the displayed model');
    renderChatInput();
    expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Other model');

    container
      ?.querySelector('.rich-composer')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await settle();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]?.queuedContext?.editorContext.queuedModel?.selection).toEqual(
      displayedModel
    );
  });

  it.each(['agent', 'model', 'reasoning'])(
    'queues instead of steering after changing %s during a turn',
    async (changed) => {
      setupLoadingActiveTurn();
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      setState(storePath('providers', 0, 'models', 'gpt-4o', 'variants', { high: {}, xhigh: {} }));
      flushSolid();
      setState(
        storePath('providers', 0, 'models', 'other', {
          id: 'other',
          name: 'Other model',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: { high: {}, xhigh: {} },
        })
      );
      flushSolid();
      const model = {
        providerID: 'openai',
        modelID: changed === 'model' ? 'other' : 'gpt-4o',
        variant: changed === 'reasoning' ? 'high' : undefined,
      };
      const agent = changed === 'agent' ? 'plan' : 'build';
      setSelectedModel({ ...model }, { sessionId: 'session-1', persistGlobal: false });
      flushSolid();
      setStateAndFlush('selectedAgent', agent);
      setInputTextAndFlush('Different settings');
      renderChatInput();
      expect(container?.querySelector<HTMLButtonElement>('.model-picker-btn')?.disabled).toBe(
        false
      );
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Thinking level"]')?.disabled
      ).toBe(false);
      container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')?.click();
      flushSolid();
      const menuAction = (label: string) =>
        [...container!.querySelectorAll<HTMLButtonElement>('.busy-menu button')].find((button) =>
          button.textContent?.includes(label)
        );
      expect(menuAction('Steer')?.disabled).toBe(true);
      expect(menuAction('Stop and Send')?.disabled).toBe(true);
      menuAction('Stop and Send')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      flushSolid();
      expect(abortSessionMock).not.toHaveBeenCalled();
      container
        ?.querySelector('.rich-composer')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
        );
      await settle();
      expect(sendMessageMock).not.toHaveBeenCalled();
      const queued = state.queuedMessages[0]!;
      expect(queued.agent).toBe(agent);
      expect(queued.queuedContext?.editorContext.queuedModel?.selection).toEqual(model);
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
      ).toBe(true);
      await sendQueuedAsSteer(queued);
      flushSolid();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(state.queuedMessages).toHaveLength(1);

      // Changing the composer back must not change the queued message's settings.
      setSelectedModel(
        { providerID: 'openai', modelID: 'gpt-4o' },
        { sessionId: 'session-1', persistGlobal: false }
      );
      flushSolid();
      setStateAndFlush('selectedAgent', 'build');
      setInputTextAndFlush('Matching settings');
      if (!menuAction('Steer'))
        container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')?.click();
      flushSolid();
      expect(menuAction('Steer')?.disabled).toBe(false);
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
      ).toBe(true);

      // A later active turn with the queued settings makes that row steerable.
      const entry = historyEntry('next-active-user', 'New turn');
      setStateAndFlush('messages', [{ ...entry, info: { ...entry.info, agent, model } }]);
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.disabled
      ).toBe(false);
      container?.querySelector<HTMLButtonElement>('[aria-label="Send as Steer"]')?.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledWith(
        'Different settings',
        expect.objectContaining({ delivery: 'steer', agent, selectedModel: model })
      );
      expect(state.queuedMessages).toEqual([]);
    }
  );

  it('queues and dispatches the sent model despite a delayed previous-turn model snapshot', async () => {
    setupMatchingActiveTurn();
    setStateAndFlush('activeSessionId', 'session-1');
    setState(
      storePath('providers', 0, 'models', 'other', {
        id: 'other',
        name: 'Other model',
        capabilities: { toolcall: true },
        cost: { input: 0, output: 0 },
        variants: { high: {} },
      })
    );
    flushSolid();
    const previous = { providerID: 'openai', modelID: 'gpt-4o' };
    const selected = { providerID: 'openai', modelID: 'other', variant: 'high' };
    setSelectedModel(
      { ...selected },
      {
        sessionId: 'session-1',
        persistGlobal: false,
        selectionId: 'idle-choice',
      }
    );
    flushSolid();
    applySessionSelectedModelsSnapshot(
      { 'session-1': { ...selected } },
      { sessionId: 'session-1', selectionId: 'idle-choice' }
    );
    flushSolid();
    setIsLoadingAndFlush(true);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    // SessionSendOperations protects the actual sent model at optimistic publication.
    setSelectedModel(
      { ...selected },
      {
        sessionId: 'session-1',
        persistGlobal: false,
        protectDuringTurn: true,
      }
    );
    flushSolid();
    renderChatInput();
    applySessionSelectedModelsSnapshot({ 'session-1': { ...previous } });
    flushSolid();
    expect(container?.querySelector('.model-picker-btn')?.textContent).toContain('Other model');
    setInputTextAndFlush('Keep the first queued model');
    pressComposerEnter();
    await settle();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toHaveLength(1);
    const queued = state.queuedMessages[0]!;
    expect(queued.queuedContext?.editorContext.queuedModel?.selection).toEqual(selected);

    // Later composer changes and persistence delivery must not change enqueue-time intent.
    setSelectedModel(
      { ...previous },
      {
        sessionId: 'session-1',
        persistGlobal: false,
        selectionId: 'later-choice',
      }
    );
    flushSolid();
    await sendQueuedAsSteer(queued);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();
    setIsLoadingAndFlush(false);
    for (const handler of serverEventHandlers.get('session.status') ?? []) {
      handler({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      });
    }
    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Keep the first queued model',
      expect.objectContaining({ selectedModel: selected, targetSessionId: 'session-1' })
    );
    expect(state.queuedMessages).toEqual([]);
    applySessionSelectedModelsSnapshot(
      { 'session-1': { ...previous } },
      { sessionId: 'session-1', selectionId: 'later-choice' }
    );
    flushSolid();
  });

  it.each(['model', 'reasoning'])(
    'keeps a changed %s dropdown and warning through active-turn snapshots',
    async (changed) => {
      setupLoadingActiveTurn();
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      setState(storePath('providers', 0, 'models', 'gpt-4o', 'variants', { high: {}, xhigh: {} }));
      flushSolid();
      setState(
        storePath('providers', 0, 'models', 'other', {
          id: 'other',
          name: 'Other model',
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
        })
      );
      flushSolid();
      const running = { providerID: 'openai', modelID: 'gpt-4o' };
      setSelectedModel({ ...running }, { sessionId: 'session-1', persistGlobal: false });
      flushSolid();
      const sendToExtension = vi.fn(defaultBridgeSend);
      fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
        sendToExtension;
      renderChatInput();
      expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();
      if (changed === 'model') {
        container?.querySelector<HTMLButtonElement>('.model-picker-btn')?.click();
        flushSolid();
        await vi.waitFor(() =>
          expect(
            container?.querySelector('.model-picker-item[data-model-id="other"]')
          ).not.toBeNull()
        );
        flushSolid();
        container
          ?.querySelector<HTMLButtonElement>('.model-picker-item[data-model-id="other"]')
          ?.click();
        flushSolid();
      } else {
        container?.querySelector<HTMLButtonElement>('[aria-label="Thinking level"]')?.click();
        flushSolid();
        const high = [
          ...container!.querySelectorAll<HTMLButtonElement>('.variant-popover button'),
        ].find((button) => button.textContent?.trim() === 'High');
        expect(high).toBeDefined();
        high?.click();
        flushSolid();
      }
      flushSolid();
      const selected =
        changed === 'model'
          ? { providerID: 'openai', modelID: 'other' }
          : { ...running, variant: 'high' };
      expect(state.selectedModel).toEqual(selected);
      expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
      const update = sendToExtension.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'session-model/update');
      expect(update?.payload.selectionId).toBeTypeOf('string');
      applySessionSelectedModelsSnapshot(
        { 'session-1': selected },
        { sessionId: 'session-1', selectionId: update!.payload.selectionId! }
      );
      flushSolid();
      applySessionSelectedModelsSnapshot({ 'session-1': running });
      flushSolid();
      setSelectedModel({ ...running }, { sessionId: 'session-1', persistGlobal: false });
      flushSolid();
      expect(state.selectedModel).toEqual(selected);
      expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
      expect(container?.querySelector('.model-picker-btn')?.textContent).toContain(
        changed === 'model' ? 'Other model' : 'GPT-4o'
      );
      if (changed === 'reasoning')
        expect(container?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain(
          'High'
        );
      setIsLoadingAndFlush(false);
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      applySessionSelectedModelsSnapshot({ 'session-1': selected });
      flushSolid();
    }
  );

  it('sends busy composer input as a steer on modifier enter', async () => {
    setupLoadingActiveTurn();
    setInputTextAndFlush('Change direction');

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('Change direction', { delivery: 'steer' });
    expect(state.queuedMessages).toEqual([]);
  });

  it('stops the active response before sending from the busy send menu', async () => {
    setupLoadingActiveTurn();
    setInputTextAndFlush('Follow up after stopping');

    renderChatInput();

    const menuButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="More send options"]'
    );
    menuButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    const stopAndSendButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Stop and Send')
    );
    stopAndSendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('Follow up after stopping', { noReply: false });
    expect(state.queuedMessages).toEqual([]);
  });

  it('does not send from the busy menu when stopping fails', async () => {
    setupMatchingActiveTurn();
    abortSessionMock.mockRejectedValueOnce(new Error('abort failed'));
    setIsLoadingAndFlush(true);
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Do not send after a failed stop');

    renderChatInput();

    clickSelectorAndFlush('[aria-label="More send options"]');
    const stopAndSendButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Stop and Send')
    );
    stopAndSendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(abortSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('Do not send after a failed stop');
  });

  it.each([
    ['@explore Why?', 'subagents'],
    ['$[docs] Why?', 'skills'],
    ['/test example', 'commands'],
    ['session:ses_other Why?', 'other conversations'],
  ])('disables side-question sends for incompatible inline content %s', async (prompt, reason) => {
    setupMatchingActiveTurn();
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
    setStateAndFlush('allAgents', [fixture<Agent>({ name: 'explore' })]);
    setIsLoadingAndFlush(true);
    setInputTextAndFlush(`/btw ${prompt}`);
    renderChatInput();
    expect(
      container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
    ).toBe(true);
    pressComposerEnter();
    await settle();
    expect(sideQuestionView()).toBeNull();
    expect(inputText()).toBe(`/btw ${prompt}`);
    setInputText(prompt);
    await settle();
    container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')!.click();
    flushSolid();
    const action = [...container!.querySelectorAll<HTMLButtonElement>('.busy-menu button')].find(
      (button) => button.textContent?.trim() === 'Side question'
    );
    expect(action?.disabled).toBe(true);
    expect(action?.title).toContain(reason);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(abortSessionMock).not.toHaveBeenCalled();
    expect(state.queuedMessages).toEqual([]);
  });

  it('asks the plain draft from the busy menu without stopping, queueing, steering, or consuming attachments', async () => {
    setupMatchingActiveTurn();
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    setIsLoadingAndFlush(true);
    setStateAndFlush('droppedFiles', [
      { path: '/repo/keep.ts', relativePath: 'keep.ts', type: 'file' },
    ]);
    addClipboardImage({
      id: 'busy-side-image',
      filename: 'Image 1',
      mime: 'image/png',
      url: 'data:image/png;base64,aW1hZ2U=',
      size: 5,
    });
    flushSolid();
    setInputTextAndFlush('Why did that fail?\nKeep it short.');
    renderChatInput();
    container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')!.click();
    flushSolid();
    const labels = [...container!.querySelectorAll('.busy-menu-label')];
    expect(labels.map((label) => label.textContent)).toEqual([
      'Queue',
      'Steer',
      'Side question',
      'Stop and Send',
    ]);
    labels[2]!.closest('button')!.click();
    await settle();
    expect(sideQuestionView()).toMatchObject({
      sessionID: 'session-1',
      question: 'Why did that fail?\nKeep it short.',
    });
    expect(inputText()).toBe('');
    expect(container?.querySelector('.busy-menu')).toBeNull();
    expect(state.droppedFiles).toHaveLength(1);
    expect(state.clipboardImages).toHaveLength(1);
    expect(sideQuestionView()?.context).not.toContain('data:image');
    expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    expect(state.queuedMessages).toEqual([]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(abortSessionMock).not.toHaveBeenCalled();
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
  });

  it('does not offer a busy-menu side question on OpenCode V1', async () => {
    setupMatchingActiveTurn();
    setStateAndFlush('serverStatus', {
      state: 'running',
      url: 'http://localhost:4096',
      apiVersion: 1,
    });
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
    setIsLoadingAndFlush(true);
    setInputTextAndFlush('Ordinary follow-up');
    renderChatInput();
    container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')!.click();
    await settle();
    expect(
      [...container!.querySelectorAll('.busy-menu-label')].map((label) => label.textContent)
    ).toEqual(['Queue', 'Steer', 'Stop and Send']);
    expect(inputText()).toBe('Ordinary follow-up');
    expect(sideQuestionView()).toBeNull();
  });

  it.each(
    ['strip', 'inline'].flatMap((placement) =>
      ['send', 'enter'].map((action) => ({ placement, action }))
    )
  )(
    'excludes a $placement image from /btw using $action and keeps it for the next regular send',
    async ({ placement, action }) => {
      setupModelState();
      setState(storePath('providers', 0, 'models', 'gpt-4o', 'capabilities', 'vision', true));
      flushSolid();
      setStateAndFlush('serverStatus', runningV2Server());
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
      const image = {
        id: 'side-image',
        filename: 'Image 1',
        mime: 'image/png',
        url: 'data:image/png;base64,aW1hZ2U=',
        size: 5,
      };
      addClipboardImage(image);
      flushSolid();
      const attachedImage = { ...state.clipboardImages[0]! };
      const prompt = placement === 'inline' ? '[Image 1] Why?' : 'Why?';
      setInputTextAndFlush(prompt);
      renderChatInput();
      await settle();
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      const imageChip = () =>
        container!.querySelector<HTMLElement>(
          placement === 'inline' ? '[data-chip-type="image"]' : '.chat-attachment-chip'
        )!;
      expect(imageChip().classList.contains('disabled')).toBe(false);
      enterComposerText(editor, `/btw ${prompt}`);
      await flushAsyncWork();
      flushSolid();
      expect(imageChip().classList.contains('disabled')).toBe(true);
      expect(imageChip().title).toBe(
        'Images are not included in side questions. Kept attached for your next regular message.'
      );
      enterComposerText(editor, prompt);
      await flushAsyncWork();
      flushSolid();
      expect(imageChip().classList.contains('disabled')).toBe(false);
      enterComposerText(editor, `/btw ${prompt}`);
      await flushAsyncWork();
      flushSolid();
      const send = container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!;
      expect(send.disabled).toBe(false);
      if (action === 'send') send.click();
      else
        container!
          .querySelector('.rich-composer')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          );
      await settle();

      expect(sideQuestionView()).toMatchObject({ sessionID: 'session-1', question: 'Why?' });
      expect(sideQuestionView()?.context ?? '').toBe('');
      expect(state.clipboardImages).toEqual([attachedImage]);
      expect(inputText()).toBe('');
      expect(container!.querySelector('.chat-attachment-chip.disabled')).toBeNull();
      expect(container!.querySelector('.chat-attachment-chip')?.textContent).toContain('Image 1');
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      expect(state.queuedMessages).toEqual([]);

      closeSideQuestion();
      flushSolid();
      setInputTextAndFlush('Now inspect the image');
      const sentImages: (typeof image)[] = [];
      sendMessageMock.mockImplementationOnce(async () => {
        sentImages.push(...state.clipboardImages);
        return true;
      });
      container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0]?.[0]).toBe('Now inspect the image');
      expect(sentImages).toEqual([attachedImage]);
    }
  );

  it.each(['/b', '/bt'])(
    'opens the /btw suggestion from %s without treating the draft as a command',
    async (draft) => {
      setStateAndFlush('serverStatus', runningV2Server());
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
      setInputTextAndFlush(draft);
      renderChatInput();
      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, draft.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 't', bubbles: true }));
      await settle();
      const suggestion = [
        ...container!.querySelectorAll<HTMLElement>('.composer-completion-item'),
      ].find((option) => option.textContent?.includes('/btw'));
      expect(suggestion).toBeDefined();
      suggestion!.click();
      await settle();
      expect(sideQuestionView()).toBeNull();
      expect(inputText()).toBe('/btw');

      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(sideQuestionView()).toMatchObject({ sessionID: 'session-1', question: '' });
      expect(inputText()).toBe('');
      expect(state.queuedMessages).toEqual([]);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(abortSessionMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    }
  );

  it('opens /btw without sending or consuming existing attachments', async () => {
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
    setStateAndFlush('droppedFiles', [
      { path: '/repo/keep.ts', relativePath: 'keep.ts', type: 'file' },
    ]);
    setInputTextAndFlush('/btw Why did that fail?');
    renderChatInput();
    pressComposerEnter();
    await settle();
    expect(sideQuestionView()).toMatchObject({
      sessionID: 'session-1',
      question: 'Why did that fail?',
    });
    expect(inputText()).toBe('');
    expect(state.droppedFiles).toHaveLength(1);
    expect(state.queuedMessages).toEqual([]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)(
    'handles /btw in a moved session without sending chat or a custom command on API %s',
    async (apiVersion) => {
      setStateAndFlush('serverStatus', {
        state: 'running',
        url: 'http://localhost:4096',
        apiVersion,
      });
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [
        session('session-1', 1, {
          transfer: { originDirectory: '/other', available: false },
        }),
      ]);
      setStateAndFlush('commands', [{ name: 'btw', template: 'Must not execute' }]);
      setInputTextAndFlush('/btw Why?');
      renderChatInput();
      pressComposerEnter();
      await settle();
      if (apiVersion === 2) {
        expect(sideQuestionView()).toMatchObject({ sessionID: 'session-1', question: 'Why?' });
        expect(inputText()).toBe('');
      } else {
        expect(sideQuestionView()).toBeNull();
        expect(inputText()).toBe('/btw Why?');
      }
      expect(state.queuedMessages).toEqual([]);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    }
  );

  it.each(['send', 'enter', 'ctrl-enter', 'meta-enter'] as const)(
    'asks /btw during active work using %s without queueing, steering, or stopping',
    async (action) => {
      setupMatchingActiveTurn();
      setStateAndFlush('serverStatus', runningV2Server());
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      setIsLoadingAndFlush(true);
      setStateAndFlush('droppedFiles', [
        { path: '/repo/keep.ts', relativePath: 'keep.ts', type: 'file' },
      ]);
      setInputTextAndFlush('/btw How is it going?\nKeep it short.');
      renderChatInput();
      expect(container?.querySelector('[aria-label="More send options"]')).toBeNull();
      expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).toBeNull();
      expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
      const send = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
      expect(send?.disabled).toBe(false);
      if (action === 'send') send!.click();
      else
        container?.querySelector('.rich-composer')?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            ctrlKey: action === 'ctrl-enter',
            metaKey: action === 'meta-enter',
          })
        );
      await settle();
      expect(sideQuestionView()).toMatchObject({
        sessionID: 'session-1',
        question: 'How is it going?\nKeep it short.',
      });
      expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
      expect(state.queuedMessages).toEqual([]);
      expect(state.droppedFiles).toHaveLength(1);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(abortSessionMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
      expect(showSessionActionFeedbackMock).not.toHaveBeenCalled();
    }
  );

  it('closes the busy-send menu when the draft becomes /btw and restores ordinary queue controls afterward', async () => {
    setupMatchingActiveTurn();
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1, { directory: '/repo' })]);
    setIsLoadingAndFlush(true);
    setInputTextAndFlush('Ordinary follow-up');
    renderChatInput();
    container?.querySelector<HTMLButtonElement>('[aria-label="More send options"]')!.click();
    flushSolid();
    expect(container?.querySelector('.busy-menu')).not.toBeNull();
    setInputText('/btw How is it going?');
    await settle();
    expect(container?.querySelector('.busy-menu')).toBeNull();
    expect(container?.querySelector('[aria-label="More send options"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Send (Enter)"]')).not.toBeNull();
    setInputText('Ordinary follow-up');
    await settle();
    expect(container?.querySelector('[aria-label="Add to queue (Enter)"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="More send options"]')).not.toBeNull();
  });

  it('does not ask about a previously selected conversation from the new-chat composer', async () => {
    setStateAndFlush('serverStatus', runningV2Server());
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 1)]);
    setInputTextAndFlush('/btw Why?');
    cleanup = render(() => ChatInput({ newSession: true }), container!);
    flushSolid();
    pressComposerEnter();
    await settle();
    expect(sideQuestionView()).toBeNull();
    expect(inputText()).toBe('/btw Why?');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('runs a typed slash command with args on Enter', async () => {
    setStateAndFlush('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputTextAndFlush('/test --watch');

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it.each([
    ['/mcp', 'enter', false],
    ['/mcps', 'send', false],
    ['/mcps at', 'enter', true],
    ['/mcp at', 'send', true],
  ] as const)(
    'opens %s with %s while busy=%s without sending attachments',
    async (draft, action, busy) => {
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('sessions', [session('session-1', 1)]);
      setState(storePath('sessionStatus', 'session-1', { type: busy ? 'busy' : 'idle' }));
      flushSolid();
      setIsLoading(busy);
      flushSolid();
      setStateAndFlush('mcpStatus', {
        atlassian: { status: 'needs_auth', error: 'Login required' },
        'browser-bridge': { status: 'disabled' },
      });
      setStateAndFlush('droppedFiles', [
        { path: '/repo/keep.ts', relativePath: 'keep.ts', type: 'file' },
      ]);
      setInputTextAndFlush(draft);
      renderChatInput();
      if (action === 'enter') {
        pressComposerEnter();
        flushSolid();
      } else {
        const send = container!.querySelector<HTMLButtonElement>(
          '[aria-label="Send (Enter)"], [aria-label="Add to queue (Enter)"]'
        );
        expect(send).not.toBeNull();
        send!.click();
        flushSolid();
      }
      await settle();
      expect(container?.querySelector('.dropdown-header')?.textContent).toBe('MCPs');
      expect(container?.querySelector('.dropdown-menu')?.textContent).toContain('atlassian');
      if (draft.endsWith(' at')) {
        expect(
          container?.querySelector<HTMLInputElement>('[aria-label="Search MCPs"]')?.value
        ).toBe('at');
        expect(container?.querySelector('.dropdown-menu')?.textContent).not.toContain(
          'browser-bridge'
        );
      }
      expect(inputText()).toBe('');
      expect(state.droppedFiles).toHaveLength(1);
      expect(state.queuedMessages).toEqual([]);
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    }
  );

  it('runs a typed slash command with args from the send button', async () => {
    setStateAndFlush('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    setInputTextAndFlush('/test --watch');

    renderChatInput();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(runSlashCommandByNameMock).toHaveBeenCalledWith('test', '--watch');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('opens the Varro provider connection UI with the connect slash command', async () => {
    setInputTextAndFlush('/connect');

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(providerConnectionRequest()?.providerID).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('shows a Problems count chip with an independent keyboard-accessible context toggle', async () => {
    setStateAndFlush('issuesEnabled', true);
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/app.ts', relativePath: 'app.ts', language: 'typescript' },
      selection: null,
      diagnostics: [
        {
          path: '/repo/app.ts',
          line: 1,
          severity: 'error',
          message: 'Private diagnostic detail',
        },
      ],
      diagnosticCounts: { errors: 1, warnings: 2 },
    });
    renderChatInput();
    const problemChip = () =>
      Array.from(
        container!.querySelectorAll<HTMLElement>(
          '.chat-attachments-container .chat-attachment-chip'
        )
      ).find((chip) => chip.querySelector('.chip-label')?.textContent === 'Problems')!;
    expect(problemChip().querySelector('.chip-detail')?.textContent).toBe('3');
    expect(problemChip().textContent).not.toContain('·');
    expect(problemChip().getAttribute('aria-pressed')).toBe('true');
    const currentDocumentEnabled = state.currentDocumentEnabled;
    problemChip().click();
    await settle();
    expect(state.issuesEnabled).toBe(false);
    expect(state.currentDocumentEnabled).toBe(currentDocumentEnabled);
    expect(problemChip().getAttribute('aria-pressed')).toBe('false');
    expect(problemChip().classList.contains('disabled')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('varro.projectIssuesEnabled') || '{}')).toEqual({
      '/repo': false,
    });
    problemChip().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(state.issuesEnabled).toBe(true);
    expect(problemChip().getAttribute('aria-pressed')).toBe('true');
    expect(container?.querySelector('.rich-composer')?.textContent).not.toContain(
      'Private diagnostic detail'
    );
    setStateAndFlush('autoAttachProblems', false);
    await settle();
    expect(problemChip()).toBeUndefined();
    expect(state.issuesEnabled).toBe(true);
    setStateAndFlush('autoAttachProblems', true);
    await settle();
    expect(problemChip().getAttribute('aria-pressed')).toBe('true');
  });

  it('hides automatic file chips without hiding explicitly attached files', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/app.ts', relativePath: 'app.ts', language: 'typescript' },
      selection: null,
      diagnostics: [],
    });
    renderChatInput();
    const attachmentText = () =>
      container!.querySelector('.chat-attachments-container')?.textContent ?? '';
    expect(attachmentText()).toContain('app.ts');
    setStateAndFlush('autoAttachActiveFile', false);
    await settle();
    expect(attachmentText()).not.toContain('app.ts');
    setStateAndFlush('droppedFiles', [
      { path: '/repo/app.ts', relativePath: 'app.ts', type: 'file' },
    ]);
    await settle();
    expect(attachmentText()).toContain('app.ts');
  });

  it('accumulates bulb-menu problems as attachments without changing the draft', async () => {
    setInputTextAndFlush('Explain this');
    renderChatInput();
    const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
    editor.focus();
    flushSolid();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    flushSolid();
    window.getSelection()!.addRange(range);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
    flushSolid();
    const diagnostics = [
      { path: '/repo/a.ts', line: 2, severity: 'error', message: 'Selected problem' },
    ];
    const message = { type: 'command/attach-problems', payload: { diagnostics } };
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    await settle();
    expect(inputText()).toBe('Explain this');
    expect(state.attachedDiagnostics).toEqual({ diagnostics, total: 1, inline: false });
    expect(container!.querySelectorAll('[data-chip-type="mention-problems"]')).toHaveLength(0);
    expect(container!.querySelector('.chat-attachments-container')?.textContent).toContain(
      'Problems'
    );
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    await settle();
    expect(state.attachedDiagnostics?.total).toBe(1);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'command/attach-problems',
          payload: {
            diagnostics: [
              { path: '/repo/b.ts', line: 3, severity: 'warning', message: 'Another problem' },
            ],
          },
        },
      })
    );
    await settle();
    expect(state.attachedDiagnostics?.total).toBe(2);
    expect(inputText()).toBe('Explain this');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('opens /problems and attaches All without replacing automatic editor context', async () => {
    const snapshot = {
      total: 2,
      diagnostics: [
        { path: '/repo/a.ts', line: 1, severity: 'error' as const, message: 'A error' },
        { path: '/repo/b.ts', line: 2, severity: 'warning' as const, message: 'B warning' },
      ],
    };
    vi.mocked(client.varro.workspaceProblems).mockResolvedValue(snapshot);
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: { path: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' },
      selection: null,
      diagnostics: [snapshot.diagnostics[0]!],
      diagnosticCounts: { errors: 1, warnings: 0 },
    });
    setInputTextAndFlush('/problems');
    renderChatInput();
    const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
    editor.focus();
    await settle();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(inputText()).toBe('/problems ');
    const completion = container!.querySelector<HTMLButtonElement>('.completion-problems');
    expect(completion?.textContent).toContain('All');
    expect(container!.querySelectorAll('.completion-problems')).toHaveLength(3);
    completion!.click();
    await settle();
    expect(client.varro.workspaceProblems).toHaveBeenCalledOnce();
    expect(state.attachedDiagnostics).toBeNull();
    expect(state.inlineProblems).toHaveLength(1);
    expect(state.inlineProblems[0]?.group).toEqual(snapshot.diagnostics);
    expect(state.editorContext.diagnostics).toEqual([snapshot.diagnostics[0]]);
    const problemChips = container!.querySelectorAll<HTMLElement>(
      '[data-chip-type="mention-problems"]'
    );
    expect(problemChips).toHaveLength(1);
    expect(problemChips[0]?.querySelector('.inline-chip-label')?.textContent).toBe('Problems');
    expect(problemChips[0]?.querySelector('.inline-chip-detail')?.textContent).toBe('2');
    expect(problemChips[0]?.closest('.rich-composer')).toBe(editor);
    flushSolid();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it.each(['empty', 'loading'] as const)(
    'dismisses an %s Problems menu on Escape without leaving the composer',
    async (status) => {
      if (status === 'empty') {
        vi.mocked(client.varro.workspaceProblems).mockResolvedValue({ total: 0, diagnostics: [] });
      } else {
        vi.mocked(client.varro.workspaceProblems).mockImplementationOnce(
          () => new Promise(() => undefined)
        );
      }
      setInputTextAndFlush('Review /problems');
      renderChatInput();
      const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
      editor.focus();
      flushSolid();
      setCollapsedSelection(editor.firstChild!, 'Review /problems'.length);
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
      flushSolid();
      await flushAsyncWork();
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(inputText()).toBe('Review /problems ');
      expect(container!.querySelector('.composer-completion-menu')).not.toBeNull();
      expect(container!.querySelectorAll('.completion-problems')).toHaveLength(0);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(escape);
      flushSolid();
      expect(escape.defaultPrevented).toBe(true);
      expect(container!.querySelector('.composer-completion-menu')).toBeNull();
      expect(document.activeElement).toBe(editor);
      expect(inputText()).toBe('Review /problems ');
      expect(sendMessageMock).not.toHaveBeenCalled();
    }
  );

  it('ignores a workspace problem response after switching sessions', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof client.varro.workspaceProblems>>) => void;
    vi.mocked(client.varro.workspaceProblems).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    setInputTextAndFlush('/problems ');
    renderChatInput();
    container!.querySelector<HTMLElement>('.rich-composer')!.focus();
    await settle();
    setInputTextAndFlush('A different draft');
    setStateAndFlush('activeSessionId', 'other-session');
    resolve({
      total: 1,
      diagnostics: [{ path: '/repo/a.ts', line: 1, severity: 'error', message: 'Stale' }],
    });
    await settle();
    expect(state.attachedDiagnostics).toBeNull();
  });

  it('requests workspace problems again for a new draft in the changed picker scope', async () => {
    vi.mocked(client.varro.workspaceProblems).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    setInputTextAndFlush('/problems');
    renderChatInput();
    const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
    editor.focus();
    await settle();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.varro.workspaceProblems).toHaveBeenCalledOnce();

    setState(storePath('editorContext', 'workspacePath', '/other-repo'));
    flushSolid();
    expect(inputText()).toBe('');
    enterComposerText(editor, '/problems');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(client.varro.workspaceProblems).toHaveBeenCalledTimes(2);
  });

  it('attaches an individual problem without sending the command text', async () => {
    const diagnostics = [
      { path: '/repo/a.ts', line: 1, severity: 'error' as const, message: 'First error' },
      { path: '/repo/b.ts', line: 2, severity: 'warning' as const, message: 'Second warning' },
    ];
    vi.mocked(client.varro.workspaceProblems).mockResolvedValue({ total: 2, diagnostics });
    setInputTextAndFlush('Explain /problems ');
    renderChatInput();
    container!.querySelector<HTMLElement>('.rich-composer')!.focus();
    await settle();
    const choices = container!.querySelectorAll<HTMLButtonElement>('.completion-problems');
    expect(choices).toHaveLength(3);
    choices[2]!.click();
    await settle();
    expect(state.attachedDiagnostics).toBeNull();
    expect(state.inlineProblems).toHaveLength(1);
    expect(state.inlineProblems[0]?.diagnostic).toEqual(diagnostics[1]);
    expect(inputText()).toMatch(/^Explain \[Problem [\w-]+\] $/);
    expect(sendMessageMock).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'command/attach-problems', payload: { diagnostics: [diagnostics[0]] } },
      })
    );
    await settle();
    const chip = container!.querySelector<HTMLElement>('[data-chip-type="mention-problems"]')!;
    const range = document.createRange();
    range.setStartAfter(chip);
    flushSolid();
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    flushSolid();
    window.getSelection()!.addRange(range);
    flushSolid();
    const editor = container!.querySelector<HTMLElement>('.rich-composer')!;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    await settle();
    expect(state.attachedDiagnostics?.diagnostics).toEqual([diagnostics[0]]);
    expect(inputText()).not.toContain('[Problem ');
    expect(state.inlineProblems).toHaveLength(0);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await settle();
    expect(state.inlineProblems).toHaveLength(1);
    expect(container!.querySelector('[data-chip-type="mention-problems"]')).not.toBeNull();
    expect(state.attachedDiagnostics?.diagnostics).toEqual([diagnostics[0]]);
  });

  it('attaches active-file diagnostics with the diagnostics slash command', async () => {
    setStateAndFlush('editorContext', {
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
    setInputTextAndFlush('/diagnostics');

    renderChatInput();

    pressComposerEnter();
    await settle();

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
    setInputTextAndFlush('/diagnostics');

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith('No issues found');
    expect(state.attachedDiagnostics).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs the built-in undo slash command on Enter', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 0, output: 0 })]);
    setInputTextAndFlush('/undo');

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs the built-in fork slash command on Enter', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('/fork');

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(forkSessionMock).toHaveBeenCalledWith('session-1');
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('sends slash-prefixed text on Enter when it is not a known slash command', async () => {
    setInputTextAndFlush("/not-a-real-command and /redo commands doesn't work");
    runSlashCommandByNameMock.mockResolvedValue(false);

    renderChatInput();

    pressComposerEnter();
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith(
      "/not-a-real-command and /redo commands doesn't work",
      expect.objectContaining({ noReply: false })
    );
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
  });

  it('runs the built-in undo slash command from the send button', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [assistantMessageEntry({ input: 0, output: 0 })]);
    setInputTextAndFlush('/undo');

    renderChatInput();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(runSlashCommandByNameMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs undo from the send button even when the suggestion list omits it', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('/undo');

    renderChatInput();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(undoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('runs redo from the send button even when the suggestion list omits it', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('/redo');

    renderChatInput();

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(redoSessionMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(inputText()).toBe('');
  });

  it('uses a contenteditable rich composer instead of textarea', async () => {
    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('contenteditable')).toBe('true');
    expect(editor?.getAttribute('role')).toBe('textbox');
  });

  const copiedText = Array.from({ length: 10 }, (_, index) => `code line ${index + 1}`).join('\n');
  const otherCopiedText = copiedText.replaceAll('code', 'other');

  it('keeps a pending paste before subsequently typed text', async () => {
    let resolveMatch!: (value: null) => void;
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMatch = resolve;
        })
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => `${copiedText} `, items: [], types: ['text/plain'] },
    });
    editor.dispatchEvent(event);
    flushSolid();
    editor.appendChild(document.createTextNode('typed'));
    setCollapsedSelection(editor.lastChild!, 5);
    flushSolid();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    resolveMatch(null);
    await settle();
    expect(inputText()).toBe(`${copiedText} typed`);
    expect(editor.textContent).toBe(`${copiedText.replaceAll('\n', '')} typed`);
    flushSolid();
  });

  it('turns a large paste into one undoable immutable attachment', async () => {
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const text = 'Unicode 雪\r\n'.repeat(30);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => text, items: [], types: ['text/plain'] },
    });
    editor.dispatchEvent(event);
    await settle();
    expect(inputText()).toBe(`@${state.droppedFiles[0]?.relativePath}`);
    expect(state.droppedFiles[0]?.pastedText).toBe(text);
    const path = state.droppedFiles[0]?.path;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    await settle();
    expect(state.droppedFiles).toHaveLength(0);
    expect(inputText()).toBe('');
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true })
    );
    await settle();
    expect(state.droppedFiles[0]).toMatchObject({ path, pastedText: text });
    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();
    expect(inputText()).toBe(text);
    expect(state.droppedFiles).toHaveLength(0);
  });

  it('keeps a pasted attachment out of the attachment strip while Enter sends it', async () => {
    let resolveSend!: (sent: boolean) => void;
    sendMessageMock.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveSend = resolve))
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const text = 'Large pasted text\n'.repeat(30);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => text, items: [], types: ['text/plain'] },
    });
    editor.dispatchEvent(paste);
    await settle();
    const draft = inputText();
    expect(editor.querySelector('.inline-chip')).not.toBeNull();
    expect(container!.querySelector('.chat-attachments-container')).toBeNull();

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(enter);
    await settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe(draft);
    expect(inputText()).toBe('');
    expect(container!.querySelector('.chat-attachments-container')).toBeNull();

    resolveSend(false);
    await settle();
    expect(inputText()).toBe(draft);
    expect(editor.querySelector('.inline-chip')).not.toBeNull();
    expect(container!.querySelector('.chat-attachments-container')).toBeNull();
  });

  it('does not convert a pending paste after the destination session changes', async () => {
    let resolveMatch!: (value: null) => void;
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMatch = resolve;
        })
    );
    setStateAndFlush('activeSessionId', 'session-1');
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => copiedText.repeat(30), items: [], types: ['text/plain'] },
    });
    editor.dispatchEvent(event);
    flushSolid();
    setStateAndFlush('activeSessionId', 'session-2');
    resolveMatch(null);
    await settle();
    expect(state.droppedFiles).toHaveLength(0);
  });

  it('includes a pending paste in Send without inserting it into the next draft', async () => {
    let resolveMatch!: (
      value: Awaited<ReturnType<typeof client.varro.matchCopiedSelection>>
    ) => void;
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMatch = resolve;
        })
    );
    setStateAndFlush('activeSessionId', 'session-1');
    setInputTextAndFlush('Explain ');
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor.firstChild!, 8);
    flushSolid();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => copiedText, items: [], types: ['text/plain'] },
    });
    editor.dispatchEvent(event);
    flushSolid();
    container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
    await settle();
    resolveMatch({ type: 'terminal', selection: { text: copiedText, terminalName: 'zsh' } });
    await settle();
    expect({ sent: sendMessageMock.mock.calls[0]?.[0], draft: inputText() }).toEqual({
      sent: `Explain ${copiedText}`,
      draft: '',
    });
    expect(state.terminalSelection).toBeNull();
  });

  it('restores exact file chip text through undo and redo after a later paste', async () => {
    const file = {
      path: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      type: 'file' as const,
      lineRanges: [{ startLine: 3, endLine: 3 }],
    };
    vi.mocked(client.varro.matchCopiedSelection)
      .mockResolvedValueOnce({ type: 'file', file })
      .mockResolvedValueOnce({ type: 'file', file });
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => text, items: [], types: ['text/plain'] },
      });
      editor.dispatchEvent(event);
    };
    const history = async (redo = false) => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: true,
          shiftKey: redo,
          bubbles: true,
        })
      );
      await flushAsyncWork();
    };
    paste(copiedText);
    await settle();
    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();
    expect(inputText()).toBe(copiedText);
    const range = document.createRange();
    range.selectNodeContents(editor);
    window.getSelection()!.removeAllRanges();
    flushSolid();
    window.getSelection()!.addRange(range);
    flushSolid();
    paste(otherCopiedText);
    await settle();
    expect(inputText()).toBe('@src/app.ts');
    await history();
    flushSolid();
    expect(inputText()).toBe(copiedText);
    await history();
    flushSolid();
    expect(inputText()).toBe('@src/app.ts');
    await history(true);
    flushSolid();
    await history(true);
    flushSolid();
    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();
    expect(inputText()).toBe(otherCopiedText);
    await history();
    flushSolid();
    await history();
    flushSolid();
    await history();
    flushSolid();
    expect(inputText()).toBe('@src/app.ts');
    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();
    expect(inputText()).toBe(copiedText);
  });

  it('turns a matching copied editor selection into a file-range chip', async () => {
    vi.mocked(client.varro.matchCopiedSelection).mockResolvedValueOnce({
      type: 'file',
      file: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    });
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    flushSolid();
    expect(inputText()).toBe(copiedText);
    await flushAsyncWork();
    flushSolid();

    expect(client.varro.matchCopiedSelection).toHaveBeenCalledWith(copiedText, false);
    expect(inputText()).toBe('@src/app.ts');
    expect(editor?.querySelector('.inline-chip')?.textContent).toContain('L3-5');
    const chip = editor?.querySelector<HTMLElement>('[data-chip-type="mention-file"]');
    const trailingSpacer = chip?.nextSibling;
    if (!editor || trailingSpacer?.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected a file chip followed by a caret spacer');
    }
    editor.focus();
    flushSolid();
    setCollapsedSelection(trailingSpacer, 1);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(container?.querySelector('.composer-completion-menu')).toBeNull();

    setInputText('@src/app.ts @');
    await settle();
    const finalText = editor.querySelector('[data-chip-type="mention-file"]')?.nextSibling;
    if (finalText?.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected text after the file chip');
    setCollapsedSelection(finalText, finalText.textContent!.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '@', bubbles: true }));
    await settle();
    expect(container?.querySelector('.composer-completion-menu')).not.toBeNull();
    expect(state.droppedFiles).toEqual([
      expect.objectContaining({
        path: '/repo/src/app.ts',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      }),
    ]);
  });

  it('turns a matching terminal paste into a terminal chip', async () => {
    vi.mocked(client.varro.matchCopiedSelection).mockResolvedValueOnce({
      type: 'terminal',
      selection: { text: copiedText, terminalName: 'zsh' },
    });
    setInputTextAndFlush('Test ');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 5);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    flushSolid();
    expect(inputText()).toBe(`Test ${copiedText}`);
    expect(editor?.textContent).not.toContain(copiedText);
    await flushAsyncWork();
    flushSolid();

    expect(inputText()).toBe('Test [Terminal selection]');
    expect(editor?.querySelector('.inline-chip')?.textContent).toContain('10 lines');
    expect(editor?.querySelector('.inline-chip')?.getAttribute('title')).toBe(copiedText);
    expect(container?.querySelector('.chat-attachments-container')).toBeNull();
    expect(state.terminalSelection).toEqual({
      text: copiedText,
      terminalName: 'zsh',
    });
    container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.click();
    await settle();
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Test [Terminal selection]',
      expect.objectContaining({ noReply: false })
    );
  });

  it('does not insert the same copied terminal selection twice', async () => {
    const selection = { text: copiedText, terminalName: 'zsh' };
    vi.mocked(client.varro.matchCopiedSelection)
      .mockResolvedValueOnce({ type: 'terminal', selection })
      .mockResolvedValueOnce({ type: 'terminal', selection });
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const paste = () => {
      dispatchTextPaste(editor, selection.text);
    };

    paste();
    await settle();
    const firstValue = inputText();
    const chip = editor.querySelector<HTMLElement>('[data-chip-type="mention-terminal"]');
    if (chip?.nextSibling?.nodeType !== Node.TEXT_NODE) throw new Error('Expected caret spacer');
    setCollapsedSelection(chip.nextSibling, 1);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    flushSolid();
    paste();
    await settle();

    expect(inputText()).toBe(firstValue);
    expect(editor.querySelectorAll('[data-chip-type="mention-terminal"]')).toHaveLength(1);
  });

  it('keeps a different terminal paste as text instead of replacing the attached selection', async () => {
    setStateAndFlush('terminalSelection', { text: 'npm test', terminalName: 'zsh' });
    setInputTextAndFlush('Check [Terminal selection] ');
    vi.mocked(client.varro.matchCopiedSelection).mockResolvedValueOnce({
      type: 'terminal',
      selection: { text: otherCopiedText, terminalName: 'zsh' },
    });
    renderChatInput();
    const editor = focusComposer();
    const trailingText = editor.querySelector('[data-chip-type="mention-terminal"]')?.nextSibling;
    if (trailingText?.nodeType !== Node.TEXT_NODE) throw new Error('Expected text after chip');
    setCollapsedSelection(trailingText, trailingText.textContent!.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
    flushSolid();
    dispatchTextPaste(editor, otherCopiedText);
    await settle();

    expect(inputText()).toBe(`Check [Terminal selection] ${otherCopiedText}`);
    expect(state.terminalSelection).toEqual({ text: 'npm test', terminalName: 'zsh' });
  });

  function openChipMenu(editor: HTMLElement, chipType: string) {
    const chip = editor.querySelector<HTMLElement>(`[data-chip-type="${chipType}"]`);
    if (!chip) throw new Error(`Expected a ${chipType} chip`);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    chip.dispatchEvent(event);
    return event;
  }

  function clickExpandToText() {
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (button) => button.textContent === 'Expand to Text'
    );
    if (!item) throw new Error('Expected the Expand to Text menu item');
    item.click();
  }

  it('expands a pasted file chip back to the exact pasted text', async () => {
    vi.mocked(client.varro.matchCopiedSelection).mockResolvedValueOnce({
      type: 'file',
      file: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      },
    });
    setInputTextAndFlush('Fix ');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor?.firstChild) throw new Error('Expected composer editor');
    editor.focus();
    flushSolid();
    setCollapsedSelection(editor.firstChild, 4);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    await settle();
    expect(inputText()).toBe('Fix @src/app.ts');

    expect(openChipMenu(editor, 'mention-file').defaultPrevented).toBe(true);
    flushSolid();
    clickExpandToText();
    await settle();

    expect(inputText()).toBe(`Fix ${copiedText}`);
    expect(state.droppedFiles).toEqual([]);
    expect(client.varro.readWorkspaceFile).not.toHaveBeenCalled();

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    await settle();
    expect(inputText()).toBe('Fix @src/app.ts');
    expect(state.droppedFiles).toEqual([
      expect.objectContaining({
        path: '/repo/src/app.ts',
        lineRanges: [{ startLine: 3, endLine: 5 }],
      }),
    ]);

    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();
    expect(inputText()).toBe(`Fix ${copiedText}`);
    expect(client.varro.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('expands a terminal chip back to the terminal text', async () => {
    const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    setStateAndFlush('terminalSelection', { text: 'npm test\nok', terminalName: 'zsh' });
    setInputTextAndFlush('Check [Terminal selection] please');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    try {
      openChipMenu(editor, 'mention-terminal');
      flushSolid();
      clickExpandToText();
      await settle();

      expect(inputText()).toBe('Check npm test\nok please');
      expect(state.terminalSelection).toBeNull();
      expect(sent).toContainEqual({ type: 'terminal-selection/clear' });

      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })
      );
      await settle();
      expect(inputText()).toBe('Check [Terminal selection] please');
      expect(state.terminalSelection).toEqual({ text: 'npm test\nok', terminalName: 'zsh' });
      expect(editor.querySelector('[data-chip-type="mention-terminal"]')).not.toBeNull();

      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true })
      );
      await settle();
      expect(inputText()).toBe('Check npm test\nok please');
      expect(state.terminalSelection).toBeNull();
    } finally {
      bridgeWindow.__sendToExtension = originalSend;
    }
  });

  it('expands other file range chips to the lines they reference', async () => {
    vi.mocked(client.varro.readWorkspaceFile).mockResolvedValueOnce('one\ntwo\nthree\nfour');
    addContextFile({
      path: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      type: 'file',
      lineRanges: [{ startLine: 2, endLine: 3 }],
    });
    flushSolid();
    setInputTextAndFlush('See @src/app.ts');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    openChipMenu(editor, 'mention-file');
    flushSolid();
    clickExpandToText();
    await settle();

    expect(client.varro.readWorkspaceFile).toHaveBeenCalledWith('/repo/src/app.ts');
    expect(inputText()).toBe('See two\nthree');
    expect(state.droppedFiles).toEqual([]);
  });

  it('keeps the native context menu for whole-file chips', () => {
    addContextFile({ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' });
    flushSolid();
    setInputTextAndFlush('See @src/app.ts');
    renderChatInput();
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    expect(openChipMenu(editor, 'mention-file').defaultPrevented).toBe(false);
    flushSolid();
    expect(document.querySelector('[aria-label="Chip actions"]')).toBeNull();
  });

  it('does not insert the same copied file range twice', async () => {
    const file = {
      path: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      type: 'file' as const,
      lineRanges: [{ startLine: 3, endLine: 5 }],
    };
    vi.mocked(client.varro.matchCopiedSelection)
      .mockResolvedValueOnce({ type: 'file', file })
      .mockResolvedValueOnce({ type: 'file', file });
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const paste = () => {
      dispatchTextPaste(editor, copiedText);
    };

    paste();
    await settle();
    const chip = editor.querySelector<HTMLElement>('[data-chip-type="mention-file"]');
    if (chip?.nextSibling?.nodeType !== Node.TEXT_NODE) throw new Error('Expected caret spacer');
    setCollapsedSelection(chip.nextSibling, 1);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    flushSolid();
    paste();
    await settle();

    expect(inputText()).toBe('@src/app.ts');
    expect(editor.querySelectorAll('[data-chip-type="mention-file"]')).toHaveLength(1);
    expect(state.droppedFiles).toHaveLength(1);
  });

  it('extends an existing file chip for another range without adding a second chip', async () => {
    addContextFile({
      path: '/repo/src/app.ts',
      relativePath: 'src/app.ts',
      type: 'file',
      lineRanges: [{ startLine: 3, endLine: 5 }],
    });
    flushSolid();
    setInputTextAndFlush('@src/app.ts ');
    vi.mocked(client.varro.matchCopiedSelection).mockResolvedValueOnce({
      type: 'file',
      file: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 8, endLine: 9 }],
      },
    });
    renderChatInput();
    const editor = focusComposer();
    const trailingText = editor.querySelector('[data-chip-type="mention-file"]')?.nextSibling;
    if (trailingText?.nodeType !== Node.TEXT_NODE) throw new Error('Expected text after file chip');
    setCollapsedSelection(trailingText, trailingText.textContent!.length);
    flushSolid();
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
    flushSolid();
    dispatchTextPaste(editor, otherCopiedText);
    await settle();

    expect(inputText()).toBe('@src/app.ts ');
    expect(editor.querySelectorAll('[data-chip-type="mention-file"]')).toHaveLength(1);
    expect(state.droppedFiles[0]?.lineRanges).toEqual([
      { startLine: 3, endLine: 5 },
      { startLine: 8, endLine: 9 },
    ]);
  });

  it('inserts copied text immediately and upgrades it to a chip at the same position', async () => {
    let resolveMatch:
      | ((value: Awaited<ReturnType<typeof client.varro.matchCopiedSelection>>) => void)
      | undefined;
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMatch = resolve;
        })
    );
    setInputTextAndFlush('Before after');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 7);
    flushSolid();
    const event = dispatchTextPaste(editor, copiedText);
    flushSolid();
    expect(event.defaultPrevented).toBe(true);
    expect(inputText()).toBe(`Before ${copiedText}after`);

    resolveMatch?.({
      type: 'file',
      file: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 7, endLine: 8 }],
      },
    });
    await settle();
    expect(inputText()).toBe('Before @src/app.ts after');
    expect(editor?.querySelector('.inline-chip')?.textContent).toContain('L7-8');
  });

  it('does not restore pasted text after the user replaces it before the lookup resolves', async () => {
    let resolveMatch:
      | ((value: Awaited<ReturnType<typeof client.varro.matchCopiedSelection>>) => void)
      | undefined;
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMatch = resolve;
        })
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    flushSolid();
    setInputTextAndFlush('typed');

    resolveMatch?.({
      type: 'file',
      file: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        type: 'file',
        lineRanges: [{ startLine: 7, endLine: 8 }],
      },
    });
    await settle();
    expect(inputText()).toBe('typed');
    expect(state.droppedFiles).toEqual([]);
  });

  it('keeps pasted text when the selection lookup does not answer in time', async () => {
    vi.mocked(client.varro.matchCopiedSelection).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    flushSolid();
    expect(inputText()).toBe(copiedText);
    expect(editor?.textContent).not.toContain(copiedText);
    await new Promise((resolve) => setTimeout(resolve, 200));
    flushSolid();
    expect(inputText()).toBe(copiedText);
    expect(editor?.textContent).toBe(copiedText.replaceAll('\n', ''));
    flushSolid();
  });

  it('marks plain-text-only clipboards as possible terminal copies', async () => {
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    const paste = (types: string[]) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData: (type: string) => (type === 'text/plain' ? copiedText : ''),
          items: [],
          types,
        },
      });
      editor?.dispatchEvent(event);
    };

    paste(['text/plain']);
    flushSolid();
    paste(['text/plain', 'text/html']);
    await settle();

    expect(vi.mocked(client.varro.matchCopiedSelection).mock.calls).toEqual([
      [copiedText, true],
      [copiedText, false],
    ]);
  });

  it('keeps pasted text when the selection lookup fails', async () => {
    vi.mocked(client.varro.matchCopiedSelection).mockRejectedValueOnce(new Error('host gone'));
    renderChatInput();
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();
    dispatchTextPaste(editor, copiedText);
    await settle();
    expect(inputText()).toBe(copiedText);
    expect(editor?.textContent).toBe(copiedText.replaceAll('\n', ''));
    flushSolid();
  });

  it('keeps unmatched clipboard text at the original cursor after the lookup', async () => {
    setInputTextAndFlush('Before after');
    renderChatInput();
    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, 7);
    flushSolid();
    dispatchTextPaste(editor, 'plain text ');
    flushSolid();
    expect(inputText()).toBe('Before plain text after');
    await flushAsyncWork();
    flushSolid();
    expect(inputText()).toBe('Before plain text after');
  });

  it('rehydrates pasted file mentions into context files', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    flushSolid();
    if (editor) setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, 'Review @README.md and @docs/');
    await settle();

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
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@README.md');
    await settle();

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
    setStateAndFlush('editorContext', idleEditorContext('/repo'));
    setInputTextAndFlush('existing draft');

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    flushSolid();

    const event = dispatchTextPaste(editor, '[Selection from src/app.ts lines 3-5]\n@README.md');
    await settle();

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
    setStateAndFlush('editorContext', idleEditorContext('/repo'));
    setStateAndFlush('activeSessionId', 'session-a');

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@README.md');
    flushSolid();
    // The user switches sessions before the workspace lookup comes back.
    setStateAndFlush('activeSessionId', 'session-b');
    await settle();

    expect(state.droppedFiles).toEqual([]);
    setStateAndFlush('activeSessionId', null);
  });

  it('does not attach a pasted mention after the composer is cleared in the same session', async () => {
    setStateAndFlush('activeSessionId', 'session-a');
    let resolveLookup:
      | ((value: Awaited<ReturnType<typeof client.varro.resolveWorkspacePath>>) => void)
      | undefined;
    vi.mocked(client.varro.resolveWorkspacePath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
    );

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@README.md');
    flushSolid();
    expect(inputText()).toBe('@README.md');
    setInputTextAndFlush('');
    resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
    await settle();

    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
  });

  it('does not attach a pasted mention after it is sent in the same session', async () => {
    setStateAndFlush('activeSessionId', 'session-a');
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

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@README.md');
    flushSolid();
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSolid();
    resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('@README.md', { noReply: false });
    expect(inputText()).toBe('');
    expect(state.droppedFiles).toEqual([]);
  });

  it('withdraws the pasted copy, not an identical mention already in the composer', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    editor?.focus();
    flushSolid();
    // Pre-existing identical mention; with no DOM selection the paste appends
    // at the end, so the two copies sit at different offsets. Searching by
    // content would strip the leading copy and leave ' and notes@README.md'.
    setInputTextAndFlush('@README.md and notes');

    dispatchTextPaste(editor, '@README.md');
    await settle();

    expect(inputText()).toBe('@README.md and notes');
  });

  it('withdraws only the pasted mention copy when its paired image is null', async () => {
    setInputTextAndFlush('@README.md');
    renderChatInput();
    await settle();

    const editor = focusPopulatedComposer();
    setCollapsedSelection(editor.firstChild, '@README.md'.length);
    flushSolid();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '@README.md' : ''),
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      },
    });

    editor?.dispatchEvent(event);
    await settle();

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
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();

      dispatchImagePaste(
        editor,
        [new File(['image'], 'mixed.png', { type: 'image/png' })],
        'Pasted description'
      );
      flushSolid();
      fileReader.resolve('mixed.png');
      await settle();

      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(inputText().match(/Pasted description/g)).toHaveLength(1);
      expect(state.clipboardImages.map((image) => image.filename)).toEqual(['Image 1']);
    });
  });

  it('attaches and disables an image for a model without vision support', async () => {
    await withControllableFileReader(async (fileReader) => {
      setupModelState();
      setState(storePath('providers', 0, 'models', 'gpt-4o', 'capabilities', 'vision', false));
      flushSolid();
      renderChatInput();
      await settle();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');

      dispatchImagePaste(editor, [new File(['image'], 'unsupported.png', { type: 'image/png' })]);
      flushSolid();

      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'Image attached; use a vision-capable model or vision subagent to send it',
        'warning',
        container?.querySelector('.chat-input-container')
      );

      fileReader.resolve('unsupported.png');
      await settle();
      expect(inputText()).toBe('');
      expect(state.clipboardImages).toHaveLength(1);
      expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeInstanceOf(
        HTMLElement
      );
    });
  });

  it.each(
    [false, true].flatMap((editorWasFocused) =>
      ['row', 'body', 'editor'].map((pasteTarget) => ({ editorWasFocused, pasteTarget }))
    )
  )(
    'pastes outside the draft with editor focus=$editorWasFocused and paste target=$pasteTarget',
    async ({ editorWasFocused, pasteTarget }) => {
      await withControllableFileReader(async (fileReader) => {
        renderChatInput();
        await settle();

        const editor = focusComposer();
        dispatchImagePaste(editor, [new File(['first'], 'first.png', { type: 'image/png' })]);
        flushSolid();
        fileReader.resolve('first.png');
        await settle();

        const attachmentRow = container?.querySelector<HTMLElement>('.chat-attachments-container');
        if (!attachmentRow) throw new Error('Expected attachment row');
        setInputTextAndFlush('Existing draft');
        editor.focus();
        flushSolid();
        if (editor.firstChild) setCollapsedSelection(editor.firstChild, 8);
        flushSolid();
        if (!editorWasFocused) editor.blur();
        flushSolid();
        attachmentRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        flushSolid();
        expect(document.activeElement).toBe(attachmentRow);

        const target =
          pasteTarget === 'row' ? attachmentRow : pasteTarget === 'editor' ? editor : document.body;
        const paste = dispatchImagePaste(
          target,
          [new File(['second'], 'second.png', { type: 'image/png' })],
          'Clipboard image label'
        );
        flushSolid();
        expect(paste.defaultPrevented).toBe(true);
        fileReader.resolve('second.png');
        await settle();

        expect(inputText()).toBe('Existing draft');
        expect(state.clipboardImages.map((image) => image.filename)).toEqual([
          'Image 1',
          'Image 2',
        ]);
        expect(attachmentRow.querySelectorAll('.chat-attachment-chip')).toHaveLength(2);
        expect(document.activeElement).toBe(attachmentRow);

        editor.focus();
        flushSolid();
        if (editor.firstChild) setCollapsedSelection(editor.firstChild, 8);
        flushSolid();
        dispatchImagePaste(editor, [new File(['third'], 'third.png', { type: 'image/png' })]);
        flushSolid();
        fileReader.resolve('third.png');
        await settle();

        expect(inputText()).toBe('Existing [Image 3] draft');
        expect(attachmentRow.querySelectorAll('.chat-attachment-chip')).toHaveLength(2);
      });
    }
  );

  it('does not claim pastes after focus leaves the attachment row', async () => {
    addClipboardImage({
      id: 'existing-image',
      url: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
      filename: 'Image 1',
      size: 5,
    });
    flushSolid();
    renderChatInput();
    await settle();

    const row = container?.querySelector<HTMLElement>('.chat-attachments-container');
    if (!row) throw new Error('Expected attachment row');
    row.click();
    flushSolid();
    expect(document.activeElement).toBe(row);
    const textPaste = dispatchImagePaste(row, [], 'Plain text');
    flushSolid();
    expect(textPaste.defaultPrevented).toBe(false);

    const otherInput = document.createElement('textarea');
    container?.append(otherInput);
    otherInput.focus();
    flushSolid();
    const imagePaste = dispatchImagePaste(otherInput, [
      new File(['other'], 'other.png', { type: 'image/png' }),
    ]);
    flushSolid();
    expect(imagePaste.defaultPrevented).toBe(false);
    expect(inputText()).toBe('');
    expect(state.clipboardImages).toHaveLength(1);
  });

  it.each([20, 10_000])('does not reread %i loaded messages on keystrokes', async (count) => {
    const diagnostics = OBSERVE!.diagnostics.capture();
    onTestFinished(() => {
      diagnostics.stop();
    });
    // Only these initial prompt/token aggregates in the deliberately oversized fixture are expected.
    const expectedFanIn = [
      'messageHistory',
      'createSettledHistoryRanges.frozen',
      'tokenFrozenTotals',
      'tokenHistoryTotals',
    ];
    const restoreWarnings = count === 10_000 ? suppressExpectedHugeFanIn(expectedFanIn) : undefined;
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    let infoReads = 0;
    let partsReads = 0;
    setStateAndFlush(
      'messages',
      Array.from({ length: count }, (_, index): MessageEntry => {
        const id = `history-${index}`;
        const entry =
          index % 2 === 0
            ? historyEntry(id, `Prompt ${index}`)
            : assistantMessageEntry({ input: 100, output: 20 });
        const info = { ...entry.info, id, time: { created: index, completed: index + 1 } };
        // Each reply belongs to the preceding prompt, not the helper's absent "user-1".
        // Missing-parent searches are a different stress condition from loaded-history typing.
        if (info.role === 'assistant') info.parentID = `history-${index - 1}`;
        const parts: TextPart[] = [
          {
            id: `text-${index}`,
            messageID: id,
            sessionID: 'session-1',
            type: 'text',
            text: `Content ${index}`,
          },
        ];
        return {
          get info() {
            infoReads += 1;
            return info;
          },
          get parts() {
            partsReads += 1;
            return parts;
          },
        };
      })
    );
    renderChatInput();
    await settle();
    const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
    expect(infoReads).toBeGreaterThan(0);
    expect(partsReads).toBeGreaterThan(0);
    // Any new wide subscription while typing is a regression, not fixture noise.
    restoreWarnings?.();
    infoReads = 0;
    partsReads = 0;

    const text = 'Keep this long conversation responsive while I type.';
    for (let length = 1; length <= text.length; length += 1) {
      enterComposerText(editor, text.slice(0, length));
      await flushAsyncWork();
      flushSolid();
    }

    expect(inputText()).toBe(text);
    expect(infoReads).toBe(0);
    expect(partsReads).toBe(0);
    expect(
      diagnostics.events.filter(
        (event) =>
          event.code === 'HUGE_FAN_IN' &&
          (count !== 10_000 || !expectedFanIn.includes(event.nodeName ?? ''))
      )
    ).toEqual([]);
  });

  it('does not inspect historical prompts while typing without images', async () => {
    setupVisionDelegationModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    let partsReadCount = 0;
    setStateAndFlush('messages', [
      countedUserMessageEntry('@vision inspect the previous image', () => {
        partsReadCount += 1;
      }),
    ]);
    renderChatInput();
    await settle();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const readsAfterMount = partsReadCount;

    enterComposerText(editor, 'a');
    enterComposerText(editor, 'ab');
    await flushAsyncWork();
    flushSolid();

    expect(inputText()).toBe('ab');
    expect(state.clipboardImages).toEqual([]);
    expect(partsReadCount).toBe(readsAfterMount);
  });

  it('keeps automatic vision delegation enabled while the draft changes without rereading history', async () => {
    setupVisionDelegationModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    let partsReadCount = 0;
    setStateAndFlush('messages', [
      countedUserMessageEntry('Inspect the previous image', () => {
        partsReadCount += 1;
      }),
    ]);
    addClipboardImage({
      id: 'image-1',
      url: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
      filename: 'Image 1',
      size: 5,
      contextFile: { path: '/tmp/Image 1.png', relativePath: 'Image 1.png', type: 'file' },
    });
    flushSolid();
    renderChatInput();
    await settle();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    const imageChip = container?.querySelector<HTMLElement>('.chat-attachment-chip');
    if (!editor || !imageChip) throw new Error('Expected composer editor and image chip');
    expect(imageChip.classList).not.toContain('disabled');
    const readsAfterMount = partsReadCount;

    enterComposerText(editor, 'Inspect this image');
    await flushAsyncWork();
    flushSolid();
    expect(partsReadCount).toBe(readsAfterMount);
    expect(container?.querySelector('.chat-attachment-chip')).toBe(imageChip);
    expect(imageChip.classList).not.toContain('disabled');

    enterComposerText(editor, '@vision inspect this image');
    await flushAsyncWork();
    flushSolid();
    expect(partsReadCount).toBe(readsAfterMount);
    expect(container?.querySelector('.chat-attachment-chip')).toBe(imageChip);
    expect(imageChip.classList).not.toContain('disabled');

    enterComposerText(editor, 'Inspect this image again');
    await flushAsyncWork();
    flushSolid();
    expect(partsReadCount).toBe(readsAfterMount);
    expect(container?.querySelector('.chat-attachment-chip')).toBe(imageChip);
    expect(imageChip.classList).not.toContain('disabled');
  });

  it.each([false, true])(
    'hides submitted strip attachments while sending and restores a failed draft (creates session: %s)',
    async (createsSession) => {
      setupModelState();
      setStateAndFlush('activeSessionId', createsSession ? null : 'session-1');
      let resolveSend!: (sent: boolean) => void;
      sendMessageMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveSend = resolve))
      );
      addContextFile({ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' });
      flushSolid();
      addClipboardImage({
        id: 'image-1',
        url: 'data:image/png;base64,aW1hZ2U=',
        mime: 'image/png',
        filename: 'Image 1',
        size: 5,
      });
      flushSolid();
      setInputTextAndFlush('Review these attachments');
      renderChatInput();
      await settle();
      const editor = container!.querySelector<HTMLDivElement>('.rich-composer')!;
      expect(container!.querySelectorAll('.chat-attachment-chip')).toHaveLength(2);
      container!.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')!.click();
      await settle();
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(editor.textContent).toBe('');
      expect(editor.getAttribute('data-placeholder')).toBe('Queue a follow-up or steer');
      expect(container!.querySelector('.chat-attachments-container')).toBeNull();
      if (createsSession) {
        setStateAndFlush('activeSessionId', 'created-session');
        await settle();
        expect(editor.textContent).toBe('');
        expect(editor.getAttribute('data-placeholder')).toBe('Queue a follow-up or steer');
        expect(container!.querySelector('.chat-attachments-container')).toBeNull();
      }
      flushSolid();
      // The send still owns its payload; a newly attached file belongs to the next draft.
      expect(state.droppedFiles).toHaveLength(1);
      expect(state.clipboardImages).toHaveLength(1);
      addContextFile({ path: '/repo/src/next.ts', relativePath: 'src/next.ts', type: 'file' });
      flushSolid();
      expect(container!.querySelectorAll('.chat-attachment-chip')).toHaveLength(1);
      expect(container!.querySelector('.chat-attachment-chip')?.textContent).toContain('next.ts');
      resolveSend(false);
      await settle();
      expect(editor.textContent).toBe('Review these attachments');
      expect(container!.querySelectorAll('.chat-attachment-chip')).toHaveLength(3);
    }
  );

  it('keeps unchanged attachment chips mounted while typing', async () => {
    setupModelState();
    addContextFile({ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' });
    flushSolid();
    addClipboardImage({
      id: 'image-1',
      url: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
      filename: 'Image 1',
      size: 5,
    });
    flushSolid();
    renderChatInput();
    await settle();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    const before = Array.from(
      container!.querySelectorAll<HTMLElement>('.chat-attachments-container .chat-attachment-chip')
    );
    expect(before).toHaveLength(2);

    enterComposerText(editor, 'plain typing');
    await flushAsyncWork();
    flushSolid();

    const after = Array.from(
      container!.querySelectorAll<HTMLElement>('.chat-attachments-container .chat-attachment-chip')
    );
    expect(after).toHaveLength(before.length);
    expect(after.every((chip, index) => chip === before[index])).toBe(true);
  });

  it('releases a stored image removed from the attachment strip', async () => {
    const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
    const originalSend = bridgeWindow.__sendToExtension;
    const sent: WebviewMessage[] = [];
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      addClipboardImage({
        id: 'stored-image',
        url: 'data:image/png;base64,aW1hZ2U=',
        mime: 'image/png',
        filename: 'Stored image',
        size: 5,
        contextFile: {
          path: '/tmp/varro/stored-image.png',
          relativePath: 'stored-image.png',
          type: 'file',
        },
      });
      flushSolid();
      renderChatInput();
      await settle();

      const removeButton = container?.querySelector<HTMLButtonElement>(
        '.chat-attachments-container .chat-attachment-chip .chip-remove'
      );
      if (!removeButton) throw new Error('Expected the stored image attachment remove button');
      removeButton.click();
      flushSolid();

      expect(state.clipboardImages).toEqual([]);
      expect(sent).toContainEqual({
        type: 'images/release',
        payload: { paths: ['/tmp/varro/stored-image.png'], deferred: false },
      });
    } finally {
      if (originalSend) bridgeWindow.__sendToExtension = originalSend;
      else delete bridgeWindow.__sendToExtension;
    }
  });

  it.each([null, { startLine: 101, endLine: 108 }])(
    'pins the active context with its selected lines: %j',
    async (selection) => {
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('editorContext', {
        workspacePath: '/repo',
        activeFile: {
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          language: 'typescript',
        },
        selection,
        diagnostics: [],
      });
      renderChatInput();
      await settle();

      const pinButton = container?.querySelector<HTMLButtonElement>(
        '.chat-attachments-container .chat-attachment-chip .chip-pin'
      );
      if (!pinButton) throw new Error('Expected the active-context attachment pin button');
      pinButton.click();
      flushSolid();

      expect(state.droppedFiles).toEqual([
        expect.objectContaining({
          path: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          type: 'file',
          lineRanges: selection ? [selection] : undefined,
        }),
      ]);
      expect(container?.querySelectorAll('.chat-attachment-chip')).toHaveLength(1);
      expect(container?.querySelector('.chip-pin')).toBeNull();

      setState(
        storePath('editorContext', 'activeFile', {
          path: '/repo/src/other.ts',
          relativePath: 'src/other.ts',
          language: 'typescript',
        })
      );
      flushSolid();
      setState(storePath('editorContext', 'selection', null));
      await settle();

      expect(state.droppedFiles[0]?.path).toBe('/repo/src/app.ts');
      expect(state.droppedFiles[0]?.lineRanges).toEqual(selection ? [selection] : undefined);
      const attachment = [...container!.querySelectorAll('.chat-attachment-chip')].find((chip) =>
        chip.querySelector('.chip-remove')
      );
      expect(attachment?.textContent).toContain('app.ts');
      if (selection) expect(attachment?.textContent).toContain('L101-108');
    }
  );

  it('automatically enables and stores a non-vision image without a vision mention', async () => {
    const fileReader = installControllableFileReader();
    flushSolid();
    setupVisionDelegationModelState();
    const posted = vi.fn();
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      posted;
    renderChatInput();
    await settle();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');
    dispatchImagePaste(editor, [new File(['image'], 'delegated.png', { type: 'image/png' })]);
    flushSolid();
    fileReader.resolve('delegated.png');
    await settle();

    const stagedImageChip = container?.querySelector('.chat-attachment-chip');
    expect(stagedImageChip).toBeInstanceOf(HTMLElement);
    expect(stagedImageChip?.classList).not.toContain('disabled');
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'images/store',
        payload: expect.objectContaining({ name: 'Image 1' }),
      })
    );
    expect(showSessionActionFeedbackMock).not.toHaveBeenCalledWith(
      'Image attached; use a vision-capable model or vision subagent to send it',
      'warning',
      expect.anything()
    );

    setInputText('Inspect [Image 1]');
    await settle();

    expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeNull();
    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(sendButton?.disabled).toBe(true);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Preparing attachments: storing images for vision delegation',
      'warning'
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'images/stored',
          payload: {
            id: state.clipboardImages[0]!.id,
            contextFile: { path: '/repo/Image 1.png', relativePath: 'Image 1.png', type: 'file' },
          },
        },
      })
    );
    await settle();

    expect(sendButton?.disabled).toBe(false);
    sendButton?.click();
    await settle();
    expect(sendMessageMock).toHaveBeenCalledWith('Inspect [Image 1]', expect.anything());
    fileReader.restore();
    flushSolid();
  });

  it('immediately makes a staged image sendable after switching to a vision model', async () => {
    setStateAndFlush('providers', [
      apiProvider('custom', 'Custom', [
        toolModel('text', 'Text', { capabilities: { toolcall: true, vision: false } }),
        toolModel('vision', 'Vision', { capabilities: { attachment: true, toolcall: true } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { custom: 'text' });
    setStateAndFlush('selectedModel', { providerID: 'custom', modelID: 'text' });
    addClipboardImage({
      id: 'image-1',
      url: 'data:image/png;base64,aW1hZ2U=',
      mime: 'image/png',
      filename: 'Image 1',
      size: 5,
    });
    flushSolid();
    setInputTextAndFlush('[Image 1]');
    renderChatInput();
    await settle();

    expect(container?.querySelector('.chat-send-button')?.classList).toContain('disabled');

    setStateAndFlush('selectedModel', { providerID: 'custom', modelID: 'vision' });
    await settle();

    expect(container?.querySelector('.chat-send-button')?.classList).toContain('enabled');
    expect(container?.querySelector('.chat-attachment-chip.disabled')).toBeNull();
  });

  it.each([false, true])(
    'keeps prepared images previewable and sendable after New Chat (switch to vision first: %s)',
    async (switchBeforeNewChat) => {
      setupVisionDelegationModelState();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('messages', [historyEntry('existing-user', 'An existing conversation')]);
      setStateAndFlush('clipboardImages', [
        {
          id: 'carried-image',
          url: 'data:image/png;base64,aW1hZ2U=',
          mime: 'image/png',
          filename: 'Image 1',
          size: 5,
          contextFile: { path: '/repo/Image 1.png', relativePath: 'Image 1.png', type: 'file' },
        },
      ]);
      setInputTextAndFlush('Describe these images');
      renderChatInput();
      await settle();
      expect(container?.querySelector('.chat-attachment-chip.clickable')).not.toBeNull();
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
      ).toBe(false);

      const visionModel = { providerID: 'vision-provider', modelID: 'viewer' };
      if (switchBeforeNewChat) setSelectedModel(visionModel);
      flushSolid();
      startNewChatDraft();
      flushSolid();
      if (!switchBeforeNewChat) setSelectedModel(visionModel);
      await settle();

      expect(state.activeSessionId).toBeNull();
      expect(state.clipboardImages).toHaveLength(1);
      const imageChip = container?.querySelector<HTMLElement>('.chat-attachment-chip');
      expect(imageChip?.classList).toContain('clickable');
      imageChip?.click();
      await settle();
      expect(document.querySelector('.chat-image-preview-overlay')).not.toBeNull();
      expect(
        container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
      ).toBe(false);
    }
  );

  it.each([false, true])(
    'keeps an in-flight image decode through New Chat (switch to vision first: %s)',
    async (switchBeforeNewChat) => {
      const analysis = vi
        .spyOn(imageCompression, 'analyzeImageCompression')
        .mockResolvedValue(null);
      const decodes: Array<() => void> = [];
      vi.mocked(imageLoading.loadImage).mockImplementation(
        () => new Promise((resolve) => decodes.push(() => resolve(document.createElement('img'))))
      );
      try {
        setupVisionDelegationModelState();
        setStateAndFlush('activeSessionId', 'session-1');
        setStateAndFlush('messages', [historyEntry('existing-user', 'An existing conversation')]);
        setStateAndFlush('clipboardImages', [
          {
            id: 'pending-carried-image',
            url: 'data:image/png;base64,aW1hZ2U=',
            mime: 'image/png',
            filename: 'Image 1',
            size: 5,
          },
        ]);
        setInputTextAndFlush('Describe these images');
        renderChatInput();
        await settle();
        expect(decodes).toHaveLength(1);

        const visionModel = { providerID: 'vision-provider', modelID: 'viewer' };
        if (switchBeforeNewChat) setSelectedModel(visionModel);
        flushSolid();
        startNewChatDraft();
        flushSolid();
        if (!switchBeforeNewChat) setSelectedModel(visionModel);
        await settle();
        expect(container?.querySelector('.chat-attachment-chip.clickable')).toBeNull();
        expect(
          container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
        ).toBe(false);
        decodes[0]!();
        await flushAsyncWork();
        flushSolid();

        expect(container?.querySelector('.chat-attachment-chip.clickable')).not.toBeNull();
        expect(
          container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
        ).toBe(false);
        expect(decodes).toHaveLength(1);
      } finally {
        analysis.mockRestore();
      }
    }
  );

  it.each(['remove', 'store'] as const)(
    'does not restart another image decode when a prepared image changes: %s',
    async (change) => {
      const analysis = vi
        .spyOn(imageCompression, 'analyzeImageCompression')
        .mockResolvedValue(null);
      let finishDecode: (() => void) | undefined;
      let pendingDecodeCount = 0;
      vi.mocked(imageLoading.loadImage).mockImplementation((url) => {
        if (url.endsWith('ready')) return Promise.resolve(document.createElement('img'));
        pendingDecodeCount += 1;
        return new Promise((resolve) => {
          finishDecode = () => resolve(document.createElement('img'));
        });
      });
      try {
        setupModelState();
        setStateAndFlush(
          'clipboardImages',
          ['ready', 'pending'].map((name, index) => ({
            id: name,
            url: `data:image/png;base64,${name}`,
            mime: 'image/png',
            filename: `Image ${index + 1}`,
            size: 5,
          }))
        );
        setInputTextAndFlush('Describe the images');
        renderChatInput();
        await settle();
        const originalDecode = finishDecode;
        if (change === 'remove') {
          setStateAndFlush('clipboardImages', (images) =>
            images.filter((image) => image.id !== 'ready')
          );
        } else {
          setState(
            storePath('clipboardImages', 0, 'contextFile', {
              path: '/repo/ready.png',
              relativePath: 'ready.png',
              type: 'file',
            })
          );
          flushSolid();
        }
        await settle();
        originalDecode?.();
        await flushAsyncWork();
        flushSolid();

        expect(pendingDecodeCount).toBe(1);
        expect(container?.querySelectorAll('.chat-attachment-chip.clickable')).toHaveLength(
          change === 'remove' ? 1 : 2
        );
        expect(
          container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]')?.disabled
        ).toBe(false);
      } finally {
        analysis.mockRestore();
      }
    }
  );

  it.each(['image first', 'mention first'])(
    'retains an image and mention-only file attachment when %s completes',
    async (completionOrder) => {
      const fileReader = installControllableFileReader();
      flushSolid();
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
        setStateAndFlush('editorContext', idleEditorContext('/repo'));
        renderChatInput();
        await settle();

        const editor = focusComposer();
        setCollapsedSelection(editor, 0);
        flushSolid();
        dispatchImagePaste(
          editor,
          [new File(['mention'], 'mention.png', { type: 'image/png' })],
          '@README.md'
        );
        flushSolid();

        const completeImage = () => fileReader.resolve('mention.png');
        const completeMention = () =>
          resolveLookup?.({ path: '/repo/README.md', relativePath: 'README.md', type: 'file' });
        if (completionOrder === 'image first') {
          completeImage();
          await flushAsyncWork();
          flushSolid();
          completeMention();
        } else {
          completeMention();
          await flushAsyncWork();
          flushSolid();
          completeImage();
        }
        await settle();

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
        flushSolid();
      }
    }
  );

  it('keeps an image and stripped context reference in one undoable paste transaction', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('editorContext', idleEditorContext('/repo'));
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();
      dispatchImagePaste(
        editor,
        [new File(['context'], 'context.png', { type: 'image/png' })],
        'Inspect this\n[Selection from src/app.ts lines 3-5]'
      );
      flushSolid();
      fileReader.resolve('context.png');
      await settle();

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
      flushSolid();
      expect(inputText()).toBe('');
      expect(state.droppedFiles).toEqual([]);
      expect(state.clipboardImages).toEqual([]);
    });
  });

  it.each([
    { label: 'source order', probeLaterRead: false },
    { label: 'reverse order', probeLaterRead: true },
  ])(
    'keeps overlapping mixed pastes ordered and independently undoable in $label',
    async ({ probeLaterRead }) => {
      await withControllableFileReader(async (fileReader) => {
        renderChatInput();
        await settle();

        const editor = focusComposer();
        setCollapsedSelection(editor, 0);
        flushSolid();

        dispatchImagePaste(
          editor,
          [new File(['first'], 'first-mixed.png', { type: 'image/png' })],
          'First'
        );
        flushSolid();
        await Promise.resolve();
        flushSolid();
        if (!editor.firstChild) throw new Error('Expected first pasted text');
        setCollapsedSelection(editor.firstChild, inputText().length);
        flushSolid();
        dispatchImagePaste(
          editor,
          [new File(['second'], 'second-mixed.png', { type: 'image/png' })],
          ' Second'
        );
        flushSolid();

        if (probeLaterRead) expect(fileReader.hasPending('second-mixed.png')).toBe(false);
        fileReader.resolve('first-mixed.png');
        await settle();
        fileReader.resolve('second-mixed.png');
        await settle();

        expect(inputText()).toBe('First [Image 1] Second [Image 2]');
        expect(
          state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
        ).toEqual([
          { filename: 'Image 1', url: 'data:image/png;base64,first-mixed.png' },
          { filename: 'Image 2', url: 'data:image/png;base64,second-mixed.png' },
        ]);

        pressKey(editor, { key: 'z', metaKey: true });
        flushSolid();
        expect(inputText()).toBe('First [Image 1]');
        expect(state.clipboardImages).toEqual([
          expect.objectContaining({ url: 'data:image/png;base64,first-mixed.png' }),
        ]);

        pressKey(editor, { key: 'z', metaKey: true });
        flushSolid();
        expect(inputText()).toBe('');
        expect(state.clipboardImages).toEqual([]);
      });
    }
  );

  it('undoes mixed pasted text, image, and placeholder as one composer edit', async () => {
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();
      dispatchImagePaste(
        editor,
        [new File(['image'], 'undo-mixed.png', { type: 'image/png' })],
        'Pasted description'
      );
      flushSolid();
      fileReader.resolve('undo-mixed.png');
      await settle();

      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(state.clipboardImages).toHaveLength(1);

      pressKey(editor, { key: 'z', metaKey: true });
      flushSolid();
      expect(inputText()).toBe('');
      expect(state.clipboardImages).toEqual([]);

      pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
      flushSolid();
      expect(inputText()).toBe('Pasted description [Image 1]');
      expect(state.clipboardImages).toHaveLength(1);
    });
  });

  it('keeps mixed-paste text when the clipboard image is null', async () => {
    renderChatInput();
    await settle();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchImagePaste(editor, [null], 'Text from a null image paste');
    await settle();

    expect(inputText()).toBe('Text from a null image paste');
    expect(state.clipboardImages).toEqual([]);
  });

  it('keeps mixed-paste text when the clipboard image is oversized', async () => {
    renderChatInput();
    await settle();

    const oversized = new File([new Uint8Array(MAX_CLIPBOARD_IMAGE_SIZE + 1)], 'oversized.png', {
      type: 'image/png',
    });
    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchImagePaste(editor, [oversized], 'Text from an oversized image paste');
    await settle();

    expect(inputText()).toBe('Text from an oversized image paste');
    expect(state.clipboardImages).toEqual([]);
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Images must be 5 MB or smaller',
      'warning'
    );
  });

  it('keeps mixed-paste text when the clipboard image cannot be read', async () => {
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();

      dispatchImagePaste(
        editor,
        [new File(['broken'], 'unreadable.png', { type: 'image/png' })],
        'Text from an unreadable image paste'
      );
      flushSolid();
      fileReader.reject('unreadable.png');
      await settle();

      expect(inputText()).toBe('Text from an unreadable image paste');
      expect(state.clipboardImages).toEqual([]);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'Could not read the pasted image',
        'warning'
      );
    });
  });

  it('keeps mixed-paste text when the clipboard image is rejected as a duplicate', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('clipboardImages', [
        {
          id: 'existing-image',
          url: 'data:image/png;base64,duplicate.png',
          mime: 'image/png',
          filename: 'Existing',
          size: 1,
        },
      ]);
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();

      dispatchImagePaste(
        editor,
        [new File(['duplicate'], 'duplicate.png', { type: 'image/png' })],
        'Text from a rejected image paste'
      );
      flushSolid();
      fileReader.resolve('duplicate.png');
      await settle();

      expect(inputText()).toBe('Text from a rejected image paste');
      expect(state.clipboardImages.map((image) => image.id)).toEqual(['existing-image']);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        'This image is already attached',
        'warning',
        container?.querySelector('.chat-input-shell')
      );
    });
  });

  it('keeps mixed-paste text when clipboard image capacity is full', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush(
        'clipboardImages',
        Array.from({ length: MAX_CLIPBOARD_IMAGES }, (_, index) => ({
          id: `existing-${index}`,
          url: `data:image/png;base64,existing-${index}`,
          mime: 'image/png',
          filename: `Existing ${index}`,
          size: 1,
        }))
      );
      renderChatInput();
      await settle();

      const editor = focusComposer();
      setCollapsedSelection(editor, 0);
      flushSolid();

      dispatchImagePaste(
        editor,
        [new File(['extra'], 'capacity.png', { type: 'image/png' })],
        'Text at image capacity'
      );
      flushSolid();
      expect(fileReader.hasPending('capacity.png')).toBe(false);
      await flushAsyncWork();
      flushSolid();

      expect(inputText()).toBe('Text at image capacity');
      expect(state.clipboardImages).toHaveLength(MAX_CLIPBOARD_IMAGES);
      expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
        `You can attach up to ${MAX_CLIPBOARD_IMAGES} images`,
        'warning'
      );
    });
  });

  it('rejects oversized clipboard images before reading them', async () => {
    renderChatInput();
    await settle();

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
    await settle();

    expect(readSpy).not.toHaveBeenCalled();
    expect(state.clipboardImages).toEqual([]);
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Images must be 5 MB or smaller',
      'warning'
    );
  });

  it('combines multiple image paste rejection reasons into one notification', async () => {
    renderChatInput();
    await settle();

    const oversized = new File([new Uint8Array(MAX_CLIPBOARD_IMAGE_SIZE + 1)], 'large.png', {
      type: 'image/png',
    });
    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!editor) throw new Error('Expected composer editor');

    dispatchImagePaste(editor, [oversized, null]);
    await settle();

    expect(showSessionActionFeedbackMock).toHaveBeenCalledOnce();
    expect(showSessionActionFeedbackMock).toHaveBeenCalledWith(
      'Some images were not pasted: larger than 5 MB, could not be read',
      'warning'
    );
  });

  it('revalidates the composer owner before committing staged pasted images', async () => {
    await withControllableFileReader(async (fileReader) => {
      setStateAndFlush('activeSessionId', 'session-a');
      setInputTextAndFlush('draft');
      renderChatInput();
      await settle();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');

      dispatchImagePaste(editor, [new File(['a'], 'session.png', { type: 'image/png' })]);
      flushSolid();
      setStateAndFlush('activeSessionId', 'session-b');
      fileReader.resolve('session.png');
      await settle();
      expect(state.clipboardImages).toEqual([]);

      dispatchImagePaste(editor, [new File(['b'], 'mutation.png', { type: 'image/png' })]);
      flushSolid();
      setInputTextAndFlush('draft');
      fileReader.resolve('mutation.png');
      await settle();
      expect(state.clipboardImages).toEqual([]);

      dispatchImagePaste(editor, [new File(['c'], 'value.png', { type: 'image/png' })]);
      flushSolid();
      setInputTextAndFlush('');
      fileReader.resolve('value.png');
      await settle();
      expect(state.clipboardImages).toEqual([]);

      setInputTextAndFlush('send draft');
      sendMessageMock.mockResolvedValueOnce(true);
      dispatchImagePaste(editor, [new File(['d'], 'send.png', { type: 'image/png' })]);
      flushSolid();
      pressKey(editor, { key: 'Enter' });
      await settle();
      expect(inputText()).toBe('');
      fileReader.resolve('send.png');
      await settle();
      expect(state.clipboardImages).toEqual([]);
    });
  });

  it('stages later image pastes until earlier reads finish, then applies live capacity', async () => {
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();

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
      flushSolid();
      dispatchImagePaste(editor, secondPaste);
      flushSolid();

      expect(fileReader.hasPending(secondPaste[0]!.name)).toBe(false);
      expect(state.clipboardImages).toEqual([]);

      for (const file of firstPaste) fileReader.resolve(file.name);
      await flushAsyncWork();
      flushSolid();
      expect(state.clipboardImages).toHaveLength(firstPaste.length);
      for (const file of secondPaste.slice(0, MAX_CLIPBOARD_IMAGES - firstPaste.length)) {
        fileReader.resolve(file.name);
        flushSolid();
      }
      expect(fileReader.hasPending(secondPaste.at(-1)!.name)).toBe(false);
      await flushAsyncWork();
      flushSolid();

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
    });
  });

  it('sends one host snapshot for a multi-image paste transaction', async () => {
    const fileReader = installControllableFileReader();
    flushSolid();
    const sent: WebviewMessage[] = [];
    const bridgeWindow = fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window);
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    try {
      renderChatInput();
      await settle();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      const images = ['first.png', 'second.png', 'third.png'].map(
        (name) => new File([name], name, { type: 'image/png' })
      );

      dispatchImagePaste(editor, images);
      flushSolid();
      for (const image of images) fileReader.resolve(image.name);
      await flushAsyncWork();
      flushSolid();

      const updates = sent.filter((message) => message.type === 'composer/images-update');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ payload: { images: expect.any(Array) } });
      if (updates[0]?.type === 'composer/images-update') {
        expect(updates[0].payload.images).toHaveLength(3);
      }
    } finally {
      fileReader.restore();
      flushSolid();
    }
  });

  it('bounds concurrent pasted-image decodes', async () => {
    const fileReader = installControllableFileReader();
    flushSolid();
    const decodeReleases: Array<() => void> = [];
    let activeDecodes = 0;
    let peakDecodes = 0;
    class ControlledImage {
      src = '';
      naturalWidth = 100;
      naturalHeight = 100;

      decode() {
        activeDecodes += 1;
        peakDecodes = Math.max(peakDecodes, activeDecodes);
        return new Promise<void>((resolve) => {
          decodeReleases.push(() => {
            activeDecodes -= 1;
            resolve();
          });
        });
      }
    }
    vi.stubGlobal('Image', ControlledImage);
    try {
      renderChatInput();
      await settle();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      const images = ['first.png', 'second.png', 'third.png'].map(
        (name) => new File([name], name, { type: 'image/png' })
      );

      dispatchImagePaste(editor, images);
      flushSolid();
      const unresolved = new Set(images.map((image) => image.name));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        for (const filename of unresolved) {
          if (!fileReader.hasPending(filename)) continue;
          fileReader.resolve(filename);
          flushSolid();
          unresolved.delete(filename);
          flushSolid();
        }
        await flushAsyncWork();
        flushSolid();
        decodeReleases.shift()?.();
        await flushAsyncWork();
        flushSolid();
        if (unresolved.size === 0 && activeDecodes === 0) break;
      }

      expect(unresolved.size).toBe(0);
      expect(activeDecodes).toBe(0);
      expect(peakDecodes).toBeLessThanOrEqual(2);
      expect(state.clipboardImages).toHaveLength(3);
    } finally {
      fileReader.restore();
      flushSolid();
      vi.unstubAllGlobals();
    }
  });

  it('commits overlapping image-only pastes into a non-empty composer in source order', async () => {
    await withControllableFileReader(async (fileReader) => {
      setInputTextAndFlush('Review this');
      renderChatInput();
      await settle();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, 'Review this'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
      flushSolid();

      dispatchImagePaste(editor, [new File(['a'], 'first.png', { type: 'image/png' })]);
      flushSolid();
      dispatchImagePaste(editor, [new File(['b'], 'second.png', { type: 'image/png' })]);
      flushSolid();

      expect(fileReader.hasPending('second.png')).toBe(false);
      expect(inputText()).toBe('Review this');
      expect(state.clipboardImages).toEqual([]);

      fileReader.resolve('first.png');
      await settle();
      expect(inputText()).toBe('Review this [Image 1]');
      fileReader.resolve('second.png');
      await settle();

      expect(inputText()).toBe('Review this [Image 1] [Image 2]');
      expect(
        state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
      ).toEqual([
        { filename: 'Image 1', url: 'data:image/png;base64,first.png' },
        { filename: 'Image 2', url: 'data:image/png;base64,second.png' },
      ]);
      expect(nextPastedImageIndex()).toBe(3);
    });
  });

  it('admits a later paste after duplicate images release capacity', async () => {
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');
      const duplicates = Array.from(
        { length: MAX_CLIPBOARD_IMAGES },
        (_, index) => new File([String(index)], `duplicate-${index}.png`, { type: 'image/png' })
      );

      dispatchImagePaste(editor, duplicates);
      flushSolid();
      dispatchImagePaste(editor, [new File(['later'], 'later.png', { type: 'image/png' })]);
      flushSolid();
      expect(fileReader.hasPending('later.png')).toBe(false);

      for (const file of duplicates) fileReader.resolve(file.name, 'same-content');
      await flushAsyncWork();
      flushSolid();
      expect(state.clipboardImages).toHaveLength(1);
      expect(fileReader.hasPending('later.png')).toBe(true);

      fileReader.resolve('later.png');
      await settle();
      expect(state.clipboardImages.map((image) => image.url)).toEqual([
        'data:image/png;base64,same-content',
        'data:image/png;base64,later.png',
      ]);
    });
  });

  it('releases ordered paste admission when a file read stalls', async () => {
    vi.useFakeTimers();
    await withControllableFileReader(async (fileReader) => {
      renderChatInput();
      await settle();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      if (!editor) throw new Error('Expected composer editor');

      dispatchImagePaste(editor, [new File(['stalled'], 'stalled.png', { type: 'image/png' })]);
      flushSolid();
      dispatchImagePaste(editor, [new File(['later'], 'later.png', { type: 'image/png' })]);
      flushSolid();
      expect(fileReader.hasPending('later.png')).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(fileReader.hasPending('stalled.png')).toBe(false);
      expect(fileReader.hasPending('later.png')).toBe(true);

      fileReader.resolve('later.png');
      await settle();
      expect(state.clipboardImages).toEqual([
        expect.objectContaining({ url: 'data:image/png;base64,later.png' }),
      ]);
    });
  });

  it('pastes images at the live selection on the first line', async () => {
    await withControllableFileReader(async (fileReader) => {
      const draft = 'First line\nSecond line';
      setInputTextAndFlush(draft);
      renderChatInput();
      await settle();

      const editor = focusPopulatedComposer();
      setCollapsedSelection(editor.firstChild, 'First line'.length);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
      flushSolid();
      setCollapsedSelection(editor.firstChild, 0);
      flushSolid();

      dispatchImagePaste(editor, [
        new File(['a'], 'first.png', { type: 'image/png' }),
        new File(['b'], 'second.png', { type: 'image/png' }),
      ]);
      flushSolid();
      fileReader.resolve('first.png');
      flushSolid();
      fileReader.resolve('second.png');
      await settle();

      expect(inputText()).toBe('[Image 1] [Image 2] First line\nSecond line');
      expect(
        state.clipboardImages.map((image) => ({ filename: image.filename, url: image.url }))
      ).toEqual([
        { filename: 'Image 1', url: 'data:image/png;base64,first.png' },
        { filename: 'Image 2', url: 'data:image/png;base64,second.png' },
      ]);
    });
  });

  it('pastes an image after an inline image chip without adding a newline', async () => {
    await withControllableFileReader(async (fileReader) => {
      addClipboardImage({
        id: 'existing-image',
        url: 'data:image/png;base64,existing',
        mime: 'image/png',
        filename: 'Image 1',
        size: 8,
      });
      flushSolid();
      setInputTextAndFlush('sdsds [Image 1] ');
      renderChatInput();
      await settle();

      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      const chip = editor?.querySelector<HTMLElement>('[data-chip-type="image"]');
      const trailingSpacer = chip?.nextSibling;
      if (!editor || trailingSpacer?.nodeType !== Node.TEXT_NODE) {
        throw new Error('Expected inline image chip with a trailing caret spacer');
      }
      editor.focus();
      flushSolid();
      setCollapsedSelection(trailingSpacer, 1);
      flushSolid();
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
      flushSolid();

      dispatchImagePaste(editor, [new File(['next'], 'next.png', { type: 'image/png' })], '\n');
      flushSolid();
      fileReader.resolve('next.png');
      await settle();

      expect(inputText()).toBe('sdsds [Image 1] [Image 2] ');
      expect(editor.querySelectorAll('br')).toHaveLength(0);
      const pastedChip = Array.from(
        editor.querySelectorAll<HTMLElement>('[data-chip-type="image"]')
      ).at(-1);
      expect(pastedChip?.nextSibling?.textContent).toBe('\u200B ');
    });
  });

  it('keeps a mention-only paste as text when the mention does not resolve', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@scope/package');
    await settle();

    expect(state.droppedFiles).toEqual([]);
    expect(inputText()).toBe('@scope/package');
  });

  it('keeps a mention-only paste when the user typed inside it before it resolved', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = focusComposer();
    setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, '@README.md');
    flushSolid();
    setInputText('@READ-edited-ME.md');
    await settle();

    expect(inputText()).toBe('@READ-edited-ME.md');
    expect(state.droppedFiles).toEqual([]);
  });

  it('keeps unresolved scoped package names as plain pasted text', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    flushSolid();
    if (editor) setCollapsedSelection(editor, 0);
    flushSolid();

    dispatchTextPaste(editor, 'Use npx @scope/package init');
    await settle();

    expect(state.droppedFiles).toEqual([]);
    expect(inputText()).toBe('Use npx @scope/package init');
    expect(client.varro.resolveWorkspacePath).toHaveBeenCalledWith('scope/package');
  });

  it('strips pasted context reference lines while restoring them as attachments', async () => {
    setStateAndFlush('editorContext', idleEditorContext('/repo'));

    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    expect(editor).not.toBeNull();

    editor?.focus();
    flushSolid();
    if (editor) setCollapsedSelection(editor, 0);
    flushSolid();

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
    await settle();

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
    setStateAndFlush('clipboardImages', [
      {
        id: 'img-1',
        url: 'data:image/png;base64,abc',
        mime: 'image/png',
        filename: 'Image',
        size: 12,
      },
    ]);
    setInputTextAndFlush('[Image]');

    renderChatInput();
    await settle();

    expect(container?.querySelector('.rich-composer .inline-chip')).not.toBeNull();
    expect(container?.querySelector('.rich-composer .inline-chip-remove')).toBeNull();
  });

  it('does not reserve an empty attachment row for inline active-file context', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        language: 'typescript',
      },
      selection: null,
      diagnostics: [],
    });
    addContextFile({ path: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'file' });
    flushSolid();
    setInputTextAndFlush('@src/app.ts');

    renderChatInput();
    await settle();

    expect(container?.querySelector('.rich-composer .inline-chip')).not.toBeNull();
    expect(container?.querySelector('.chat-attachments-container')).toBeNull();
  });

  it('hides an active selection attachment when the same file and lines are inline', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/CHANGELOG.md',
        relativePath: 'CHANGELOG.md',
        language: 'markdown',
      },
      selection: { startLine: 23, endLine: 24 },
      diagnostics: [],
    });
    addContextFile({
      path: '/repo/CHANGELOG.md',
      relativePath: 'CHANGELOG.md',
      type: 'file',
      lineRanges: [{ startLine: 23, endLine: 24 }],
    });
    flushSolid();
    setInputTextAndFlush('Test message @CHANGELOG.md');

    renderChatInput();
    await settle();

    expect(
      container?.querySelector('.rich-composer [data-chip-type="mention-file"]')?.textContent
    ).toContain('L23-24');
    expect(container?.querySelector('.chat-attachments-container')).toBeNull();
    expect(state.droppedFiles).toHaveLength(1);
  });

  it('keeps active selection context when its lines differ from the inline file range', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: {
        path: '/repo/CHANGELOG.md',
        relativePath: 'CHANGELOG.md',
        language: 'markdown',
      },
      selection: { startLine: 25, endLine: 26 },
      diagnostics: [],
    });
    addContextFile({
      path: '/repo/CHANGELOG.md',
      relativePath: 'CHANGELOG.md',
      type: 'file',
      lineRanges: [{ startLine: 23, endLine: 24 }],
    });
    flushSolid();
    setInputTextAndFlush('Test message @CHANGELOG.md');

    renderChatInput();
    await settle();

    expect(
      container?.querySelector('.rich-composer [data-chip-type="mention-file"]')?.textContent
    ).toContain('L23-24');
    expect(container?.querySelector('.chat-attachments-container')?.textContent).toContain(
      'L25-26'
    );
  });

  it('renders an inline table attachment without exposing the snapshot filename', async () => {
    addContextFile({
      path: '/snapshots/users-context.json',
      relativePath: 'users-context.json',
      type: 'file',
      database: {
        name: 'users',
        dataSource: 'Demo SQLite',
        scope: 'selected-rows',
        rowCount: 2,
        selectedRowCount: 2,
        truncated: false,
        pendingChanges: false,
        cellEditing: false,
      },
    });
    flushSolid();
    setInputTextAndFlush('@users-context.json');
    renderChatInput();
    await settle();
    const chip = container?.querySelector('.rich-composer .inline-chip');
    expect(chip?.textContent).toContain('users');
    expect(chip?.textContent).toContain('2 rows');
    expect(chip?.textContent).not.toContain('context.json');
    expect(
      chip?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(getMaterialChipIcon('table')));
  });

  it('shows a DDL editor as table context without a local file', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
      databaseContext: {
        name: 'users',
        dataSource: 'Demo SQLite',
        dialect: 'SQLite',
        filter: '',
        columns: [],
        rows: [],
        selectedRowCount: 0,
        scope: 'ddl',
        ddl: 'create table users (id INT primary key);',
        pendingChanges: false,
        cellEditing: false,
        pageStart: 0,
        truncated: false,
      },
    });
    renderChatInput();
    await settle();
    const chip = container?.querySelector('.chat-attachments-container .chat-attachment-chip');
    expect(chip?.textContent).toContain('users');
    expect(chip?.textContent).toContain('DDL');
    expect(chip?.querySelector('[data-chip-icon="table"]')).not.toBeNull();
  });

  it('captures extension context when queueing and renders its fallback chip', async () => {
    const disposeHost = registerHostExtension({
      apiVersion: 1,
      id: 'example.host',
      contexts: [
        {
          id: 'example.selection',
          version: 1,
          validate: () => true,
          capture: () => ({ text: 'Captured selection', detail: 'Original source' }),
        },
      ],
    });
    try {
      setIsLoadingAndFlush(true);
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('editorContext', {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
        extensionContexts: [
          {
            provider: 'example.selection',
            version: 1,
            label: 'Issue 42',
            placement: 'replace-document',
            data: { revision: 1 },
          },
        ],
      });
      setInputTextAndFlush('Explain this');
      renderChatInput();
      expect(container?.querySelector('.chat-attachments-container')?.textContent).toContain(
        'Issue 42'
      );
      container?.querySelector<HTMLButtonElement>('[aria-label="Add to queue (Enter)"]')?.click();
      await settle();
      expect(
        state.queuedMessages[0]?.queuedContext?.editorContext.extensionContexts?.[0]?.captured?.text
      ).toBe('Captured selection');
      setState(
        storePath('editorContext', 'extensionContexts', [
          {
            provider: 'example.selection',
            version: 1,
            label: 'Issue 43',
            placement: 'replace-document',
            data: { revision: 2 },
          },
        ])
      );
      flushSolid();
      expect(
        state.queuedMessages[0]?.queuedContext?.editorContext.extensionContexts?.[0]?.label
      ).toBe('Issue 42');
      expect(container?.querySelector('.chat-queue-meta-item')?.getAttribute('aria-label')).toBe(
        '1 attachment'
      );
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
      disposeHost();
      flushSolid();
    }
  });

  it('shows database selection context and can disable it', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
      databaseContext: {
        name: 'public.orders',
        dataSource: 'local',
        dialect: 'PostgreSQL',
        filter: '',
        columns: [{ name: 'id', type: 'integer' }],
        rows: [['1']],
        selectedRowCount: 3,
        scope: 'selected-rows',
        pendingChanges: false,
        cellEditing: false,
        pageStart: 0,
        truncated: true,
      },
    });
    renderChatInput();
    await settle();
    const chip = container?.querySelector<HTMLButtonElement>(
      '.chat-attachments-container .chat-attachment-chip'
    );
    expect(chip?.textContent).toContain('public.orders');
    expect(chip?.textContent).toContain('1 of 3 rows; truncated');
    chip?.click();
    await settle();
    expect(chip?.title).toContain('database context is disabled');
  });

  it('shows captured context from an unsaved editor selection', async () => {
    setStateAndFlush('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: { startLine: 1, endLine: 3 },
      editorText: {
        kind: 'selection',
        path: null,
        relativePath: 'Untitled-1',
        language: 'markdown',
        range: { startLine: 1, endLine: 3 },
        text: '# Reproduction\nClick New Chat.\nReturn to the session.',
        truncated: false,
      },
      diagnostics: [],
    });

    renderChatInput();
    await settle();

    const chip = container?.querySelector('.chat-attachments-container .chat-attachment-chip');
    expect(chip?.textContent).toContain('Untitled-1');
    expect(chip?.textContent).toContain('L1-3');
  });

  it('updates the active Ralph run model and interrupts a usage-limit retry when switching models', async () => {
    const { ralphStore } = await import('../lib/stores/ralph-store');
    flushSolid();

    setStateAndFlush('activeSessionId', 'child-1');
    setStateAndFlush('sessions', [
      session('manager-1', 2_000),
      session('child-1', 2_100, { parentID: 'manager-1' }),
    ]);
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-4o', 'GPT-4o', { limit: { context: 1000, output: 1000 } }),
      ]),
      apiProvider('anthropic', 'Anthropic', [
        toolModel('claude', 'Claude', { limit: { context: 1000, output: 1000 } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setStateAndFlush('sessionStatus', {
      'child-1': { type: 'retry', attempt: 5, message: 'messages exhausted', next: 28 },
    });
    setStateAndFlush('sessionUsageLimits', {
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
    flushSolid();
    ralphStore.upsertIteration('manager-1', {
      index: 1,
      childSessionId: 'child-1',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });
    flushSolid();

    renderChatInput();

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    clickAndFlush(modelButton);
    await waitForDropdown();
    flushSolid();

    const claudeOption = dropdownItem('Claude');
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-4o', 'GPT-4o', { limit: { context: 1000, output: 1000 } }),
      ]),
      apiProvider('anthropic', 'Anthropic', [
        toolModel('claude', 'Claude', { limit: { context: 1000, output: 1000 } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-4o', anthropic: 'claude' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    setStateAndFlush('sessionStatus', {
      'child-1': { type: 'retry', attempt: 9, message: 'messages exhausted', next: 408 },
    });
    setStateAndFlush('sessionUsageLimits', {
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

    renderChatInput();

    expect(container?.textContent).toContain('Usage limit reached');

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    clickAndFlush(modelButton);
    await waitForDropdown();
    flushSolid();

    const claudeOption = dropdownItem('Claude');
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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

    renderChatInput();

    const switchProviderButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Switch provider');
    clickAndFlush(switchProviderButton);
    await waitForDropdown();
    flushSolid();

    const claudeOption = dropdownItem('Claude');
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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

    renderChatInput();

    const switchProviderButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Switch provider');
    clickAndFlush(switchProviderButton);
    await waitForDropdown();
    flushSolid();

    const claudeOption = dropdownItem('Claude');
    claudeOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_100, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('sessionUsageLimits', {
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
    setInputTextAndFlush('continue');

    renderChatInput();

    expect(container?.textContent).toContain('Usage limit reached');

    const sendButton = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    sendButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('continue', { noReply: false });
    expect(state.sessionUsageLimits['child-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('continues from the usage-limit banner and closes the notice', async () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('sessionUsageLimits', {
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

    renderChatInput();

    const continueButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Continue');
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(sendMessageMock).toHaveBeenCalledWith('Continue', { noReply: false });
    expect(state.sessionUsageLimits['session-1']).toBeUndefined();
    expect(container?.textContent).not.toContain('Usage limit reached');
  });

  it('renders and opens a safe structured retry action through the extension bridge', () => {
    setupModelState();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('sessionUsageLimits', {
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
      renderChatInput();

      expect(container?.textContent).toContain('Add credits to continue');
      expect(container?.textContent).toContain('Your OpenAI balance is empty.');
      expect(container?.textContent).toContain('request throttled · retry in');
      expect(container?.textContent).toContain('attempt #4');

      const actionButton = Array.from(
        container!.querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent === 'Manage billing');
      clickAndFlush(actionButton);

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
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('sessionUsageLimits', {
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

    renderChatInput();

    expect(container?.textContent).toContain('Add credits to continue');
    expect(container?.textContent).toContain('Your balance is empty.');
    expect(
      Array.from(container!.querySelectorAll('button')).some(
        (button) => button.textContent === 'Manage billing'
      )
    ).toBe(false);
  });

  it('restores reasoning selections per model instead of carrying them across models', async () => {
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-5.4', 'GPT-5.4', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, medium: {}, high: {} },
        }),
        toolModel('gpt-5.5', 'GPT-5.5', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, medium: {}, high: {} },
        }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-5.4' });
    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
    setStateAndFlush('modelVariantSelections', { 'openai:gpt-5.4': 'medium' });

    renderChatInput();

    const modelButton = container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    clickAndFlush(modelButton);
    await waitForDropdown();
    flushSolid();

    const gpt55Option = dropdownItem('GPT-5.5');
    gpt55Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: undefined,
    });

    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'high',
    });
    setStateAndFlush('modelVariantSelections', {
      'openai:gpt-5.4': 'medium',
      'openai:gpt-5.5': 'high',
    });

    clickAndFlush(modelButton);
    await waitForDropdown();
    flushSolid();

    const gpt54Option = dropdownItem('GPT-5.4');
    gpt54Option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
  });

  it('shows Default for a session without reasoning despite a remembered variant', () => {
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-5.4', 'GPT-5.4', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, medium: {}, high: {} },
        }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-5.4' });
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-5.4' });
    setStateAndFlush('sessionSelectedModels', {
      'session-1': { providerID: 'openai', modelID: 'gpt-5.4' },
    });
    setStateAndFlush('modelVariantSelections', { 'openai:gpt-5.4': 'high' });

    renderChatInput();

    expect(
      container?.querySelector<HTMLButtonElement>('button[aria-label="Thinking level"]')
        ?.textContent
    ).toContain('Default');
  });

  it.each([undefined, '', 'default'])(
    'does not warn for an unchanged default variant %j',
    (variant) => {
      setStateAndFlush('providers', [
        apiProvider('meta', 'Meta', [
          toolModel('muse-1.3c', 'Muse 1.3c', {
            capabilities: { toolcall: true, reasoning: true },
            variants: { '': {}, high: {} },
          }),
        ]),
      ]);
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('selectedModel', { providerID: 'meta', modelID: 'muse-1.3c' });
      const response = assistantMessageEntry({ input: 400, output: 100 });
      setStateAndFlush('messages', [
        {
          ...response,
          info: { ...response.info, providerID: 'meta', modelID: 'muse-1.3c', variant },
        },
      ]);

      renderChatInput();

      expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();

      setStateAndFlush('selectedModel', {
        providerID: 'meta',
        modelID: 'muse-1.3c',
        variant: 'high',
      });
      expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
    }
  );

  it.each(['model', 'reasoning'] as const)(
    'does not flash a switch warning while sent %s metadata is incomplete',
    (missingMetadata) => {
      const model = { providerID: 'openai', modelID: 'gpt-5.4', variant: 'high' };
      setStateAndFlush('providers', [
        apiProvider('openai', 'OpenAI', [
          toolModel('gpt-5.4', 'GPT-5.4', {
            capabilities: { toolcall: true, reasoning: true },
            variants: { low: {}, high: {} },
          }),
        ]),
      ]);
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('selectedModel', model);
      const previousResponse = assistantMessageEntry({ input: 400, output: 100 });
      setStateAndFlush('messages', [
        { ...previousResponse, info: { ...previousResponse.info, ...model } },
      ]);
      renderChatInput();
      const expectNoWarning = () =>
        expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();
      expectNoWarning();

      // Publish the optimistic send, then deliver canonical metadata and status separately.
      const prompt: UserMessage = {
        id: 'user-next',
        sessionID: 'session-1',
        role: 'user',
        time: { created: 3_000 },
        agent: 'build',
        model,
      };
      upsertMessageInfo(prompt);
      flushSolid();
      expectNoWarning();
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      expectNoWarning();
      if (missingMetadata === 'model') {
        upsertMessageInfo({
          ...prompt,
          model: { providerID: '', modelID: '' },
        });
        flushSolid();
        expectNoWarning();
        upsertMessageInfo(prompt);
        flushSolid();
        expectNoWarning();
      }
      flushSolid();
      const response: AssistantMessage = {
        ...previousResponse.info,
        ...model,
        id: 'assistant-next',
        parentID: prompt.id,
        variant: missingMetadata === 'reasoning' ? undefined : model.variant,
      };
      upsertMessageInfo(response);
      flushSolid();
      expectNoWarning();
      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      expectNoWarning();
      upsertMessageInfo({ ...response, variant: model.variant });
      flushSolid();
      expectNoWarning();

      setStateAndFlush('selectedModel', { ...model, variant: 'low' });
      expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
    }
  );

  it('warns when the model or reasoning level changes after a session request', async () => {
    vi.useFakeTimers();
    setSessionUsageLimit('session-1', null);
    flushSolid();
    setSessionUsageLimit('child-1', null);
    flushSolid();
    setStateAndFlush('providers', [
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-5.4', 'GPT-5.4', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, medium: {}, high: {} },
        }),
        toolModel('gpt-5.5', 'GPT-5.5', {
          capabilities: { toolcall: true, reasoning: true },
          variants: { low: {}, high: {} },
        }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { openai: 'gpt-5.4' });
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [
      session('session-1', 2_000),
      session('child-1', 2_001, { parentID: 'session-1' }),
    ]);
    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
    const previousResponse = assistantMessageEntry({ input: 400, output: 100 });
    const childResponse = assistantMessageEntry({ input: 100, output: 20 });
    setStateAndFlush('messages', [
      {
        ...previousResponse,
        info: {
          ...previousResponse.info,
          modelID: 'gpt-5.4',
          variant: 'medium',
        },
      },
      {
        ...childResponse,
        info: {
          ...childResponse.info,
          id: 'assistant-child-1',
          sessionID: 'child-1',
          modelID: 'gpt-5.5',
          variant: 'low',
        },
      },
    ]);

    renderChatInput();

    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();

    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'high',
    });
    const warning = container?.querySelector<HTMLElement>('.model-selection-cost-warning');
    expect(warning).not.toBeNull();

    warning?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(0);
    flushSolid();
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.querySelector('.model-selection-cost-tooltip > span')?.textContent).toBe(
      'Switching the model or reasoning level mid-session may make this request more expensive.'
    );
    expect(tooltip?.querySelector('.model-selection-cost-tooltip-detail')?.textContent).toBe(
      'Current session: OpenAI / GPT-5.4 · Medium'
    );

    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' });
    expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();

    const modelButton = () => container?.querySelector<HTMLButtonElement>('.model-picker-btn');
    const reasoningButton = () =>
      container?.querySelector<HTMLButtonElement>('[aria-label="Thinking level"]');
    modelButton()?.click();
    flushSolid();
    await vi.waitFor(() => expect(container?.querySelector('.model-picker-anchor')).not.toBeNull());
    flushSolid();

    setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
    flushSolid();
    expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
    expect(modelButton()?.disabled).toBe(false);
    expect(reasoningButton()?.disabled).toBe(false);
    expect(container?.querySelector('.model-picker-anchor')).not.toBeNull();
    reasoningButton()?.click();
    flushSolid();
    expect(container?.querySelector('.model-picker-anchor')).toBeNull();
    expect(container?.querySelector('.variant-popover')).not.toBeNull();
    expect(state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variant: 'low',
    });

    setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
    flushSolid();
    expect(container?.querySelector('.model-selection-cost-warning')).not.toBeNull();
    expect(modelButton()?.disabled).toBe(false);
    expect(reasoningButton()?.disabled).toBe(false);
    expect(container?.querySelector('.variant-popover')).not.toBeNull();
    setState(storePath('sessionStatus', 'child-1', { type: 'busy' }));
    flushSolid();
    expect(modelButton()?.disabled).toBe(false);
    expect(reasoningButton()?.disabled).toBe(false);
    expect(container?.querySelector('.variant-popover')).not.toBeNull();
    setState(storePath('sessionStatus', 'child-1', { type: 'idle' }));
    flushSolid();

    setStateAndFlush('selectedModel', {
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: 'medium',
    });
    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();

    setStateAndFlush('messagesLoading', true);
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' });
    expect(container?.querySelector('.model-selection-cost-warning')).toBeNull();
  });

  it('keeps the usage-limit banner visible when a retry notice predates active-session model hydration', () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('providers', [
      apiProvider('copilot', 'GitHub Copilot', [
        toolModel('gpt-5-mini', 'GPT-5 mini', { limit: { context: 1000, output: 1000 } }),
      ]),
      apiProvider('openai', 'OpenAI', [
        toolModel('gpt-4.1', 'GPT-4.1', { limit: { context: 1000, output: 1000 } }),
      ]),
    ]);
    setStateAndFlush('providerDefaults', { copilot: 'gpt-5-mini' });
    setStateAndFlush('selectedModel', { providerID: 'openai', modelID: 'gpt-4.1' });
    setStateAndFlush('sessionStatus', {
      'session-1': {
        type: 'retry',
        attempt: 2,
        message: '429 usage limit reached. retry in 45s attempt #2',
        next: 45,
      },
    });
    setStateAndFlush('sessionUsageLimits', {
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
    setStateAndFlush('messages', [
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

    renderChatInput();

    expect(container?.textContent).toContain('Usage limit reached');
    expect(container?.textContent).toContain('Stop retrying');
    expect(container?.textContent).toContain('Switch provider');
  });

  it('shows a temporary service failure only from the fourth retry', () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('sessions', [session('session-1', 2_000)]);
    setStateAndFlush('sessionUsageLimits', {
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

    renderChatInput();
    expect(container?.textContent).not.toContain('Service temporarily unavailable');

    setState(storePath('sessionUsageLimits', 'session-1', 'attempt', 4));
    flushSolid();
    expect(container?.textContent).toContain('Service temporarily unavailable');
  });
});

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
  it.each(['loaded history', 'live messages'])(
    'does not recall generated follow-up prompts from %s as user input',
    (source) => {
      setStateAndFlush('activeSessionId', 'session-1');
      const followup = historyEntry('followup', 'Fix only the reported parser failures.');
      followup.info.followupTitle = 'Fix parser failures';
      const entries = [historyEntry('typed', 'Review the parser'), followup];
      if (source === 'loaded history') setSessionHistoryPrompts('session-1', entries);
      else setState(storePath('messages', entries));
      flushSolid();
      renderChatInput();
      const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
      pressKey(editor, { key: 'ArrowUp' });
      flushSolid();
      expect(inputText()).toBe('Review the parser');
    }
  );
  it.each(['loaded history', 'live messages'])('recalls only prompt text from %s', (source) => {
    setStateAndFlush('activeSessionId', 'session-1');
    const entry = historyEntry(
      'user-1',
      'Sync with latest Varro\n\n[Active file: src/main/resources/META-INF/plugin.xml]'
    );
    if (source === 'loaded history') setSessionHistoryPrompts('session-1', [entry]);
    else setState(storePath('messages', [entry]));
    flushSolid();
    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'ArrowUp' });
    flushSolid();
    expect(inputText()).toBe('Sync with latest Varro');
    expect(editor?.textContent).not.toContain('[Active file:');
    expect(entry.parts[0]?.text).toContain('[Active file:');

    pressKey(editor, { key: 'ArrowDown' });
    flushSolid();
    expect(inputText()).toBe('');
  });

  it('paginates through sent prompts with Up and returns with Down', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setSessionHistoryPrompts('session-1', [
      historyEntry('user-1', 'Earlier loaded prompt'),
      historyEntry('user-2', 'Most recent loaded prompt'),
    ]);
    flushSolid();
    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'ArrowUp' });
    flushSolid();
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowUp' });
    flushSolid();
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
    await settle();
    expect(inputText()).toBe('Oldest fetched prompt');

    pressKey(editor, { key: 'ArrowDown' });
    flushSolid();
    expect(inputText()).toBe('Earlier loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    flushSolid();
    expect(inputText()).toBe('Most recent loaded prompt');

    pressKey(editor, { key: 'ArrowDown' });
    flushSolid();
    expect(inputText()).toBe('');
  });

  it('undoes and redoes composer text edits with the keyboard', async () => {
    renderChatInput();
    setInputTextAndFlush('hello');
    setInputTextAndFlush('hello world');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    flushSolid();
    expect(inputText()).toBe('hello');
    editor?.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'historyUndo',
      })
    );
    flushSolid();
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'z', ctrlKey: true });
    flushSolid();
    expect(inputText()).toBe('');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    flushSolid();
    expect(inputText()).toBe('hello');

    pressKey(editor, { key: 'y', ctrlKey: true });
    flushSolid();
    expect(inputText()).toBe('hello world');
  });

  it('restores composer text after pasted content is undone', async () => {
    renderChatInput();
    setInputTextAndFlush('draft');
    setInputTextAndFlush('draft pasted block of text');

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    flushSolid();
    expect(inputText()).toBe('draft');

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    flushSolid();
    expect(inputText()).toBe('draft pasted block of text');
  });

  it('undoes and redoes attachment changes', async () => {
    renderChatInput();

    addContextFile({ path: '/repo/src/a.ts', relativePath: 'src/a.ts', type: 'file' });
    flushSolid();
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    removeContextFile('/repo/src/a.ts');
    flushSolid();
    expect(state.droppedFiles).toEqual([]);

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'z', metaKey: true });
    flushSolid();
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);

    pressKey(editor, { key: 'z', metaKey: true });
    flushSolid();
    expect(state.droppedFiles).toEqual([]);

    pressKey(editor, { key: 'z', metaKey: true, shiftKey: true });
    flushSolid();
    expect(state.droppedFiles.map((file) => file.path)).toEqual(['/repo/src/a.ts']);
  });

  it('does not stop the running session on Escape', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    setIsLoadingAndFlush(true);
    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'Escape' });
    await settle();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });

  it('closes a toolbar popup on Escape without leaking the shortcut', () => {
    setStateAndFlush('agents', [
      {
        name: 'plan',
        description: 'Draft implementation plans',
        mode: 'primary',
        builtIn: true,
        permission: [],
      },
    ]);
    renderChatInput();

    const agentButton = container?.querySelector<HTMLButtonElement>('[aria-label="Select agent"]');
    clickAndFlush(agentButton);
    expect(container?.querySelector('.agent-popover')).toBeInstanceOf(HTMLDivElement);

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    flushSolid();

    expect(event.defaultPrevented).toBe(true);
    expect(container?.querySelector('.agent-popover')).toBeNull();
  });

  it('does not stop anything on Escape while idle', async () => {
    setStateAndFlush('activeSessionId', 'session-1');
    renderChatInput();

    const editor = container?.querySelector<HTMLDivElement>('.rich-composer');
    pressKey(editor, { key: 'Escape' });
    await settle();

    expect(abortSessionMock).not.toHaveBeenCalled();
  });
});

describe('ChatInput agent model selection', () => {
  const GPT_4O = { providerID: 'openai', modelID: 'gpt-4o' };
  const LUNA = { providerID: 'openai', modelID: 'gpt-6-luna-fast' };

  function setupAgentModels() {
    setupModelState();
    setState(
      storePath('providers', 0, 'models', LUNA.modelID, toolModel(LUNA.modelID, 'GPT-6 Luna Fast'))
    );
    // Path writes merge objects; replace so a variant from an earlier test cannot leak in.
    setState((draft) => {
      draft.lastSelectedModel = { ...GPT_4O };
    });
    setState(storePath('modelVariantSelections', {}));
    setState(
      storePath('agents', [
        { name: 'build', mode: 'primary', builtIn: true, permission: [] },
        { name: 'plan', mode: 'primary', builtIn: true, permission: [], model: { ...LUNA } },
      ])
    );
    setState(storePath('selectedAgent', 'build'));
    flushSolid();
  }

  function pickAgent(label: string) {
    clickAndFlush(container?.querySelector('[aria-label="Select agent"]'));
    const option = [
      ...(container?.querySelectorAll<HTMLButtonElement>('.agent-popover .toolbar-popover-item') ??
        []),
    ].find((item) => item.querySelector('.agent-picker-option-label')?.textContent === label);
    expect(option).toBeDefined();
    clickAndFlush(option);
  }

  it.each(['plan', 'custom'])(
    'keeps the edited prompt agent %s through cancel and resend',
    async (agent) => {
      setupAgentModels();
      setStateAndFlush('activeSessionId', 'session-1');
      setStateAndFlush('agents', [
        ...state.agents,
        { name: 'custom', mode: 'primary', permission: [] },
      ]);
      const model = { ...GPT_4O };
      const message = userMessageEntry(model);
      setStateAndFlush('messages', [{ ...message, info: { ...message.info, agent } }]);
      renderChatInput();

      startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, model, agent);
      await settle();
      expect(container?.querySelector('[aria-label="Select agent"]')?.textContent).toContain(
        agent === 'plan' ? 'Plan' : 'Custom'
      );
      expect(state.selectedAgent).toBe('build');
      expect(state.selectedModel).toEqual(GPT_4O);

      clickSelectorAndFlush('[title="Cancel editing (Esc)"]');
      expect(container?.querySelector('[aria-label="Select agent"]')?.textContent).toContain(
        'Build'
      );
      expect(state.selectedAgent).toBe('build');

      startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, model, agent);
      await settle();
      pressKey(container?.querySelector('.rich-composer'), { key: 'Enter' });
      await settle();

      expect(editMessageMock).toHaveBeenCalledWith(
        'message-1',
        'edited prompt',
        expect.objectContaining({ selectedAgent: agent, selectedModel: model })
      );
      expect(state.selectedAgent).toBe(agent);
    }
  );

  it('allows explicitly changing the agent of an edited Plan prompt', async () => {
    setupAgentModels();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('selectedAgent', 'plan');
    setStateAndFlush('messages', [userMessageEntry(GPT_4O)]);
    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, GPT_4O, 'plan');
    await settle();

    pickAgent('Build');
    expect(container?.querySelector('[aria-label="Select agent"]')?.textContent).toContain('Build');
    expect(state.selectedAgent).toBe('plan');
    pressKey(container?.querySelector('.rich-composer'), { key: 'Enter' });
    await settle();

    expect(editMessageMock).toHaveBeenCalledWith(
      'message-1',
      'edited prompt',
      expect.objectContaining({ selectedAgent: 'build' })
    );
    expect(state.selectedAgent).toBe('build');
  });

  it('restores the edited agent when a published replacement fails to send', async () => {
    setupAgentModels();
    setStateAndFlush('activeSessionId', 'session-1');
    setStateAndFlush('messages', [userMessageEntry(GPT_4O)]);
    editMessageMock.mockImplementationOnce(async (_id, _text, options) => {
      options?.onOptimisticPublish?.();
      flushSolid();
      return false;
    });
    renderChatInput();
    startEditingMessage('message-1', 'session-1', 'edited prompt', undefined, GPT_4O, 'plan');
    await settle();
    pressKey(container?.querySelector('.rich-composer'), { key: 'Enter' });
    await settle();

    expect(editingMessage()?.agent).toBe('plan');
    expect(container?.querySelector('[aria-label="Select agent"]')?.textContent).toContain('Plan');
    expect(state.selectedAgent).toBe('build');
  });

  it('applies the agent model in a new chat without changing the remembered model', () => {
    setupAgentModels();
    renderChatInput();

    pickAgent('Plan');
    expect(state.selectedAgent).toBe('plan');
    expect(state.selectedModel).toEqual(LUNA);
    expect(state.lastSelectedModel).toEqual(GPT_4O);

    pickAgent('Build');
    expect(state.selectedAgent).toBe('build');
    expect(state.selectedModel).toEqual(GPT_4O);
  });

  it('applies the agent model to the session and restores the previous agent model', () => {
    setupAgentModels();
    setStateAndFlush('activeSessionId', 'agent-model-session');
    setSelectedModel({ ...GPT_4O }, { sessionId: 'agent-model-session', persistGlobal: false });
    flushSolid();
    const sendToExtension = vi.fn(defaultBridgeSend);
    fixture<{ __sendToExtension?: (message: WebviewMessage) => void }>(window).__sendToExtension =
      sendToExtension;
    renderChatInput();

    pickAgent('Plan');
    expect(state.sessionSelectedModels['agent-model-session']).toEqual(LUNA);
    expect(
      sendToExtension.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'session-model/update')?.payload.model
    ).toEqual(LUNA);
    expect(state.lastSelectedModel).toEqual(GPT_4O);

    pickAgent('Build');
    expect(state.sessionSelectedModels['agent-model-session']).toEqual(GPT_4O);
  });

  it('switches to Build with its model and inserts the prompt for a plan draft request', () => {
    setupAgentModels();
    setState(storePath('agents', 0, 'model', { ...GPT_4O }));
    setState(storePath('selectedAgent', 'plan'));
    setStateAndFlush('activeSessionId', 'plan-draft-session');
    setSelectedModel({ ...LUNA }, { sessionId: 'plan-draft-session', persistGlobal: false });
    flushSolid();
    renderChatInput();
    setInputText('Keep this note');
    flushSolid();

    requestPlanImplementationDraft('other-session', 'Wrong session');
    flushSolid();
    expect(state.selectedAgent).toBe('plan');

    requestPlanImplementationDraft('plan-draft-session', 'Implement the plan now.');
    flushSolid();
    expect(state.selectedAgent).toBe('build');
    expect(state.sessionSelectedModels['plan-draft-session']).toEqual(GPT_4O);
    expect(inputText()).toBe('Keep this note\n\nImplement the plan now.');
    expect(planImplementationDraftRequest()).toBeNull();

    pickAgent('Plan');
    expect(state.sessionSelectedModels['plan-draft-session']).toEqual(LUNA);
  });

  it('applies a new chat plan request on Build with its model', () => {
    setupAgentModels();
    setState(storePath('agents', 0, 'model', { ...GPT_4O }));
    setState(storePath('selectedAgent', 'plan'));
    setState(storePath('selectedModel', { ...LUNA }));
    flushSolid();
    renderChatInput();

    requestPlanImplementationDraft(null, 'session:ses_plan Implement it.');
    flushSolid();
    expect(state.selectedAgent).toBe('build');
    expect(state.selectedModel).toEqual(GPT_4O);
    expect(inputText()).toBe('session:ses_plan Implement it.');
    expect(planImplementationDraftRequest()).toBeNull();
  });

  it('attaches the plan text ahead of a new chat implementation prompt', () => {
    setupAgentModels();
    setState(storePath('droppedFiles', []));
    flushSolid();
    renderChatInput();

    requestPlanImplementationDraft(null, 'session:ses_plan Implement it.', {
      name: 'plan-1234.md',
      text: '# Plan\n1. Change it',
    });
    flushSolid();

    expect(inputText()).toBe('@plan-1234.md session:ses_plan Implement it.');
    expect(state.droppedFiles).toEqual([
      expect.objectContaining({ relativePath: 'plan-1234.md', pastedText: '# Plan\n1. Change it' }),
    ]);
  });

  it('ignores a plan request that outlived its composer switch', () => {
    vi.useFakeTimers();
    setupAgentModels();
    setState(storePath('selectedAgent', 'plan'));
    setStateAndFlush('activeSessionId', 'stale-plan-session');
    requestPlanImplementationDraft(null, 'Stale prompt');
    vi.advanceTimersByTime(10_000);
    renderChatInput();
    setStateAndFlush('activeSessionId', null);
    flushSolid();

    expect(state.selectedAgent).toBe('plan');
    expect(inputText()).not.toContain('Stale prompt');
    vi.useRealTimers();
  });

  it('keeps the model when switching between agents without models', () => {
    setupAgentModels();
    setState(storePath('agents', 1, 'model', undefined));
    flushSolid();
    renderChatInput();

    pickAgent('Plan');
    expect(state.selectedAgent).toBe('plan');
    expect(state.selectedModel).toEqual(GPT_4O);
  });
});
