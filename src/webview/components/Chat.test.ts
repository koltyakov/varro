import { flush as flushSolid, createSignal, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { AssistantMessage, MessageEntry, Session } from '../types';
import type { WebviewMessage } from '../../shared/protocol';
import * as openCodeModule from '../hooks/useOpenCode';
import {
  archiveSessionGroup,
  Chat,
  getAttentionSessions,
  getAutoOpenSessionIdForFilter,
  getArchiveSessionGroupConfirmationMessage,
  deriveSessionIndicators,
  getHeaderAttentionCount,
  getHeaderCompletedCount,
  getHeaderFailedCount,
  getHeaderPlanReadyCount,
  getHeaderRunningCount,
  getDiffSummaryStats,
  getOtherSessions,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  getSessionSummaryStats,
  getSubagentSessionsForParent,
  groupSessions,
  isEmptySession,
  isFailedSession,
  isRunningSession,
  SessionListSectionHeader,
  shouldAutoDeleteEmptySession,
  shouldShowSessionHeaderBadge,
} from './Chat';
import { client } from '../lib/client';
import { openBackgroundProcessView } from '../lib/background-process-view';
import { openSubagentSessionsView, subagentSessionsRequest } from '../lib/subagent-sessions-view';
import { openSideQuestion, sideQuestionView } from '../lib/side-question';
import { EMPTY_SESSION_PRUNE_GRACE_MS } from '../lib/empty-session';
import {
  requestOpenAttentionSessions,
  requestOpenCompletedSessions,
  applySessionSelectedModelsSnapshot,
  requestSessionSearchFocus,
  startLoading,
  stopLoading,
  setDesktopSessionPaneSide,
  hasActiveUsageLimit,
  state,
  setSessionFailed,
  setShowModels,
  setShowMcpSettings,
  showMcpSettings,
  setShowSessionPicker,
  setSessionUsageLimit,
  setMessagesIncremental,
  removeResolvedQuestion,
  setConnectionInitialized,
  setInputText,
  inputText,
  setState,
  skipPlanSession,
} from '../lib/state';
import { ralphStore } from '../lib/stores/ralph-store';
import { SessionLifecycleOperations } from '../hooks/session/session-lifecycle';
import { sessionStore } from '../lib/stores/session-store';
import { resetMessageEditState, startEditingMessage } from '../lib/message-edit-state';
import { clearDirectSessionReturn, rememberDirectSessionReturn } from '../lib/session-navigation';
import {
  requestProviderConnection,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalMatchMedia: typeof globalThis.matchMedia | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
let desktopMediaQueryMatches = false;
let desktopMediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();
// SAFETY: Tests own the optional host bootstrap state and clear it after each case.
const hostWindow = window as typeof window & {
  __initialWebviewState?: unknown;
  __vscodeWebviewState?: {
    getState(): TestWebviewState;
    setState(state: TestWebviewState): void;
  };
};

type TestWebviewState = {
  'varro.lastOpenedView'?: { type: string; sessionId?: string; timestamp?: number };
};

function dispatchDesktopMediaQueryChange(matches: boolean) {
  desktopMediaQueryMatches = matches;
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  const event = { matches, media: '(min-width: 1400px)' } as MediaQueryListEvent;
  desktopMediaQueryListeners.forEach((listener) => listener(event));
}

function preventKeyboardDefault(event: KeyboardEvent) {
  event.preventDefault();
}

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}

function clearStateRecord(
  key:
    | 'sessionStatus'
    | 'sessionUsageLimits'
    | 'lastSeenSessions'
    | 'completedSessionResponses'
    | 'skippedPlanSessions'
    | 'sessionSelectedAgents'
    | 'sessionSelectedModels'
    | 'providerDefaults'
    | 'providerLimits'
    | 'transferredSessions'
) {
  applyState((draft) => {
    const current = draft[key];
    if (current === null || current === undefined) draft[key] = {};
    else reconcile({})(current);
  });
}

function renderChat() {
  cleanup = render(() => Chat(), container!);
  flushSolid();
}

function click(target: Element | null | undefined) {
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSolid();
}

function queryButton(selector: string) {
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  return container?.querySelector(selector) as HTMLButtonElement | null;
}

function trimmedTexts(selector: string, root: ParentNode | null | undefined = container) {
  return Array.from(root?.querySelectorAll(selector) ?? []).map((item) => item.textContent?.trim());
}

function sectionToggle(label: string) {
  // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
  return Array.from(container?.querySelectorAll('button.session-list-section-toggle') ?? []).find(
    (item) => item.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;
}

function openSessionPicker() {
  setShowSessionPicker(true);
  flushSolid();
}

function spyOnDeleteImmediately() {
  return vi.spyOn(openCodeModule, 'deleteSessionImmediately').mockResolvedValue(undefined);
}

function emptySessionIndicators() {
  return {
    runningIds: new Set<string>(),
    attentionIds: new Set<string>(),
    failedIds: new Set<string>(),
    planReadyIds: new Set<string>(),
    newlyCompletedIds: new Set<string>(),
  };
}

function startRalphRun(managerSessionId: string, planDocPath: string) {
  ralphStore.startRun({
    managerSessionId,
    workspaceDirectory: '/workspace',
    planDocPath,
    iterations: 15,
    promptTemplate: 'Prompt',
    permissionMode: 'full',
    model: null,
    agent: null,
    createdAt: 1,
  });
  flushSolid();
}

function upsertRalphChildIteration(status: 'running' | 'failed', endedAt: number | null) {
  ralphStore.upsertIteration('manager', {
    index: 1,
    childSessionId: 'child-1',
    status,
    startedAt: 100,
    endedAt,
    filesChanged: [],
    verification: {},
  });
  flushSolid();
}

function limitSessionUsage(sessionID: string) {
  setSessionUsageLimit(sessionID, {
    source: 'status',
    statusCode: 429,
    message: '429 usage limit reached',
    unit: 'messages',
    retryAt: 8_000,
    attempt: 2,
    sessionID,
  });
  flushSolid();
}

/** Runs a scenario with bridge messages captured, then restores the host sender. */
function captureBridgeMessages(run: (sent: WebviewMessage[]) => void) {
  const sent: WebviewMessage[] = [];
  // SAFETY: The fixture installs the protocol bridge callback owned by the webview host.
  const bridgeWindow = window as {
    __sendToExtension?: (message: WebviewMessage) => void;
  };
  const originalSend = bridgeWindow.__sendToExtension;
  bridgeWindow.__sendToExtension = (message) => sent.push(message);
  try {
    run(sent);
  } finally {
    if (originalSend) bridgeWindow.__sendToExtension = originalSend;
    else delete bridgeWindow.__sendToExtension;
  }
}

/** Captures bridge messages with the editor workspace pinned to /repo for the scenario. */
function captureRepoBridgeMessages(run: (sent: WebviewMessage[]) => void) {
  const originalWorkspacePath = state.editorContext.workspacePath;
  captureBridgeMessages((sent) => {
    applyState(storePath('editorContext', 'workspacePath', '/repo'));
    try {
      run(sent);
    } finally {
      applyState(storePath('editorContext', 'workspacePath', originalWorkspacePath));
    }
  });
}

function unreadStateUpdates(sent: readonly WebviewMessage[]) {
  return sent.filter((message) => message.type === 'session-unread-state/update');
}

function unreadStateUpdate(
  sessionId: string,
  kind: 'completed' | 'plan-ready',
  markerAt: number,
  unread: boolean
) {
  return {
    type: 'session-unread-state/update',
    payload: { sessionId, directory: '/repo', kind, markerAt, unread },
  };
}

beforeEach(() => {
  delete hostWindow.__initialWebviewState;
  delete hostWindow.__vscodeWebviewState;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  originalMatchMedia = globalThis.matchMedia;
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  desktopMediaQueryMatches = false;
  desktopMediaQueryListeners = new Set();
  globalThis.ResizeObserver = class ResizeObserver implements globalThis.ResizeObserver {
    observe(_target: Element, _options?: ResizeObserverOptions) {}
    unobserve(_target: Element) {}
    disconnect() {}
  };
  globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 1400px)' ? desktopMediaQueryMatches : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (query === '(min-width: 1400px)') desktopMediaQueryListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (query === '(min-width: 1400px)') desktopMediaQueryListeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      if (query === '(min-width: 1400px)') desktopMediaQueryListeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      if (query === '(min-width: 1400px)') desktopMediaQueryListeners.delete(listener);
    },
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  delete hostWindow.__initialWebviewState;
  delete hostWindow.__vscodeWebviewState;
  vi.runOnlyPendingTimers();
  flushSolid();
  vi.useRealTimers();
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  resetMessageEditState();
  flushSolid();
  container?.remove();
  flushSolid();
  container = null;
  applyState(storePath('sessions', []));
  clearStateRecord('sessionStatus');
  clearStateRecord('sessionUsageLimits');
  applyState(storePath('failedSessionIds', []));
  applyState(storePath('failedSessionUpdatedAt', {}));
  applyState(storePath('recycleBinEntries', []));
  applyState(storePath('questions', []));
  applyState(storePath('questionResponsePendingSessionIds', []));
  applyState(storePath('permissions', []));
  clearStateRecord('lastSeenSessions');
  clearStateRecord('completedSessionResponses');
  clearStateRecord('skippedPlanSessions');
  clearStateRecord('sessionSelectedAgents');
  clearStateRecord('sessionSelectedModels');
  applyState(storePath('selectedAgent', null));
  applyState(storePath('selectedModel', null));
  applyState(storePath('providers', []));
  clearStateRecord('providerDefaults');
  clearStateRecord('providerLimits');
  applyState(storePath('editorTabsOpen', false));
  applyState(storePath('editorSessionIds', []));
  applyState(storePath('activeSessionId', null));
  clearStateRecord('transferredSessions');
  applyState(storePath('messages', []));
  applyState(storePath('queuedMessages', []));
  applyState(storePath('streamingPartId', null));
  applyState(storePath('streamingText', ''));
  applyState(storePath('compactingSessionIds', []));
  setDesktopSessionPaneSide('left');
  flushSolid();
  setShowSessionPicker(false);
  flushSolid();
  setShowModels(false);
  flushSolid();
  setShowMcpSettings(false);
  flushSolid();
  setConnectionInitialized(false);
  flushSolid();
  stopLoading();
  flushSolid();
  clearDirectSessionReturn();
  flushSolid();
  resetProviderConnectionState();
  flushSolid();
  for (const run of ralphStore.getAllRuns()) {
    ralphStore.removeRun(run.config.managerSessionId);
    flushSolid();
  }
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  flushSolid();
  if (originalMatchMedia) globalThis.matchMedia = originalMatchMedia;
  else Reflect.deleteProperty(globalThis, 'matchMedia');
  flushSolid();
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
});

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

/** A session whose metadata was never updated after creation. */
function untouchedSession(id: string, at: number, title: string): Session {
  return session(id, at, { title, time: { created: at, updated: at } });
}

function deletedSessionEntry(now: number) {
  const root = session('deleted-session', now - 10_000, {
    title: 'Deleted session',
    time: { created: now - 20_000, updated: now - 10_000 },
  });
  return {
    rootID: 'deleted-session',
    deletedAt: now - 10_000,
    expiresAt: now + 10_000,
    root,
    sessions: [{ ...root }],
  };
}

it.each([false, true])(
  'keeps a moved conversation writable without a warning, worktree=%s',
  (isGitWorktree) => {
    const directory = isGitWorktree ? '/worktrees/feature' : '/outside';
    applyState(
      storePath('sessions', [
        session('session-1', 500, {
          directory,
          isGitWorktree,
          transfer: { originDirectory: '/repo', available: false },
        }),
      ])
    );
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('transferredSessions', { 'session-1': directory }));
    setConnectionInitialized(true);
    flushSolid();
    setInputText('Unsent draft');
    flushSolid();
    applyState(storePath('selectedModel', { providerID: 'openai', modelID: 'test-model' }));
    try {
      renderChat();
      expect(container!.querySelector('.chat-transport-banner')).toBeNull();
      expect(state.activeSessionId).toBe('session-1');
      const send = container!.querySelector<HTMLButtonElement>('button[aria-label="Send (Enter)"]');
      expect(send).not.toBeNull();
      expect(send!.disabled).toBe(false);
    } finally {
      setInputText('');
      flushSolid();
    }
  }
);

it.each([false, true])(
  'reconciles a verified worktree snapshot without clearing a newer move, newerMove=%s',
  (newerMove) => {
    const directory = '/worktrees/feature';
    const moved = session('session-1', 500, {
      directory,
      transfer: { originDirectory: '/repo', available: false },
    });
    applyState(storePath('sessions', [moved]));
    applyState(storePath('activeSessionId', moved.id));
    applyState(
      storePath('transferredSessions', { [moved.id]: newerMove ? '/outside' : directory })
    );
    setConnectionInitialized(true);
    flushSolid();
    setInputText('Continue from here');
    flushSolid();
    applyState(storePath('selectedModel', { providerID: 'openai', modelID: 'test-model' }));
    const operations = new SessionLifecycleOperations({
      getCurrentWorkspacePath: () => '/repo',
      clearPendingAbort: vi.fn(),
      clearPendingAbortTree: vi.fn(),
      resetTodoSync: vi.fn(),
      resetToolCallExpansionState: vi.fn(),
      publishSessionModel: vi.fn(),
    });
    renderChat();
    expect(container!.querySelector('.chat-transport-banner')).toBeNull();
    expect(
      container!.querySelector<HTMLButtonElement>('button[aria-label="Send (Enter)"]')?.disabled
    ).toBe(false);

    operations.upsertSession({
      ...moved,
      transfer: { ...moved.transfer!, available: true },
    });
    flushSolid();

    expect(container!.querySelector('.chat-transport-banner')).toBeNull();
    expect(
      container!.querySelector<HTMLButtonElement>('button[aria-label="Send (Enter)"]')?.disabled
    ).toBe(false);
    expect(state.transferredSessions[moved.id]).toBe(newerMove ? '/outside' : undefined);
    expect(inputText()).toBe('Continue from here');
  }
);

function assistantMessageEntry(id: string): MessageEntry<AssistantMessage> {
  const info: AssistantMessage = {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-5.4',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  return { info, parts: [] };
}

describe('getSessionSummaryStats', () => {
  it('derives totals from summary diffs when aggregate fields are zeroed', () => {
    expect(
      getSessionSummaryStats(
        session('session-1', 1_000, {
          summary: {
            additions: 0,
            deletions: 0,
            files: 0,
            diffs: [
              { file: 'src/a.ts', before: '', after: '', additions: 4, deletions: 1 },
              { file: 'src/b.ts', before: '', after: '', additions: 2, deletions: 3 },
            ],
          },
        })
      )
    ).toEqual({ files: 2, additions: 6, deletions: 4 });
  });

  it('supports added and removed diff counts from newer OpenCode summaries', () => {
    expect(getDiffSummaryStats([{ file: 'src/a.ts', added: 5, removed: 2 }])).toEqual({
      files: 1,
      additions: 5,
      deletions: 2,
    });
  });

  it('uses a loaded diff fallback when session aggregate fields are zeroed', () => {
    expect(
      getSessionSummaryStats(
        session('session-1', 1_000, {
          summary: { additions: 0, deletions: 0, files: 0 },
        }),
        { files: 2, additions: 6, deletions: 4 }
      )
    ).toEqual({ files: 2, additions: 6, deletions: 4 });
  });

  it('preserves non-zero aggregate fields over a diff fallback', () => {
    expect(
      getSessionSummaryStats(
        session('session-1', 1_000, {
          summary: { additions: 1, deletions: 2, files: 3 },
        }),
        { files: 4, additions: 5, deletions: 6 }
      )
    ).toEqual({ files: 3, additions: 1, deletions: 2 });
  });
});

describe('groupSessions', () => {
  const now = 2 * 24 * 60 * 60 * 1_000;

  it('separates sub-agent sessions from primary session groups', () => {
    const sessions = [
      session('running-primary', now - 1_000),
      session('attention-primary', now - 2_000),
      session('other-primary', now - 3_000),
      session('subagent-newer', now - 500, { parentID: 'parent-1' }),
      session('subagent-older', now - 4_000, { parentID: 'parent-2' }),
    ];

    const groups = groupSessions(
      sessions,
      (sessionId) => sessionId === 'running-primary',
      (sessionId) => sessionId === 'attention-primary',
      () => false,
      () => false,
      () => false,
      now
    );

    expect(groups.failed).toEqual([]);
    expect(groups.planReady).toEqual([]);
    expect(groups.newlyCompleted).toEqual([]);
    expect(groups.running.map((item) => item.id)).toEqual(['running-primary']);
    expect(groups.attention.map((item) => item.id)).toEqual(['attention-primary']);
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-primary']);
    expect(groups.overflowOther).toEqual([]);
    expect(groups.subagents.map((item) => item.id)).toEqual(['subagent-newer', 'subagent-older']);
  });

  it('keeps fewer than 50 primary sessions recent regardless of age without affecting sub-agent ordering', () => {
    const sessions = [
      session('other-recent-1', now - 1_000),
      session('subagent-1', now - 2_000, { parentID: 'parent-1' }),
      session('other-recent-2', now - 12 * 60 * 60 * 1_000),
      session('subagent-2', now - 3_000, { parentID: 'parent-2' }),
      session('other-old', now - (24 * 60 * 60 * 1_000 + 1)),
    ];

    const groups = groupSessions(
      sessions,
      () => false,
      () => false,
      () => false,
      () => false,
      () => false,
      now
    );

    expect(groups.surfacedOther.map((item) => item.id)).toEqual([
      'other-recent-1',
      'other-recent-2',
      'other-old',
    ]);
    expect(groups.overflowOther).toEqual([]);
    expect(groups.subagents.map((item) => item.id)).toEqual(['subagent-1', 'subagent-2']);
  });

  it('sorts primary sessions by age regardless of status', () => {
    const sessions = [
      session('other-newest', now - 1_000),
      session('running-newer', now - 2_000),
      session('attention-older', now - 3_000),
      session('failed-older', now - 4_000),
      session('plan-ready-newer', now - 5_000),
      session('failed-newer', now - 6_000),
      session('attention-newer', now - 7_000),
      session('plan-ready-older', now - 8_000),
      session('other-older', now - (24 * 60 * 60 * 1_000 + 1)),
    ];

    const groups = groupSessions(
      sessions,
      (sessionId) => sessionId === 'running-newer',
      (sessionId) => sessionId === 'attention-older' || sessionId === 'attention-newer',
      (sessionId) => sessionId === 'failed-older' || sessionId === 'failed-newer',
      (item) => item.id === 'plan-ready-newer' || item.id === 'plan-ready-older',
      () => false,
      now
    );

    expect(groups.failed.map((item) => item.id)).toEqual(['failed-older', 'failed-newer']);
    expect(groups.planReady.map((item) => item.id)).toEqual([
      'plan-ready-newer',
      'plan-ready-older',
    ]);
    expect(groups.attention.map((item) => item.id)).toEqual(['attention-older', 'attention-newer']);
    expect(groups.running.map((item) => item.id)).toEqual(['running-newer']);
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-newest', 'other-older']);
    expect(groups.overflowOther).toEqual([]);
  });

  it('preserves recency order within each status group after age-only sorting', () => {
    const sessions = [
      session('failed-newer', now - 1_000),
      session('attention-newer', now - 2_000),
      session('failed-older', now - 3_000),
      session('attention-older', now - 4_000),
      session('other', now - 5_000),
    ];

    const groups = groupSessions(
      sessions,
      () => false,
      (sessionId) => sessionId === 'attention-newer' || sessionId === 'attention-older',
      (sessionId) => sessionId === 'failed-newer' || sessionId === 'failed-older',
      () => false,
      () => false,
      now
    );

    expect(groups.failed.map((item) => item.id)).toEqual(['failed-newer', 'failed-older']);
    expect(groups.attention.map((item) => item.id)).toEqual(['attention-newer', 'attention-older']);
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other']);
  });

  it('surfaces pinned sessions regardless of age', () => {
    const sessions = [
      session('recent', now - 1_000),
      session('pinned-old', now - 48 * 60 * 60 * 1_000),
    ];

    const groups = groupSessions(
      sessions,
      () => false,
      () => false,
      () => false,
      () => false,
      () => false,
      now,
      (sessionId) => sessionId === 'pinned-old'
    );

    expect(groups.pinned.map((item) => item.id)).toEqual(['pinned-old']);
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['recent']);
    expect(groups.overflowOther).toEqual([]);
  });

  it('keeps the top 50 old primary sessions recent and archives only the remainder', () => {
    const primaries = Array.from({ length: 52 }, (_, index) =>
      session(`old-${index}`, now - (index + 2) * 86_400_000)
    );
    const groups = groupSessions(
      [session('subagent', now, { parentID: 'old-0' }), ...primaries.toReversed()],
      () => false,
      () => false,
      () => false,
      () => false,
      () => false,
      now
    );

    expect(groups.surfacedOther).toEqual(primaries.slice(0, 50));
    expect(groups.overflowOther).toEqual(primaries.slice(50));
  });

  it('keeps sessions updated within one day recent beyond the top 50', () => {
    const sessions = Array.from({ length: 51 }, (_, index) =>
      session(`recent-${index}`, now - index * 1_000)
    );
    const groups = groupSessions(
      sessions,
      () => false,
      () => false,
      () => false,
      () => false,
      () => false,
      now
    );

    expect(groups.surfacedOther).toEqual(sessions);
    expect(groups.overflowOther).toEqual([]);
  });
});

describe('empty session pruning', () => {
  it('identifies sessions whose metadata was never updated after creation', () => {
    expect(isEmptySession(session('empty', 100, { time: { created: 100, updated: 100 } }))).toBe(
      true
    );
    expect(isEmptySession(session('non-empty', 200))).toBe(false);
  });

  it('auto-deletes only inactive empty sessions without meaningful status', () => {
    const now = Date.now();
    const empty = session('empty', now - EMPTY_SESSION_PRUNE_GRACE_MS - 100, {
      title: 'New Chat',
      time: {
        created: now - EMPTY_SESSION_PRUNE_GRACE_MS - 100,
        updated: now - EMPTY_SESSION_PRUNE_GRACE_MS - 100,
      },
    });
    const indicators = emptySessionIndicators();

    expect(shouldAutoDeleteEmptySession(empty, null, indicators)).toBe(true);
    expect(shouldAutoDeleteEmptySession(empty, 'empty', indicators)).toBe(false);
    expect(
      shouldAutoDeleteEmptySession(empty, null, {
        ...indicators,
        runningIds: new Set(['empty']),
      })
    ).toBe(false);
  });

  it('does not auto-delete a freshly created empty session during the grace window', () => {
    const now = Date.now();
    const fresh = session('fresh', now, {
      time: { created: now, updated: now },
    });
    const indicators = emptySessionIndicators();

    expect(shouldAutoDeleteEmptySession(fresh, null, indicators)).toBe(false);
  });

  it('hides a freshly created empty session from the list without deleting it', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const now = Date.now();

    applyState(storePath('sessions', [untouchedSession('new-session', now, 'New chat')]));
    applyState(storePath('activeSessionId', 'new-session'));
    openSessionPicker();

    renderChat();
    await Promise.resolve();
    flushSolid();
    vi.runOnlyPendingTimers();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const titles = trimmedTexts('.session-item-title');
    expect(titles).not.toContain('New chat');
    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('hides inactive empty sessions from the list and deletes them', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    applyState(
      storePath('sessions', [
        session('active', 200),
        untouchedSession('empty', staleTime, 'New Chat'),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    openSessionPicker();

    renderChat();
    await Promise.resolve();
    flushSolid();
    vi.runOnlyPendingTimers();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const titles = trimmedTexts('.session-item-title');
    expect(titles).not.toContain('New Chat');
    expect(deleteImmediatelySpy).toHaveBeenCalledWith('empty');
  });

  it('does not delete a newly created empty session that becomes active before the prune timer runs', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const now = Date.now();

    applyState(storePath('sessions', [untouchedSession('new-session', now, 'New session')]));
    applyState(storePath('activeSessionId', null));
    openSessionPicker();

    renderChat();
    await Promise.resolve();
    flushSolid();

    applyState(storePath('activeSessionId', 'new-session'));
    vi.runOnlyPendingTimers();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('hides an active empty session from the list without auto-deleting it', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    applyState(storePath('sessions', [untouchedSession('new-session', staleTime, 'New session')]));
    applyState(storePath('activeSessionId', 'new-session'));
    openSessionPicker();

    renderChat();
    await Promise.resolve();
    flushSolid();
    vi.runOnlyPendingTimers();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.textContent).not.toContain('New session');
    expect(container?.textContent).toContain('Sessions (0)');
    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('keeps a Ralph manager session visible and skips auto-delete when it is otherwise empty', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    applyState(
      storePath('sessions', [
        untouchedSession('manager', staleTime, 'Ralph manager'),
        session('child-1', staleTime + 1_000, {
          title: 'Ralph iter 1',
          parentID: 'manager',
        }),
      ])
    );
    openSessionPicker();
    startRalphRun('manager', 'TESTS.md');
    upsertRalphChildIteration('running', null);

    renderChat();
    await Promise.resolve();
    flushSolid();
    vi.runOnlyPendingTimers();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.textContent).toContain('Ralph manager');
    expect(container?.textContent).toContain('Ralph');
    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });
});

describe('getAttentionSessions', () => {
  it('preserves session order and includes sub-agent sessions needing attention', () => {
    const sessions = [
      session('attention-primary', 500),
      session('other-primary', 400),
      session('attention-subagent', 300, { parentID: 'parent-1' }),
    ];

    expect(
      getAttentionSessions(
        sessions,
        (sessionId) => sessionId === 'attention-primary' || sessionId === 'attention-subagent'
      ).map((item) => item.id)
    ).toEqual(['attention-primary', 'attention-subagent']);
  });
});

describe('getSessionListFilterLabel', () => {
  it('returns the active label when the session list is filtered', () => {
    expect(getSessionListFilterLabel('running')).toBe('Running');
    expect(getSessionListFilterLabel('pending')).toBe('Pending');
    expect(getSessionListFilterLabel('attention')).toBe('Needs attention');
    expect(getSessionListFilterLabel('failed')).toBe('Failed');
    expect(getSessionListFilterLabel('plan-ready')).toBe('Plan ready');
    expect(getSessionListFilterLabel('completed')).toBe('Completed');
    expect(getSessionListFilterLabel(null)).toBeNull();
  });
});

describe('getPrimarySessionsForFilter', () => {
  it('separates pending background waits from running sessions and excludes subagents', () => {
    const sessions = [
      session('working', 3),
      session('waiting', 2),
      session('waiting-child', 1, { parentID: 'waiting' }),
    ];
    const isPending = (id: string) => id.startsWith('waiting');
    expect(
      getPrimarySessionsForFilter(
        sessions,
        'pending',
        () => true,
        () => false,
        () => false,
        () => false,
        () => false,
        isPending
      ).map((item) => item.id)
    ).toEqual(['waiting']);
    expect(
      getPrimarySessionsForFilter(
        sessions,
        'running',
        () => true,
        () => false,
        () => false,
        () => false,
        () => false,
        isPending
      ).map((item) => item.id)
    ).toEqual(['working']);
  });
  const sessions = [
    session('running-primary', 600),
    session('attention-primary', 500),
    session('failed-primary', 400),
    session('plan-ready-primary', 300),
    session('running-subagent', 200, { parentID: 'parent-1' }),
  ];

  it('returns only primary sessions matching the requested header status', () => {
    expect(
      getPrimarySessionsForFilter(
        sessions,
        'running',
        (sessionId) => sessionId === 'running-primary' || sessionId === 'running-subagent',
        () => false,
        () => false,
        () => false,
        () => false
      ).map((item) => item.id)
    ).toEqual(['running-primary']);

    expect(
      getPrimarySessionsForFilter(
        sessions,
        'attention',
        () => false,
        (sessionId) => sessionId === 'attention-primary',
        () => false,
        () => false,
        () => false
      ).map((item) => item.id)
    ).toEqual(['attention-primary']);

    expect(
      getPrimarySessionsForFilter(
        sessions,
        'failed',
        () => false,
        () => false,
        (sessionId) => sessionId === 'failed-primary',
        () => false,
        () => false
      ).map((item) => item.id)
    ).toEqual(['failed-primary']);

    expect(
      getPrimarySessionsForFilter(
        sessions,
        'plan-ready',
        () => false,
        () => false,
        () => false,
        (item) => item.id === 'plan-ready-primary',
        () => false
      ).map((item) => item.id)
    ).toEqual(['plan-ready-primary']);

    expect(
      getPrimarySessionsForFilter(
        [...sessions, session('completed-primary', 250)],
        'completed',
        () => false,
        () => false,
        () => false,
        () => false,
        (item) => item.id === 'completed-primary'
      ).map((item) => item.id)
    ).toEqual(['completed-primary']);
  });

  it('includes sessions waiting for input in the running filter', () => {
    expect(
      getPrimarySessionsForFilter(
        sessions,
        'running',
        (sessionId) => sessionId === 'running-primary' || sessionId === 'running-subagent',
        (sessionId) => sessionId === 'attention-primary',
        () => false,
        () => false,
        () => false
      ).map((item) => item.id)
    ).toEqual(['running-primary', 'attention-primary']);
  });
});

describe('getAutoOpenSessionIdForFilter', () => {
  const sessions = [
    session('active', 700),
    session('running-target', 600),
    session('running-other', 500),
    session('attention-target', 400),
    session('running-subagent', 300, { parentID: 'active' }),
  ];

  it('returns the lone sibling match when the chat view is active', () => {
    expect(
      getAutoOpenSessionIdForFilter(
        sessions,
        'attention',
        'active',
        false,
        (sessionId) => sessionId === 'running-target' || sessionId === 'running-other',
        (sessionId) => sessionId === 'attention-target',
        () => false,
        () => false,
        () => false
      )
    ).toBe('attention-target');
  });

  it('does not auto-open while the picker is already visible', () => {
    expect(
      getAutoOpenSessionIdForFilter(
        sessions,
        'attention',
        'active',
        true,
        (sessionId) => sessionId === 'running-target' || sessionId === 'running-other',
        (sessionId) => sessionId === 'attention-target',
        () => false,
        () => false,
        () => false
      )
    ).toBeNull();
  });

  it('does not auto-open when multiple sibling matches remain', () => {
    expect(
      getAutoOpenSessionIdForFilter(
        sessions,
        'running',
        'active',
        false,
        (sessionId) =>
          sessionId === 'running-target' ||
          sessionId === 'running-other' ||
          sessionId === 'running-subagent',
        () => false,
        () => false,
        () => false,
        () => false
      )
    ).toBeNull();
  });
});

describe('getSubagentSessionsForParent', () => {
  it('returns only sub-agent sessions for the selected parent', () => {
    const sessions = [
      session('parent-1', 700),
      session('child-1', 600, { parentID: 'parent-1' }),
      session('parent-2', 500),
      session('child-2', 400, { parentID: 'parent-1' }),
      session('child-3', 300, { parentID: 'parent-2' }),
    ];

    expect(getSubagentSessionsForParent(sessions, 'parent-1').map((item) => item.id)).toEqual([
      'child-1',
      'child-2',
    ]);
    expect(getSubagentSessionsForParent(sessions, 'parent-2').map((item) => item.id)).toEqual([
      'child-3',
    ]);
    expect(getSubagentSessionsForParent(sessions, null)).toEqual([]);
  });

  it('includes nested descendants for the selected parent', () => {
    const sessions = [
      session('parent-1', 700),
      session('child-1', 600, { parentID: 'parent-1' }),
      session('grandchild-1', 550, { parentID: 'child-1' }),
      session('child-2', 500, { parentID: 'parent-1' }),
      session('parent-2', 400),
    ];

    expect(getSubagentSessionsForParent(sessions, 'parent-1').map((item) => item.id)).toEqual([
      'child-1',
      'grandchild-1',
      'child-2',
    ]);
  });
});

describe('shouldShowSessionHeaderBadge', () => {
  it('hides the badge for the active filter', () => {
    expect(shouldShowSessionHeaderBadge('running', 'running')).toBe(false);
    expect(shouldShowSessionHeaderBadge('attention', 'attention')).toBe(false);
    expect(shouldShowSessionHeaderBadge('failed', 'failed')).toBe(false);
    expect(shouldShowSessionHeaderBadge('plan-ready', 'plan-ready')).toBe(false);
    expect(shouldShowSessionHeaderBadge('completed', 'completed')).toBe(false);
  });

  it('keeps other badges visible', () => {
    expect(shouldShowSessionHeaderBadge('failed', 'running')).toBe(true);
    expect(shouldShowSessionHeaderBadge(null, 'plan-ready')).toBe(true);
    expect(shouldShowSessionHeaderBadge('completed', 'running')).toBe(true);
  });
});

describe('getOtherSessions', () => {
  it('preserves session order and keeps non-attention sessions available', () => {
    const sessions = [
      session('attention-primary', 500),
      session('running-primary', 400),
      session('completed-primary', 300),
      session('completed-subagent', 200, { parentID: 'parent-1' }),
    ];

    expect(
      getOtherSessions(sessions, (sessionId) => sessionId === 'attention-primary').map(
        (item) => item.id
      )
    ).toEqual(['running-primary', 'completed-primary', 'completed-subagent']);
  });
});

describe('archiveSessionGroup', () => {
  it('skips confirmation when the group is empty', async () => {
    const confirmArchive = vi.fn(() => true);
    const archiveSession = vi.fn(async () => undefined);

    await expect(
      archiveSessionGroup([], 'Sub-Agents', confirmArchive, archiveSession)
    ).resolves.toBe(false);
    flushSolid();

    expect(confirmArchive).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
  });

  it('asks for confirmation before archiving the group', async () => {
    const sessions = [
      session('subagent-1', 500, { parentID: 'parent-1' }),
      session('subagent-2', 400, { parentID: 'parent-2' }),
    ];
    const confirmArchive = vi.fn(() => true);
    const archiveSession = vi.fn(async () => undefined);

    await expect(
      archiveSessionGroup(sessions, 'Sub-Agents', confirmArchive, archiveSession)
    ).resolves.toBe(true);
    flushSolid();

    expect(confirmArchive).toHaveBeenCalledWith(
      getArchiveSessionGroupConfirmationMessage('Sub-Agents', 2)
    );
    expect(archiveSession.mock.calls).toEqual([['subagent-1'], ['subagent-2']]);
  });

  it('does not archive when confirmation is declined', async () => {
    const sessions = [session('subagent-1', 500, { parentID: 'parent-1' })];
    const confirmArchive = vi.fn(() => false);
    const archiveSession = vi.fn(async () => undefined);

    await expect(
      archiveSessionGroup(sessions, 'Sub-Agents', confirmArchive, archiveSession)
    ).resolves.toBe(false);
    flushSolid();

    expect(confirmArchive).toHaveBeenCalledWith(
      getArchiveSessionGroupConfirmationMessage('Sub-Agents', 1)
    );
    expect(archiveSession).not.toHaveBeenCalled();
  });
});

describe('SessionListSectionHeader', () => {
  it('shows inline confirmation before archiving a section', () => {
    const onArchive = vi.fn(async () => undefined);

    cleanup = render(
      () =>
        SessionListSectionHeader({
          title: 'Sub-Agents',
          count: 2,
          expanded: false,
          onToggle: vi.fn(),
          onArchive,
        }),
      container!
    );
    flushSolid();

    const archiveButton = queryButton('button.session-list-section-archive');
    expect(archiveButton).toBeInstanceOf(HTMLButtonElement);

    click(archiveButton);

    const confirmButton = queryButton('button.session-list-section-confirm');
    const cancelButton = queryButton('button.session-list-section-cancel');

    expect(confirmButton?.textContent).toBe('Confirm');
    expect(cancelButton?.textContent).toBe('Cancel');
    expect(onArchive).not.toHaveBeenCalled();

    click(confirmButton);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('button.session-list-section-confirm')).toBeNull();
  });

  it('keeps inline confirmation open when the section count changes', () => {
    const [count, setCount] = createSignal(2);

    cleanup = render(
      () =>
        SessionListSectionHeader({
          title: 'Archive',
          get count() {
            return count();
          },
          expanded: false,
          onToggle: vi.fn(),
          onArchive: vi.fn(),
        }),
      container!
    );
    flushSolid();

    container?.querySelector<HTMLButtonElement>('button.session-list-section-archive')?.click();
    flushSolid();
    setCount(3);
    flushSolid();

    expect(container?.querySelector('button.session-list-section-confirm')).not.toBeNull();
    expect(container?.querySelector('button.session-list-section-cancel')).not.toBeNull();
  });

  it('uses a custom action label when provided', () => {
    cleanup = render(
      () =>
        SessionListSectionHeader({
          title: 'Recycle Bin',
          count: 1,
          expanded: false,
          onToggle: vi.fn(),
          onArchive: vi.fn(),
          archiveLabel: 'Empty',
        }),
      container!
    );
    flushSolid();

    const actionButton = queryButton('button.session-list-section-archive');
    expect(actionButton?.getAttribute('aria-label')).toBe('Empty Recycle Bin');
  });
});

describe('header status badges', () => {
  it('removes a hidden moved row and its running badge as soon as hiding succeeds, before reload completes', async () => {
    const now = Date.now();
    applyState(storePath('editorContext', 'workspacePath', '/repo'));
    applyState(storePath('editorContext', 'workspaceFolders', [{ name: 'Repo', path: '/repo' }]));
    applyState(
      storePath('sessions', [
        session('moved', now, {
          directory: '/outside',
          transfer: { originDirectory: '/repo', available: false },
        }),
        session('local', now - 1),
      ])
    );
    applyState(storePath('activeSessionId', 'moved'));
    applyState(storePath('sessionStatus', { moved: { type: 'busy' }, local: { type: 'idle' } }));
    openSessionPicker();
    vi.spyOn(client.varro.session, 'hideTransfer').mockResolvedValue(true);
    let finishReload!: () => void;
    vi.spyOn(openCodeModule, 'reloadSessions').mockReturnValue(
      new Promise<void>((resolve) => {
        finishReload = resolve;
      })
    );
    renderChat();
    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    container
      ?.querySelector('[data-session-id="moved"]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent === 'Hide from this list')!
      .click();
    flushSolid();
    await vi.waitFor(() =>
      expect(container?.querySelector('[data-session-id="moved"]')).toBeNull()
    );
    flushSolid();
    expect(container?.querySelector('.chat-header-running-badge')).toBeNull();
    expect(container?.querySelector('[data-session-id="local"]')).not.toBeNull();
    expect(state.activeSessionId).toBe('moved');
    expect(state.sessionStatus.moved?.type).toBe('busy');
    finishReload();
  });

  it.each(['hidden', 'hiddenOrigins'] as const)(
    'does not count a persisted %s moved link after mounting a fresh view',
    (preference) => {
      const now = Date.now();
      applyState(storePath('editorContext', 'workspacePath', '/repo'));
      applyState(storePath('editorContext', 'workspaceFolders', [{ name: 'Repo', path: '/repo' }]));
      applyState(
        storePath('sessions', [
          session('moved', now, {
            directory: '/outside',
            transfer: {
              originDirectory: '/repo',
              available: false,
              hidden: preference === 'hidden',
              hiddenOrigins: preference === 'hiddenOrigins' ? ['/repo'] : undefined,
            },
          }),
          session('local', now - 1),
        ])
      );
      applyState(storePath('activeSessionId', 'local'));
      applyState(storePath('sessionStatus', { moved: { type: 'busy' }, local: { type: 'idle' } }));
      openSessionPicker();
      renderChat();
      expect(container?.querySelector('[data-session-id="moved"]')).toBeNull();
      expect(container?.querySelector('.chat-header-running-badge')).toBeNull();
      vi.advanceTimersByTime(1500);
      flushSolid();
      expect(container?.querySelector('.chat-header-running-badge')).toBeNull();
      expect(state.sessionStatus.moved?.type).toBe('busy');
    }
  );

  it('opens a Pending filter from the hourglass and keeps it separate from Running', () => {
    const now = Date.now();
    applyState(storePath('sessions', [session('waiting', now), session('working', now)]));
    applyState(storePath('activeSessionId', null));
    applyState(
      storePath('sessionStatus', {
        waiting: { type: 'busy', background: true, backgroundStartedAt: now - 60_000 },
        working: { type: 'busy' },
      })
    );
    openSessionPicker();
    renderChat();

    container?.querySelector<HTMLButtonElement>('.chat-header-pending-badge')?.click();
    flushSolid();
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe('Pending');
    expect(container?.querySelector('[data-session-id="waiting"]')).not.toBeNull();
    expect(container?.querySelector('[data-session-id="working"]')).toBeNull();
    expect(container?.querySelector('.chat-header-pending-badge')).toBeNull();

    container?.querySelector<HTMLButtonElement>('.chat-header-running-badge')?.click();
    flushSolid();
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe('Running');
    expect(container?.querySelector('[data-session-id="waiting"]')).toBeNull();
    expect(container?.querySelector('[data-session-id="working"]')).not.toBeNull();
    expect(container?.querySelector('.chat-header-pending-badge')).not.toBeNull();

    container?.querySelector<HTMLButtonElement>('.chat-header-pending-badge')?.click();
    flushSolid();
    applyState(storePath('sessionStatus', 'waiting', { type: 'busy', background: false }));
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe('Pending');
    expect(container?.querySelector('[data-session-id="waiting"]')).toBeNull();
  });
  it('removes long background waits from the running count and shows a counter-free pending badge', () => {
    const now = Date.now();
    applyState(storePath('sessions', [session('waiting', now), session('working', now)]));
    applyState(storePath('activeSessionId', null));
    applyState(
      storePath('sessionStatus', {
        waiting: { type: 'busy', background: true, backgroundStartedAt: now },
        working: { type: 'busy' },
      })
    );
    openSessionPicker();
    renderChat();
    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('2');
    expect(container?.querySelector('.chat-header-pending-badge')).toBeNull();

    vi.advanceTimersByTime(60_000);
    flushSolid();
    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    const pending = container?.querySelector('.chat-header-pending-badge');
    expect(pending).toBeInstanceOf(HTMLButtonElement);
    expect(pending?.textContent).toBe('');
    expect(container?.querySelector('[data-session-id="waiting"] .is-pending')).not.toBeNull();

    applyState(storePath('sessionStatus', 'waiting', { type: 'busy', background: false }));
    expect(container?.querySelector('.chat-header-pending-badge')).toBeNull();
    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('2');
  });

  it('shows an hourglass beside the active title even when desktop header actions are hidden', () => {
    const now = Date.now();
    desktopMediaQueryMatches = true;
    applyState(storePath('sessions', [session('waiting', now)]));
    applyState(storePath('activeSessionId', 'waiting'));
    applyState(
      storePath('sessionStatus', {
        waiting: { type: 'busy', background: true, backgroundStartedAt: now - 60_000 },
      })
    );
    setShowSessionPicker(false);
    flushSolid();
    renderChat();
    const marker = container?.querySelector(
      '.chat-header-chat-desktop .chat-header-pending-marker'
    );
    expect(marker?.getAttribute('aria-label')).toBe('Pending background task');
    expect(marker?.textContent).toBe('');
    expect(marker?.querySelector('.ui-icon')).not.toBeNull();
  });
  it('keeps background details through completion and closes them on session switch', async () => {
    const now = Date.now();
    applyState(storePath('sessions', [session('waiting', now), session('other', now)]));
    applyState(storePath('activeSessionId', 'waiting'));
    setShowSessionPicker(false);
    flushSolid();
    vi.spyOn(client.session, 'backgroundProcesses').mockResolvedValue([]);
    renderChat();
    openBackgroundProcessView('waiting', '/repo');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(document.querySelector('.background-process-dialog')).not.toBeNull();
    applyState(storePath('sessionStatus', 'waiting', { type: 'idle' }));
    expect(document.querySelector('.background-process-dialog')).not.toBeNull();
    applyState(storePath('activeSessionId', 'other'));
    expect(document.querySelector('.background-process-dialog')).toBeNull();
  });
  it('derives quick statuses from Recent sessions and excludes recycled sessions', () => {
    const now = Date.now();
    const oldUpdatedAt = now - 3 * 24 * 60 * 60 * 1_000;
    applyState(
      storePath('sessions', [
        session('active', now),
        session('old-running', oldUpdatedAt),
        session('old-attention', oldUpdatedAt),
        session('old-failed', oldUpdatedAt),
        session('old-plan', oldUpdatedAt),
        session('old-completed', oldUpdatedAt),
        ...Array.from({ length: 44 }, (_, index) => session(`recent-${index}`, now - 1_000)),
        session('archived', oldUpdatedAt),
        session('deleted-running', now - 1_000),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    applyState(
      storePath('sessionStatus', {
        'old-running': { type: 'busy' },
        'deleted-running': { type: 'busy' },
      })
    );
    applyState(
      storePath('questions', [{ id: 'question-1', sessionID: 'old-attention', questions: [] }])
    );
    applyState(storePath('failedSessionIds', ['old-failed']));
    applyState(storePath('sessionSelectedAgents', { 'old-plan': 'plan' }));
    applyState(storePath('completedSessionResponses', { 'old-completed': oldUpdatedAt }));
    applyState(
      storePath('recycleBinEntries', [
        {
          rootID: 'deleted-running',
          deletedAt: now - 500,
          expiresAt: now + 1_000,
          root: session('deleted-running', now - 1_000),
          sessions: [session('deleted-running', now - 1_000)],
        },
      ])
    );
    openSessionPicker();

    renderChat();

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    expect(container?.querySelector('.chat-header-attention-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(container?.querySelector('.chat-header-failed-badge')).toBeInstanceOf(HTMLButtonElement);
    expect(container?.querySelector('.chat-header-plan-badge')).toBeInstanceOf(HTMLButtonElement);
    expect(container?.querySelector('.chat-header-completed-badge')).toBeInstanceOf(
      HTMLButtonElement
    );

    const recentTitles = trimmedTexts('.session-list-section.expanded .session-item-title');
    expect(recentTitles).toContain('old-running');
    expect(recentTitles).toContain('old-attention');
    expect(recentTitles).toContain('old-failed');
    expect(recentTitles).toContain('old-plan');
    expect(recentTitles).toContain('old-completed');
    expect(recentTitles).not.toContain('archived');
    expect(recentTitles).not.toContain('deleted-running');
  });

  it('opens the session list and focuses search when requested by the host', async () => {
    renderChat();

    requestSessionSearchFocus();
    await Promise.resolve();
    flushSolid();
    vi.advanceTimersByTime(20);
    flushSolid();

    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search sessions"]');
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(search);
  });

  it('does not show the reconnect banner for brief event stream degradation', () => {
    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'healthy',
      })
    );

    renderChat();

    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'degraded',
      })
    );
    vi.advanceTimersByTime(9999);
    flushSolid();
    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'healthy',
      })
    );

    expect(container?.querySelector('.chat-transport-banner')).toBeNull();
  });

  it('keeps the reconnect banner visible briefly after recovery once shown', () => {
    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'healthy',
      })
    );

    renderChat();

    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'degraded',
      })
    );
    vi.advanceTimersByTime(10_000);
    flushSolid();

    expect(container?.querySelector('.chat-transport-banner')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-transport-title')?.textContent).toBe(
      'Live updates are reconnecting'
    );

    applyState(
      storePath('serverStatus', {
        state: 'running',
        url: 'http://127.0.0.1:4096',
        eventStream: 'healthy',
      })
    );
    vi.advanceTimersByTime(1999);
    flushSolid();

    expect(container?.querySelector('.chat-transport-banner')).toBeInstanceOf(HTMLDivElement);

    vi.advanceTimersByTime(1);
    flushSolid();

    expect(container?.querySelector('.chat-transport-banner')).toBeNull();
  });

  it.each([false, true])('derives raw indicators once with session picker %s', (picker) => {
    applyState(
      storePath('sessions', [session('first', Date.now()), session('second', Date.now() - 1)])
    );
    applyState(storePath('activeSessionId', 'first'));
    applyState(storePath('sessionStatus', { first: { type: 'busy' }, second: { type: 'idle' } }));
    setShowSessionPicker(picker);
    flushSolid();
    // Each raw derivation reads the Ralph catalog once. Spy on the real store
    // method so both the parent and list's local derivations are counted.
    const catalogReads = vi.spyOn(ralphStore, 'getAllRuns');
    renderChat();
    expect(container?.querySelectorAll('.session-item').length).toBeGreaterThan(0);
    catalogReads.mockClear();

    applyState(storePath('sessionStatus', 'second', { type: 'busy' }));

    expect(catalogReads).toHaveBeenCalledTimes(1);
    const row = container?.querySelector('[data-session-id="second"]');
    expect(row?.querySelector('.session-item-indicator.is-running')).not.toBeNull();
    applyState(storePath('sessionStatus', 'second', { type: 'idle' }));
    vi.advanceTimersByTime(1199);
    flushSolid();
    expect(row?.querySelector('.session-item-indicator.is-running')).not.toBeNull();
    vi.advanceTimersByTime(1);
    flushSolid();
    expect(row?.querySelector('.session-item-indicator.is-running')).toBeNull();
  });

  it('keeps list settling local when the session list remounts during a parent settle window', () => {
    applyState(
      storePath('sessions', [session('first', Date.now()), session('other', Date.now() - 1)])
    );
    applyState(storePath('activeSessionId', 'other'));
    applyState(storePath('sessionStatus', { first: { type: 'busy' } }));
    renderChat();
    applyState(storePath('sessionStatus', 'first', { type: 'idle' }));
    vi.advanceTimersByTime(500);
    flushSolid();
    expect(container?.querySelector('.session-item-indicator.is-running')).not.toBeNull();
    const previousRow = container?.querySelector('[data-session-id="first"]');

    openSessionPicker();

    expect(container?.querySelector('.session-item')).not.toBeNull();
    expect(container?.querySelector('[data-session-id="first"]')).not.toBe(previousRow);
    expect(container?.querySelector('.session-item-indicator.is-running')).toBeNull();
    vi.advanceTimersByTime(700);
    flushSolid();
    expect(container?.querySelector('.session-item-indicator.is-running')).toBeNull();
  });

  it('shows a count only for running sessions', () => {
    applyState(
      storePath('sessions', [
        session('running-1', 500),
        session('running-2', 400),
        session('failed-1', 300),
        session('attention-1', 200),
        session('plan-1', 100),
        session('completed-1', 50),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    applyState(
      storePath('sessionStatus', {
        'running-1': { type: 'busy' },
        'running-2': { type: 'busy' },
      })
    );
    applyState(storePath('failedSessionIds', ['failed-1']));
    applyState(
      storePath('questions', [{ id: 'question-1', sessionID: 'attention-1', questions: [] }])
    );
    applyState(storePath('lastSeenSessions', { 'plan-1': 0 }));
    applyState(storePath('completedSessionResponses', { 'completed-1': 50 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));

    renderChat();

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('2');
    expect(container?.querySelector('.chat-header-failed-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-attention-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-plan-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-completed-badge')?.textContent).toBe('');
  });

  it('switches the running badge to unread completion without a settle-window gap', () => {
    applyState(storePath('sessions', [session('finishing', 500)]));
    applyState(storePath('sessionStatus', { finishing: { type: 'busy' } }));
    renderChat();

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    applyState(storePath('completedSessionResponses', { finishing: 500 }));
    applyState(storePath('sessionStatus', 'finishing', { type: 'idle' }));

    expect(container?.querySelector('.chat-header-running-badge')).not.toBeNull();
    expect(container?.querySelector('.chat-header-completed-badge')).toBeNull();
    vi.advanceTimersByTime(1199);
    flushSolid();
    expect(container?.querySelector('.chat-header-running-badge')).not.toBeNull();
    expect(container?.querySelector('.chat-header-completed-badge')).toBeNull();
    vi.advanceTimersByTime(1);
    flushSolid();
    expect(container?.querySelector('.chat-header-running-badge')).toBeNull();
    expect(container?.querySelector('.chat-header-completed-badge')).not.toBeNull();
  });

  it('does not count parent sessions that are only running subagents', () => {
    applyState(
      storePath('sessions', [
        session('direct-running', 600),
        session('child-running-parent', 500),
        session('child-running', 400, { parentID: 'child-running-parent' }),
        session('other-child-parent', 300),
        session('other-child-running', 200, { parentID: 'other-child-parent' }),
      ])
    );
    applyState(
      storePath('sessionStatus', {
        'direct-running': { type: 'busy' },
        'child-running': { type: 'busy' },
        'other-child-running': { type: 'busy' },
      })
    );
    openSessionPicker();

    renderChat();

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
  });

  it('hides the failed badge after all failed sessions have been read', () => {
    applyState(storePath('sessions', [session('failed-1', 500), session('failed-2', 400)]));
    applyState(storePath('failedSessionIds', ['failed-1', 'failed-2']));
    applyState(storePath('failedSessionUpdatedAt', { 'failed-1': 500, 'failed-2': 400 }));
    applyState(storePath('lastSeenSessions', { 'failed-1': 0, 'failed-2': 0 }));

    renderChat();

    expect(container?.querySelector('.chat-header-failed-badge')).not.toBeNull();

    applyState(storePath('lastSeenSessions', 'failed-1', 500));

    expect(container?.querySelector('.chat-header-failed-badge')).not.toBeNull();

    applyState(storePath('lastSeenSessions', 'failed-2', 400));

    expect(container?.querySelector('.chat-header-failed-badge')).toBeNull();
    expect(state.failedSessionIds).toEqual(['failed-1', 'failed-2']);
  });

  it('shows an actively loading session as running when its status entry is idle', async () => {
    applyState(
      storePath('sessions', [session('active-loading', 500), session('other-running', 400)])
    );
    applyState(storePath('activeSessionId', 'active-loading'));
    applyState(
      storePath('sessionStatus', {
        'active-loading': { type: 'idle' },
        'other-running': { type: 'busy' },
      })
    );
    startLoading();
    flushSolid();
    openSessionPicker();

    renderChat();

    const activeRow = Array.from(container!.querySelectorAll<HTMLElement>('.session-item')).find(
      (row) => row.querySelector('.session-item-title-text')?.textContent === 'active-loading'
    );
    expect(activeRow?.querySelector('.session-item-indicator.is-running')).not.toBeNull();
    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('2');

    setShowSessionPicker(false);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
  });

  it('renders an embedded session sidebar alongside the active chat view', () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));

    renderChat();

    expect(container?.querySelector('.chat-workspace')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-session-sidebar')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.session-list-view-sidebar')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-main-shell')).toBeInstanceOf(HTMLDivElement);
  });

  it('switches sessions in persisted pin order when requested by the extension host', () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);
    applyState(
      storePath('sessions', [
        session('newest', 300),
        session('middle', 200),
        session('oldest', 100),
      ])
    );
    applyState(storePath('pinnedSessionIds', ['oldest', 'middle']));
    applyState(storePath('activeSessionId', 'oldest'));

    renderChat();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'command/switch-session', payload: { direction: 'next' } },
      })
    );
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('middle');
  });

  it('returns to the sessions list with Escape', async () => {
    applyState(storePath('sessions', [session('active', 500), session('other', 400)]));
    applyState(storePath('activeSessionId', 'active'));

    renderChat();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeInstanceOf(HTMLDivElement);
  });

  it('opens MCP settings as a separate screen and returns to the same chat with Escape', async () => {
    vi.spyOn(client.mcp, 'defaults').mockResolvedValue({
      global: { docs: false },
      project: {},
      effective: { docs: false },
      editable: true,
    });
    applyState(storePath('sessions', [session('active', 500)]));
    applyState(storePath('activeSessionId', 'active'));
    setInputText('Keep this draft');
    flushSolid();
    renderChat();
    setShowMcpSettings(true);
    flushSolid();
    expect(
      container?.querySelector('.mcp-settings-panel [aria-label="Loading MCP settings"]')
    ).not.toBeNull();
    await vi.dynamicImportSettled();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('h1')?.textContent).toBe('MCP settings');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(showMcpSettings()).toBe(false);
    expect(container?.querySelector('.mcp-settings-panel')).toBeNull();
    expect(state.activeSessionId).toBe('active');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
    expect(inputText()).toBe('Keep this draft');
  });

  it('leaves Escape to nested chat controls that consume it', async () => {
    applyState(storePath('sessions', [session('active', 500), session('other', 400)]));
    applyState(storePath('activeSessionId', 'active'));

    renderChat();
    window.addEventListener('keydown', preventKeyboardDefault);
    flushSolid();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    window.removeEventListener('keydown', preventKeyboardDefault);
    flushSolid();

    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('keeps desktop session controls in the sessions sidebar instead of duplicating them', () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(
      storePath('sessionStatus', {
        'session-2': { type: 'busy' },
      })
    );

    renderChat();

    const desktopHeader = container?.querySelector('.chat-header-chat-desktop');
    const desktopActions = desktopHeader?.querySelector('.chat-header-actions');
    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');
    const compactHeader = container?.querySelector('.interactive-session > .chat-header');

    expect(desktopHeader).toBeInstanceOf(HTMLDivElement);
    expect(desktopHeader?.querySelector('.chat-header-title-text')?.textContent).toBe('session-1');
    expect(desktopActions).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-running-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-btn[aria-label="New chat"]')).toBeNull();
    expect(sidebarHeader?.querySelector('.chat-header-running-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    expect(sidebarHeader?.querySelector('.chat-header-btn[aria-label="New chat"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(compactHeader?.querySelector('.chat-header-running-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(compactHeader?.querySelector('.chat-header-btn[aria-label="New chat"]')).toBeInstanceOf(
      HTMLButtonElement
    );
  });

  it('shows a background plan completion in the narrow header without a metadata update', async () => {
    const selectSessionSpy = vi.spyOn(openCodeModule, 'selectSession').mockResolvedValue(undefined);
    const now = Date.now();
    applyState(storePath('sessions', [session('active', now), session('plan-1', now - 1000)]));
    applyState(storePath('activeSessionId', 'plan-1'));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('sessionStatus', { 'plan-1': { type: 'busy' } }));
    applyState(storePath('lastSeenSessions', { active: now, 'plan-1': now }));

    renderChat();

    openSessionPicker();
    applyState(storePath('activeSessionId', 'active'));
    setShowSessionPicker(false);
    flushSolid();
    const header = container?.querySelector('.interactive-session > .chat-header');
    expect(header?.querySelector('.chat-header-plan-badge')).toBeNull();

    vi.advanceTimersByTime(100);
    flushSolid();
    sessionStore.setSessionStatusEntry('plan-1', { type: 'idle' });
    flushSolid();
    vi.advanceTimersByTime(1200);
    flushSolid();

    expect(state.sessions.find((entry) => entry.id === 'plan-1')?.time.updated).toBe(now - 1000);

    const badge = header?.querySelector<HTMLButtonElement>('.chat-header-plan-badge');
    expect(badge).toBeInstanceOf(HTMLButtonElement);
    badge?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(selectSessionSpy).toHaveBeenCalledWith('plan-1');

    openSessionPicker();
    expect(
      container?.querySelector(
        '[data-session-id="plan-1"] .session-item-indicator.is-plan-completed'
      )
    ).not.toBeNull();
    sessionStore.markSessionSeen('plan-1');
    flushSolid();
    setShowSessionPicker(false);
    flushSolid();
    expect(
      container?.querySelector('.interactive-session > .chat-header .chat-header-plan-badge')
    ).toBeNull();
    expect(
      container?.querySelector(
        '[data-session-id="plan-1"] .session-item-indicator.is-plan-completed'
      )
    ).toBeNull();
  });

  it('omits the session header in editor panels', () => {
    hostWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));

    renderChat();

    expect(container?.querySelector('.interactive-session > .chat-header')).toBeNull();
    expect(container?.querySelector('.chat-header-chat-desktop')).toBeNull();
    expect(container?.querySelector('.chat-main-shell')).toBeInstanceOf(HTMLDivElement);
  });

  it('does not echo host-applied model snapshots back to the extension', () => {
    captureBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 500)]));
      applyState(storePath('activeSessionId', 'session-1'));

      renderChat();
      sent.length = 0;

      applySessionSelectedModelsSnapshot({
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      });
      flushSolid();

      expect(sent.some((message) => message.type === 'session-model/update')).toBe(false);
    });
  });

  it('publishes unread completion state only for primary sessions', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(
        storePath('sessions', [
          session('primary-1', 500),
          session('child-1', 400, { parentID: 'primary-1' }),
        ])
      );
      applyState(storePath('lastSeenSessions', { 'primary-1': 0, 'child-1': 0 }));
      applyState(storePath('completedSessionResponses', { 'primary-1': 500, 'child-1': 400 }));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('primary-1', 'completed', 500, true),
      ]);
    });
  });

  it('publishes plan attention only while the plan is unread', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('plan-read', 500), session('plan-unread', 400)]));
      applyState(
        storePath('sessionSelectedAgents', { 'plan-read': 'plan', 'plan-unread': 'plan' })
      );
      applyState(storePath('lastSeenSessions', { 'plan-read': 500, 'plan-unread': 0 }));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('plan-read', 'plan-ready', 500, false),
        unreadStateUpdate('plan-unread', 'plan-ready', 400, true),
      ]);

      applyState(storePath('sessions', [session('plan-read', 501), session('plan-unread', 400)]));

      expect(unreadStateUpdates(sent).at(-1)).toEqual(
        unreadStateUpdate('plan-read', 'plan-ready', 501, true)
      );

      applyState(storePath('lastSeenSessions', 'plan-read', 501));
      applyState(storePath('completedSessionResponses', 'plan-read', 600));
      expect(unreadStateUpdates(sent).at(-1)).toEqual(
        unreadStateUpdate('plan-read', 'plan-ready', 600, true)
      );
      sessionStore.markSessionSeen('plan-read', 600);
      flushSolid();
      expect(unreadStateUpdates(sent).at(-1)).toEqual(
        unreadStateUpdate('plan-read', 'plan-ready', 600, false)
      );
    });
  });

  it('does not publish a read completion until its seen marker covers the response', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 500)]));
      applyState(storePath('completedSessionResponses', { 'session-1': 500 }));
      applyState(storePath('lastSeenSessions', { 'session-1': 400 }));
      applyState(storePath('editorTabsOpen', true));
      applyState(storePath('editorSessionIds', ['session-1']));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([]);

      applyState(storePath('lastSeenSessions', 'session-1', 500));

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('session-1', 'completed', 500, false),
      ]);
    });
  });

  it('publishes persisted seen state without a completion marker', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 400)]));
      applyState(storePath('lastSeenSessions', { 'session-1': 500 }));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('session-1', 'completed', 500, false),
      ]);
    });
  });

  it('does not acknowledge a completion hidden by the running settle delay', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 500)]));
      applyState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
      applyState(storePath('lastSeenSessions', { 'session-1': 0 }));
      applyState(storePath('completedSessionResponses', { 'session-1': 500 }));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([]);

      applyState(storePath('sessionStatus', 'session-1', { type: 'idle' }));

      // Still inside the running settle window - nothing is published yet.
      expect(unreadStateUpdates(sent)).toEqual([]);

      vi.advanceTimersByTime(1_200);
      flushSolid();

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('session-1', 'completed', 500, true),
      ]);
    });
  });

  it('does not publish attention flaps while a stepping turn settles', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('plan-1', 500)]));
      applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
      applyState(storePath('lastSeenSessions', { 'plan-1': 0 }));

      renderChat();

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('plan-1', 'plan-ready', 500, true),
      ]);
      sent.length = 0;

      // A stepping turn: busy, a momentary idle gap between steps, busy again.
      applyState(storePath('sessionStatus', { 'plan-1': { type: 'busy' } }));
      applyState(storePath('sessionStatus', 'plan-1', { type: 'idle' }));
      applyState(storePath('sessionStatus', 'plan-1', { type: 'busy' }));

      expect(unreadStateUpdates(sent)).toEqual([]);

      // The turn ends and the running state settles; the already-published
      // state is unchanged, so nothing is re-sent.
      applyState(storePath('sessionStatus', 'plan-1', { type: 'idle' }));
      vi.advanceTimersByTime(1_200);
      flushSolid();

      expect(unreadStateUpdates(sent)).toEqual([]);

      // A real update after the turn publishes exactly once.
      applyState(storePath('sessions', [session('plan-1', 600)]));

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('plan-1', 'plan-ready', 600, true),
      ]);
    });
  });

  it('does not publish plan attention between a question answer and continuation', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('plan-1', 500)]));
      applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
      applyState(storePath('lastSeenSessions', { 'plan-1': 0 }));
      applyState(
        storePath('questions', [{ id: 'question-1', sessionID: 'plan-1', questions: [] }])
      );

      renderChat();
      sent.length = 0;

      removeResolvedQuestion('question-1');
      flushSolid();
      applyState(storePath('sessions', [session('plan-1', 600)]));
      vi.advanceTimersByTime(1_200);
      flushSolid();

      expect(state.questionResponsePendingSessionIds).toEqual(['plan-1']);
      expect(unreadStateUpdates(sent)).toEqual([]);

      sessionStore.setSessionStatusEntry('plan-1', { type: 'busy' });
      flushSolid();
      const completedAt = Date.now();
      sessionStore.setSessionStatusEntry('plan-1', { type: 'idle' });
      flushSolid();
      vi.advanceTimersByTime(1_200);
      flushSolid();

      expect(state.questionResponsePendingSessionIds).toEqual([]);
      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('plan-1', 'plan-ready', completedAt, true),
      ]);
    });
  });

  it('does not republish command state for metadata-only session updates', () => {
    captureBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 1)]));
      applyState(storePath('activeSessionId', 'session-1'));

      renderChat();
      sent.length = 0;

      for (let updated = 2; updated <= 101; updated += 1) {
        applyState(storePath('sessions', [session('session-1', updated)]));
      }

      expect(sent.filter((message) => message.type === 'commands/state')).toEqual([]);
    });
  });

  it('does not report new-chat navigation when Chat is disposed', () => {
    captureBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 1)]));
      applyState(storePath('activeSessionId', 'session-1'));

      renderChat();
      sent.length = 0;
      cleanup?.();
      flushSolid();
      cleanup = undefined;

      const cleanupState = sent.findLast((message) => message.type === 'commands/state');
      expect(cleanupState).toEqual({
        type: 'commands/state',
        payload: { canAbort: false, canSwitchSessions: false, model: null },
      });
      expect(cleanupState?.payload).not.toHaveProperty('sessionId');
    });
  });

  it('publishes a newer completion marker when the unread kind is unchanged', () => {
    captureRepoBridgeMessages((sent) => {
      applyState(storePath('sessions', [session('session-1', 500)]));
      applyState(storePath('lastSeenSessions', { 'session-1': 0 }));
      applyState(storePath('completedSessionResponses', { 'session-1': 500 }));

      renderChat();
      applyState(storePath('completedSessionResponses', 'session-1', 600));

      expect(unreadStateUpdates(sent)).toEqual([
        unreadStateUpdate('session-1', 'completed', 500, true),
        unreadStateUpdate('session-1', 'completed', 600, true),
      ]);
    });
  });

  it('reconciles a restored editor route before reporting a new-chat route', () => {
    const persisted: TestWebviewState[] = [];
    hostWindow.__vscodeWebviewState = {
      getState: () => persisted.at(-1) ?? {},
      setState: (next) => {
        persisted.push(next);
      },
    };
    hostWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    const selectSession = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockImplementation(async (id) => {
        setState(storePath('activeSessionId', id));
      });
    setConnectionInitialized(true);
    flushSolid();

    renderChat();

    expect(selectSession).toHaveBeenCalledOnce();
    expect(selectSession).toHaveBeenCalledWith('session-1');
    expect(state.activeSessionId).toBe('session-1');
    expect(persisted.flatMap((entry) => entry['varro.lastOpenedView'] ?? [])).not.toContainEqual(
      expect.objectContaining({ type: 'new-session' })
    );
    expect(persisted.at(-1)?.['varro.lastOpenedView']).toMatchObject({
      type: 'session',
      sessionId: 'session-1',
    });
  });

  it('preserves the saved editor route during directory activation and publishes the fallback if it fails', async () => {
    const savedRoute = { type: 'session', sessionId: 'to-restore' };
    let webviewState: TestWebviewState = { 'varro.lastOpenedView': savedRoute };
    hostWindow.__vscodeWebviewState = {
      getState: () => webviewState,
      setState: (next) => {
        webviewState = next;
      },
    };
    hostWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { ...savedRoute, directory: '/another-workspace' },
      },
    };
    let finishActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    const select = vi.spyOn(openCodeModule, 'selectSession').mockReturnValue(activation);
    setConnectionInitialized(true);
    flushSolid();
    renderChat();
    expect(select).toHaveBeenCalledExactlyOnceWith('to-restore', {
      directory: '/another-workspace',
    });
    expect(webviewState['varro.lastOpenedView']).toEqual(savedRoute);

    // Failed activation settles selectSession without changing the active ID.
    finishActivation();
    await activation;
    flushSolid();
    expect(webviewState['varro.lastOpenedView']).toMatchObject({ type: 'new-session' });
  });

  it('persists the confirmed editor session route for panel serialization', () => {
    let webviewState: TestWebviewState = {};
    hostWindow.__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
    };
    hostWindow.__vscodeWebviewState = {
      getState: () => webviewState,
      setState: (next) => {
        webviewState = next;
      },
    };
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    setConnectionInitialized(true);
    flushSolid();

    renderChat();

    expect(webviewState['varro.lastOpenedView']).toMatchObject({
      type: 'session',
      sessionId: 'session-1',
    });
  });

  it('shows the active session subagent button beside the title and opens its sub-agent list', async () => {
    applyState(
      storePath('sessions', [
        session('parent', 500),
        session('child-1', 400, { parentID: 'parent' }),
        session('child-2', 300, { parentID: 'parent' }),
        session('other', 200),
      ])
    );
    applyState(storePath('activeSessionId', 'parent'));

    renderChat();

    const headerLeft = container?.querySelector('.chat-header-left');
    const title = headerLeft?.querySelector('.chat-header-title-text');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const subagentsButton = headerLeft?.querySelector(
      '.chat-header-subagents'
    ) as HTMLButtonElement | null;
    const sessionMeta = headerLeft?.querySelector('.chat-header-session-meta');
    const metadataChildren = Array.from(sessionMeta?.children ?? []);

    expect(title?.textContent).toBe('parent');
    expect(sessionMeta?.classList).toContain('has-subagents');
    expect(subagentsButton?.getAttribute('aria-label')).toBe('Show 2 sub-agent sessions');
    expect(subagentsButton?.textContent?.trim()).toBe('2');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect(
      metadataChildren.indexOf(title?.closest('.chat-header-session-title') as Element)
    ).toBeLessThan(metadataChildren.indexOf(subagentsButton as Element));
    flushSolid();

    click(subagentsButton);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    const titles = trimmedTexts('.session-item-title');
    expect(titles).toEqual(['child-1', 'child-2']);
  });

  it('opens the subagents list when background subagent work asks for it', async () => {
    applyState(
      storePath('sessions', [
        session('parent', 500),
        session('child-1', 400, { parentID: 'parent' }),
        session('child-2', 300, { parentID: 'parent' }),
      ])
    );
    applyState(storePath('activeSessionId', 'parent'));
    setShowSessionPicker(false);
    flushSolid();
    renderChat();

    openSubagentSessionsView('parent', 'child-2');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    expect(trimmedTexts('.session-item-title')).toEqual(['child-1', 'child-2']);
    expect(subagentSessionsRequest()).toBeNull();
    expect(state.activeSessionId).toBe('parent');
  });

  it('hides the parent subagent button when the active session is a sub-agent', () => {
    applyState(
      storePath('sessions', [
        session('parent', 500),
        session('child-1', 400, { parentID: 'parent' }),
        session('child-2', 300, { parentID: 'parent' }),
      ])
    );
    applyState(storePath('activeSessionId', 'child-1'));

    renderChat();

    const subagentsButton = queryButton('.chat-header-subagents');
    expect(subagentsButton).toBeNull();
  });

  it('replaces a managed sub-agent composer with a link to its parent session', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);
    applyState(
      storePath('sessions', [
        session('parent', 500, { title: 'Parent task' }),
        session('child', 400, {
          parentID: 'parent',
          model: { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' },
        }),
      ])
    );
    applyState(storePath('activeSessionId', 'child'));
    applyState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5.6-sol': {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 1000, output: 1000 },
              variants: { medium: {}, high: {} },
            },
          },
        },
      ])
    );
    applyState(
      storePath('messages', [
        {
          ...assistantMessageEntry('assistant-child'),
          info: {
            ...assistantMessageEntry('assistant-child').info,
            sessionID: 'child',
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            variant: 'high',
            tokens: {
              input: 600,
              output: 100,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      ])
    );
    applyState(
      storePath('providerLimits', {
        'openai:gpt-5.6-sol': {
          providerID: 'openai',
          modelID: 'gpt-5.6-sol',
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
          ],
        },
      })
    );

    renderChat();

    const footer = container?.querySelector('.managed-subagent-footer');
    const returnButton = footer?.querySelector<HTMLButtonElement>(
      '.managed-subagent-footer-button'
    );
    expect(footer?.querySelector('.managed-subagent-footer-title')?.textContent).toBe(
      'Managed subagent'
    );
    expect(footer?.querySelector('.managed-subagent-footer-description')?.textContent).toContain(
      '"Parent task"'
    );
    expect(container?.querySelector('.interactive-input-part')).toBeNull();
    expect(
      footer?.querySelector('.chat-input-container.managed-subagent-container')
    ).toBeInstanceOf(HTMLDivElement);
    expect(footer?.querySelector('.managed-subagent-toolbar.toolbar-main')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(footer?.querySelector('.model-name-text')?.textContent).toBe('GPT-5.6 Sol');
    expect(footer?.querySelector('.provider-icon')).toBeInstanceOf(HTMLSpanElement);
    expect(footer?.querySelector('.managed-subagent-reasoning')?.textContent?.trim()).toBe('High');
    const contextButton = footer?.querySelector<HTMLButtonElement>('.chat-context-usage');
    const providerLimitButton = footer?.querySelector<HTMLButtonElement>('.toolbar-limit-chip');
    expect(contextButton?.getAttribute('aria-label')).toBe('Context usage (70%)');
    expect(providerLimitButton?.textContent).toContain('Limits:');
    expect(providerLimitButton?.textContent).toContain('39');
    expect(returnButton?.textContent?.trim()).toBe('Return to parent');

    contextButton?.click();
    flushSolid();
    expect(footer?.querySelector('.context-popup')).toBeInstanceOf(HTMLDivElement);
    expect(footer?.querySelector('.context-popup-action')).toBeNull();

    providerLimitButton?.click();
    flushSolid();
    expect(footer?.querySelector('.context-popup')).toBeNull();
    expect(footer?.querySelector('.provider-limit-popup')).toBeInstanceOf(HTMLDivElement);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(footer?.querySelector('.provider-limit-popup')).toBeNull();
    expect(container?.querySelector('.managed-subagent-footer')).toBeInstanceOf(HTMLDivElement);
    expect(selectSessionSpy).not.toHaveBeenCalled();

    returnButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
  });

  it('returns from an active sub-agent session to its top session sub-agent list', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })])
    );
    applyState(storePath('activeSessionId', 'child'));

    renderChat();

    const backButton = queryButton(
      '.chat-header .chat-header-btn[aria-label="Back to sub-agent sessions"]'
    );
    expect(backButton).toBeInstanceOf(HTMLButtonElement);
    expect(
      container?.querySelectorAll('.chat-header-btn[aria-label="Back to sub-agent sessions"]')
    ).toHaveLength(1);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.session-item-title')?.textContent?.trim()).toBe('child');
  });

  it('returns directly to the parent session when the sub-agent was opened from its task', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })])
    );
    applyState(storePath('activeSessionId', 'child'));
    rememberDirectSessionReturn('child', 'parent');
    flushSolid();

    renderChat();

    const backButton = queryButton(
      '.chat-header .chat-header-btn[aria-label="Back to parent session"]'
    );
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('returns directly from a Ralph subsession to its manager session', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [
        session('manager', 500),
        session('ralph-child', 400, { parentID: 'manager' }),
      ])
    );
    applyState(storePath('activeSessionId', 'ralph-child'));
    ralphStore.startRun({
      managerSessionId: 'manager',
      workspaceDirectory: '/workspace',
      planDocPath: 'PLAN.md',
      iterations: 1,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    flushSolid();
    ralphStore.upsertIteration('manager', {
      index: 1,
      childSessionId: 'ralph-child',
      status: 'running',
      startedAt: 1,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });
    flushSolid();

    renderChat();

    const backButton = container?.querySelector<HTMLButtonElement>(
      '.chat-header .chat-header-btn[aria-label="Back to parent session"]'
    );
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    backButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('manager');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('returns directly to the originating top-level session after following a session link', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(storePath('sessions', [session('origin', 500), session('linked', 400)]));
    applyState(storePath('activeSessionId', 'linked'));
    rememberDirectSessionReturn('linked', 'origin');
    flushSolid();

    renderChat();

    const backButton = queryButton(
      '.chat-header .chat-header-btn[aria-label="Back to parent session"]'
    );
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('origin');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('shows desktop sub-agent navigation in both the chat header and session sidebar', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);
    desktopMediaQueryMatches = true;
    applyState(
      storePath('sessions', [
        session('parent', 500),
        session('child', 400, { parentID: 'parent' }),
        session('sibling', 300, { parentID: 'parent' }),
        session('other', 200),
      ])
    );
    applyState(storePath('activeSessionId', 'child'));

    renderChat();

    const desktopBackButton = queryButton(
      '.chat-header-chat-desktop .chat-header-btn[aria-label="Back to parent session"]'
    );
    const sidebar = container?.querySelector('.session-list-view-sidebar');
    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');
    expect(desktopBackButton).toBeInstanceOf(HTMLButtonElement);
    expect(
      container?.querySelectorAll('.chat-header-btn[aria-label="Back to parent session"]')
    ).toHaveLength(1);
    expect(sidebarHeader?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    expect(
      sidebarHeader?.querySelector('.chat-header-btn[aria-label="Back to sessions"]')
    ).toBeInstanceOf(HTMLButtonElement);
    expect(trimmedTexts('.session-item-title', sidebar)).toEqual(['child', 'sibling']);

    sidebarHeader
      ?.querySelector<HTMLButtonElement>('.chat-header-btn[aria-label="Back to sessions"]')
      ?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(trimmedTexts('.session-item-title', sidebar)).toEqual(['parent', 'other']);
    expect(selectSessionSpy).not.toHaveBeenCalled();

    desktopBackButton?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
  });

  it('returns from a nested sub-agent session to the top session sub-agent list', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [
        session('top', 500),
        session('child', 400, { parentID: 'top' }),
        session('grandchild', 300, { parentID: 'child' }),
      ])
    );
    applyState(storePath('activeSessionId', 'grandchild'));

    renderChat();

    const topButton = queryButton(
      '.chat-header .chat-header-btn[aria-label="Back to sub-agent sessions"]'
    );
    expect(topButton).toBeInstanceOf(HTMLButtonElement);

    click(topButton);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for top'
    );
    const titles = trimmedTexts('.session-item-title');
    expect(titles).toEqual(['child', 'grandchild']);
  });

  it('returns from the sub-agent list to the parent session', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })])
    );
    applyState(storePath('activeSessionId', 'parent'));

    renderChat();

    const subagentsButton = queryButton('.chat-header-subagents');
    click(subagentsButton);
    await Promise.resolve();
    flushSolid();

    const backButton = queryButton(
      '.chat-header .chat-header-btn[aria-label="Back to parent session"]'
    );
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('shows session status badges in the desktop session sidebar header', () => {
    applyState(
      storePath('sessions', [
        session('running-1', 500),
        session('failed-1', 400),
        session('attention-1', 300),
        session('plan-1', 200),
        session('completed-1', 150),
        session('session-1', 100),
      ])
    );
    applyState(storePath('activeSessionId', 'running-1'));
    applyState(
      storePath('sessionStatus', {
        'running-1': { type: 'busy' },
      })
    );
    applyState(storePath('failedSessionIds', ['failed-1']));
    applyState(
      storePath('questions', [{ id: 'question-1', sessionID: 'attention-1', questions: [] }])
    );
    applyState(storePath('lastSeenSessions', { 'plan-1': 0 }));
    applyState(storePath('completedSessionResponses', { 'completed-1': 150 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));

    renderChat();

    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');

    expect(sidebarHeader?.querySelector('.chat-header-failed-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-attention-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-plan-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-completed-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-running-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(sidebarHeader?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    expect(sidebarHeader?.querySelector('.chat-header-btn[aria-label="New chat"]')).toBeInstanceOf(
      HTMLButtonElement
    );
  });

  it('auto-opens the only filtered sibling session from the chat header', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(storePath('sessions', [session('active', 500), session('failed-target', 400)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('failedSessionIds', ['failed-target']));

    renderChat();

    const failedBadge = queryButton('.chat-header-failed-badge');
    expect(failedBadge).toBeInstanceOf(HTMLButtonElement);

    click(failedBadge);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('failed-target');
    expect(container?.querySelector('.chat-header-filter-chip')).toBeNull();
  });

  it('switches to a draft chat view without creating a session', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');

    applyState(storePath('sessions', [session('active', 500)]));
    applyState(storePath('activeSessionId', 'active'));
    openSessionPicker();

    renderChat();

    const newChatButton = queryButton('.chat-header .chat-header-btn[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    click(newChatButton);
    await Promise.resolve();
    flushSolid();

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBeNull();
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
    expect(container?.querySelector('.chat-main-shell')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-header .chat-header-title-text')?.textContent).toBe(
      'New Chat'
    );
  });

  it('keeps the created session active when sending from the restored sessions screen', async () => {
    setConnectionInitialized(true);
    flushSolid();
    applyState(storePath('sessions', [session('existing', 500)]));
    applyState(storePath('activeSessionId', null));
    applyState(storePath('messagesLoading', false));
    openSessionPicker();
    setInputText('Continue work in this workspace');
    flushSolid();
    const send = vi
      .spyOn(openCodeModule, 'sendMessage')
      .mockImplementation(async (_text, options) => {
        // A server update can advance the timestamp before optimistic publication.
        setState(storePath('sessions', [session('created', Date.now()), session('existing', 500)]));
        setState(storePath('activeSessionId', 'created'));
        options?.onOptimisticPublish?.();
        return true;
      });

    renderChat();
    const button = container?.querySelector<HTMLButtonElement>('[aria-label="Send (Enter)"]');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    click(button);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    flushSolid();

    expect(state.activeSessionId).toBe('created');
    expect(container?.querySelector('.session-list-new-session')).toBeNull();
    expect(container?.querySelector('.chat-main-shell')).not.toBeNull();
    setInputText('');
    flushSolid();
  });

  it('removes a busy streaming transcript when the new-chat button receives a pointer click', async () => {
    const streamingMessage = assistantMessageEntry('assistant-streaming');
    streamingMessage.info.time = { created: 1 };
    streamingMessage.parts = [
      {
        id: 'text-streaming',
        sessionID: 'session-1',
        messageID: 'assistant-streaming',
        type: 'text',
        text: '',
      },
    ];
    applyState(storePath('sessions', [session('session-1', 500, { title: 'Streaming session' })]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    applyState(storePath('messages', [streamingMessage]));
    applyState(storePath('streamingPartId', 'text-streaming'));
    applyState(storePath('streamingText', 'Old streaming transcript'));
    startLoading();
    flushSolid();

    renderChat();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-msg-id="assistant-streaming"]')).not.toBeNull();

    const newChatButton = container?.querySelector<HTMLButtonElement>(
      '.chat-header .chat-header-btn[aria-label="New chat"]'
    );
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);
    newChatButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    flushSolid();
    newChatButton?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    flushSolid();
    newChatButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(state.activeSessionId).toBeNull();
    expect(container?.querySelector('[data-msg-id="assistant-streaming"]')).toBeNull();
    expect(container?.querySelector('.chat-header .chat-header-title-text')?.textContent).toBe(
      'New Chat'
    );

    await vi.advanceTimersByTimeAsync(17);
    flushSolid();

    expect(state.messages).toEqual([]);
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('reuses an untouched active session instead of creating another from chat view', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const now = Date.now();
    applyState(storePath('sessions', [untouchedSession('draft-session', now, 'New session')]));
    applyState(storePath('activeSessionId', 'draft-session'));

    renderChat();

    const newChatButton = queryButton('.chat-header .chat-header-btn[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    click(newChatButton);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('draft-session');
  });

  it('reuses an untouched active session instead of creating another from the session picker', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const now = Date.now();
    applyState(storePath('sessions', [untouchedSession('draft-session', now, 'New session')]));
    applyState(storePath('activeSessionId', 'draft-session'));
    openSessionPicker();

    renderChat();

    const newChatButton = queryButton('.chat-header .chat-header-btn[aria-label="New chat"]');
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    click(newChatButton);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('draft-session');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('deletes an untouched active session when returning to the sessions list', async () => {
    const deleteImmediatelySpy = spyOnDeleteImmediately();

    const now = Date.now();
    applyState(storePath('sessions', [untouchedSession('draft-session', now, 'New session')]));
    applyState(storePath('activeSessionId', 'draft-session'));

    renderChat();

    const backButton = queryButton('.chat-header .chat-header-btn[aria-label="Back to sessions"]');
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    expect(deleteImmediatelySpy).toHaveBeenCalledWith('draft-session');
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('filters completed sessions from the header badge', async () => {
    applyState(
      storePath('sessions', [
        session('active', 500),
        session('completed-1', 400),
        session('completed-2', 300),
        session('other', 200),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('lastSeenSessions', { active: 500, other: 200 }));
    applyState(storePath('completedSessionResponses', { 'completed-1': 400, 'completed-2': 300 }));

    renderChat();

    const completedBadge = queryButton('.chat-header-completed-badge');
    expect(completedBadge).toBeInstanceOf(HTMLButtonElement);

    click(completedBadge);
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Completed'
    );
    const titles = trimmedTexts('.session-item-title');
    expect(titles).toEqual(['completed-1', 'completed-2']);
  });

  it('keeps the active completed session out of the chat header but shows it in the sessions list', () => {
    applyState(storePath('sessions', [session('active-completed', 500), session('other', 400)]));
    applyState(storePath('activeSessionId', 'active-completed'));
    applyState(storePath('lastSeenSessions', { other: 400 }));
    applyState(storePath('completedSessionResponses', { 'active-completed': 500 }));

    renderChat();

    const chatHeader = container?.querySelector('.interactive-session > .chat-header');
    expect(chatHeader?.querySelector('.chat-header-completed-badge')).toBeNull();
    expect(
      container?.querySelector('.chat-session-sidebar-header .chat-header-completed-badge')
    ).toBeInstanceOf(HTMLButtonElement);
    const activeIndicator = Array.from(container?.querySelectorAll('.session-item') ?? [])
      .find(
        (item) =>
          item.querySelector('.session-item-title')?.textContent?.trim() === 'active-completed'
      )
      ?.querySelector('.session-item-indicator');
    expect(activeIndicator?.classList.contains('is-completed')).toBe(true);
  });

  it.each([false, true])(
    'marks only filtered completed sessions as read with desktop layout %s',
    async (desktopLayout) => {
      const warn = vi.spyOn(console, 'warn');
      desktopMediaQueryMatches = desktopLayout;
      const future = Date.now() + 10_000;
      const send = vi.fn<(message: WebviewMessage) => void>();
      // SAFETY: The fixture provides the bridge callback used by postMessage.
      const bridgeWindow = window as {
        __sendToExtension?: (message: WebviewMessage) => void;
      };
      const previousSend = bridgeWindow.__sendToExtension;
      bridgeWindow.__sendToExtension = send;
      try {
        applyState(
          storePath('sessions', [
            session('completed-1', future),
            session('completed-2', 300),
            session('running', 250),
            session('plan', 200),
            session('child', 150, { parentID: 'completed-1' }),
          ])
        );
        applyState(storePath('sessionStatus', { running: { type: 'busy' } }));
        applyState(storePath('sessionSelectedAgents', { plan: 'plan' }));
        applyState(
          storePath('completedSessionResponses', {
            'completed-1': future + 500,
            'completed-2': 300,
            running: 250,
            child: 150,
          })
        );
        openSessionPicker();
        renderChat();
        expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();

        requestOpenCompletedSessions();
        await Promise.resolve();
        flushSolid();
        const header = container?.querySelector(
          desktopLayout ? '.chat-session-sidebar-header' : '.interactive-session > .chat-header'
        );
        const markAllRead = header?.querySelector<HTMLButtonElement>(
          '[aria-label="Mark all as read"]'
        );
        expect(markAllRead).toBeInstanceOf(HTMLButtonElement);
        expect(markAllRead!.textContent?.trim()).toBe('Mark all as read');
        expect(header?.querySelector('.chat-header-filter-chip')?.nextElementSibling).toBe(
          markAllRead
        );
        expect(markAllRead!.closest('.chat-header-left')).not.toBeNull();
        flushSolid();
        expect(markAllRead!.querySelector('.ui-icon')).toBeNull();
        markAllRead!.click();
        flushSolid();

        expect(state.lastSeenSessions['completed-1']).toBeGreaterThanOrEqual(future + 500);
        expect(state.lastSeenSessions['completed-2']).toBeGreaterThanOrEqual(300);
        for (const id of ['running', 'plan', 'child']) {
          expect(state.lastSeenSessions[id]).toBeUndefined();
        }
        expect(state.activeSessionId).toBeNull();
        expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
          'Completed'
        );
        expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
        expect(container?.querySelector('.session-item')).toBeNull();
        for (const id of ['completed-1', 'completed-2']) {
          expect(send).toHaveBeenCalledWith({
            type: 'session-read-state/update',
            payload: { sessionId: id, seenAt: state.lastSeenSessions[id] },
          });
        }

        applyState(storePath('completedSessionResponses', 'completed-1', future + 1_000));
        expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
        applyState(storePath('completedSessionResponses', 'completed-2', future + 1_000));
        expect(container?.querySelector('[aria-label="Mark all as read"]')).not.toBeNull();
        sessionStore.markSessionSeen('completed-1', future + 1_000);
        flushSolid();
        expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        bridgeWindow.__sendToExtension = previousSend;
      }
    }
  );

  it('marks plans as read without skipping them', async () => {
    const warn = vi.spyOn(console, 'warn');
    applyState(
      storePath('sessions', [session('plan-1', 400), session('plan-2', 300), session('other', 200)])
    );
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan', 'plan-2': 'plan' }));
    openSessionPicker();
    renderChat();
    container?.querySelector<HTMLButtonElement>('.chat-header-plan-badge')!.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container?.querySelector<HTMLButtonElement>('[aria-label="Mark all as read"]')!.click();
    flushSolid();

    expect(state.lastSeenSessions['plan-1']).toBeGreaterThanOrEqual(400);
    expect(state.lastSeenSessions['plan-2']).toBeGreaterThanOrEqual(300);
    expect(state.lastSeenSessions.other).toBeUndefined();
    expect(state.skippedPlanSessions['plan-1']).toBeUndefined();
    expect(state.skippedPlanSessions['plan-2']).toBeUndefined();
    expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
    expect(container?.querySelectorAll('.session-item')).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('acknowledges child failures without clearing failure status', async () => {
    const warn = vi.spyOn(console, 'warn');
    const failedAt = Date.now() + 10_000;
    applyState(
      storePath('sessions', [
        session('root', 400),
        session('child', failedAt, { parentID: 'root' }),
        session('failed', 300),
        session('other', 200),
      ])
    );
    applyState(storePath('failedSessionIds', ['child', 'failed']));
    applyState(storePath('failedSessionUpdatedAt', { child: failedAt, failed: 300 }));
    openSessionPicker();
    renderChat();
    container?.querySelector<HTMLButtonElement>('.chat-header-failed-badge')!.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    container?.querySelector<HTMLButtonElement>('[aria-label="Mark all as read"]')!.click();
    flushSolid();

    expect(state.lastSeenSessions.root).toBeGreaterThanOrEqual(failedAt);
    expect(state.lastSeenSessions.failed).toBeGreaterThanOrEqual(300);
    expect(state.lastSeenSessions.other).toBeUndefined();
    expect(state.failedSessionIds).toEqual(['child', 'failed']);
    expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
    expect(container?.querySelectorAll('.session-item')).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not offer mark all as read for pending questions', async () => {
    applyState(storePath('sessions', [session('attention-1', 400), session('attention-2', 300)]));
    const questions = [
      { id: 'question-1', sessionID: 'attention-1', questions: [] },
      { id: 'question-2', sessionID: 'attention-2', questions: [] },
    ];
    applyState(storePath('questions', questions));
    openSessionPicker();
    renderChat();
    container?.querySelector<HTMLButtonElement>('.chat-header-attention-badge')!.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Needs attention'
    );
    expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
    expect(state.questions).toEqual(questions);
  });

  it.each(['plan-ready', 'failed'])(
    'hides mark all as read with one unread session in the %s filter',
    async (filter) => {
      applyState(storePath('sessions', [session('first', 400), session('second', 300)]));
      if (filter === 'plan-ready') {
        applyState(storePath('sessionSelectedAgents', { first: 'plan', second: 'plan' }));
      } else {
        applyState(storePath('failedSessionIds', ['first', 'second']));
        applyState(storePath('failedSessionUpdatedAt', { first: 400, second: 300 }));
      }
      flushSolid();
      openSessionPicker();
      renderChat();
      container
        ?.querySelector<HTMLButtonElement>(
          filter === 'plan-ready' ? '.chat-header-plan-badge' : '.chat-header-failed-badge'
        )!
        .click();
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(container?.querySelector('[aria-label="Mark all as read"]')).not.toBeNull();

      sessionStore.markSessionSeen('first');
      flushSolid();

      expect(container?.querySelectorAll('.session-item')).toHaveLength(2);
      expect(container?.querySelector('[aria-label="Mark all as read"]')).toBeNull();
    }
  );

  it('opens completed sessions when the desktop sidebar badge only counts the active session', async () => {
    applyState(storePath('sessions', [session('active-completed', 500), session('other', 400)]));
    applyState(storePath('activeSessionId', 'active-completed'));
    applyState(storePath('lastSeenSessions', { other: 400 }));
    applyState(storePath('completedSessionResponses', { 'active-completed': 500 }));

    renderChat();

    const completedBadge = container?.querySelector<HTMLButtonElement>(
      '.chat-session-sidebar-header .chat-header-completed-badge'
    );
    expect(completedBadge).toBeInstanceOf(HTMLButtonElement);

    completedBadge?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Completed'
    );
    expect(container?.querySelector('.session-item-title')?.textContent?.trim()).toBe(
      'active-completed'
    );
  });

  it('keeps the active completed session indicator when its messages are loaded', () => {
    applyState(storePath('sessions', [session('session-1', 500), session('other', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('lastSeenSessions', { other: 400 }));
    applyState(storePath('completedSessionResponses', { 'session-1': 500 }));
    applyState(storePath('messages', [assistantMessageEntry('assistant-1')]));

    renderChat();

    const activeIndicator = Array.from(container?.querySelectorAll('.session-item') ?? [])
      .find(
        (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'session-1'
      )
      ?.querySelector('.session-item-indicator');
    expect(activeIndicator?.classList.contains('is-completed')).toBe(true);
  });

  it('does not treat generic unread session updates as completed responses', () => {
    applyState(storePath('sessions', [session('active', 500), session('metadata-update', 400)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('lastSeenSessions', { active: 500, 'metadata-update': 0 }));

    renderChat();

    expect(container?.querySelector('.chat-header-completed-badge')).toBeNull();
    const indicator = Array.from(container?.querySelectorAll('.session-item') ?? [])
      .find(
        (item) =>
          item.querySelector('.session-item-title')?.textContent?.trim() === 'metadata-update'
      )
      ?.querySelector('.session-item-indicator');
    expect(indicator).toBeNull();
  });

  it('shows pending permission indicators before running indicators in the sessions list', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'Allow bash',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );

    renderChat();

    const indicator = container?.querySelector('.session-item-indicator');
    expect(indicator?.classList.contains('is-attention')).toBe(true);
    expect(indicator?.getAttribute('title')).toBe('Permission request pending');
  });

  it('leaves running spinner timing to CSS', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    openSessionPicker();

    renderChat();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const headerSpinner = container?.querySelector(
      '.chat-header-running-spinner'
    ) as HTMLElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const indicator = container?.querySelector(
      '.session-item .session-item-indicator'
    ) as HTMLElement | null;

    expect(headerSpinner?.style.animationDelay).toBe('');
    expect(indicator?.classList.contains('is-running')).toBe(true);
    expect(indicator?.style.animationDelay).toBe('');
  });

  it('keeps the active session in the sessions picker after returning from chat', async () => {
    const now = Date.now();
    applyState(
      storePath('sessions', [
        session('active-completed', now - 1_000),
        session('plan-ready', now - 2_000),
        session('other', now - 3_000),
      ])
    );
    applyState(storePath('activeSessionId', 'active-completed'));
    applyState(
      storePath('lastSeenSessions', {
        'active-completed': now - 1_000,
        'plan-ready': 0,
        other: now - 3_000,
      })
    );
    applyState(storePath('sessionSelectedAgents', { 'plan-ready': 'plan' }));

    renderChat();

    const backButton = queryButton('.chat-header .chat-header-btn[aria-label="Back to sessions"]');
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    click(backButton);
    await Promise.resolve();
    flushSolid();

    const titles = trimmedTexts('.session-item-title');

    expect(titles).toEqual(['active-completed', 'plan-ready', 'other']);
  });

  it('keeps opening the filtered session list when multiple sibling sessions match', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(
      storePath('sessions', [
        session('active', 500),
        session('failed-1', 400),
        session('failed-2', 300),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('failedSessionIds', ['failed-1', 'failed-2']));

    renderChat();

    const failedBadge = queryButton('.chat-header-failed-badge');
    expect(failedBadge).toBeInstanceOf(HTMLButtonElement);

    click(failedBadge);
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).not.toHaveBeenCalled();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('opens attention sessions from state and auto-selects a single match', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(storePath('sessions', [session('active', 500), session('attention-target', 400)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(
      storePath('questions', [{ id: 'question-1', sessionID: 'attention-target', questions: [] }])
    );

    renderChat();

    requestOpenAttentionSessions();
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('attention-target');
    expect(container?.querySelector('.chat-header-filter-chip')).toBeNull();
  });

  it('opens a failed session when the attention command has no pending prompts', async () => {
    // SAFETY: The fixture provides the never fields read by this statement.
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    applyState(storePath('sessions', [session('active', 500), session('failed-target', 400)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('failedSessionIds', ['failed-target']));

    renderChat();

    requestOpenAttentionSessions();
    await Promise.resolve();
    flushSolid();

    expect(selectSessionSpy).toHaveBeenCalledWith('failed-target');
    expect(container?.querySelector('.chat-header-filter-chip')).toBeNull();
  });

  it('opens completed sessions from state and keeps multiple matches filtered', async () => {
    applyState(
      storePath('sessions', [
        session('active', 500),
        session('completed-1', 400),
        session('completed-2', 300),
      ])
    );
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('lastSeenSessions', { active: 500 }));
    applyState(storePath('completedSessionResponses', { 'completed-1': 400, 'completed-2': 300 }));

    renderChat();

    requestOpenCompletedSessions();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Completed'
    );
    const titles = trimmedTexts('.session-item-title');
    expect(titles).toEqual(['completed-1', 'completed-2']);
  });

  it('hides skipped plans from the plan-ready badge', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('lastSeenSessions', { 'plan-1': 0 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    skipPlanSession('plan-1', 200);

    renderChat();

    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');
    expect(sidebarHeader?.querySelector('.chat-header-plan-badge')).toBeNull();
  });

  it('keeps seen plans ready without showing the header badge', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    openSessionPicker();

    const indicators = deriveSessionIndicators(state.sessions);
    expect(indicators.planReadyIds.has('plan-1')).toBe(true);
    expect(indicators.newlyCompletedIds.has('plan-1')).toBe(false);

    renderChat();

    expect(container?.querySelector('.chat-header-plan-badge')).toBeNull();
  });

  it('does not show plan-ready indicators for a session visible in an editor tab', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('activeSessionId', 'plan-1'));
    applyState(storePath('lastSeenSessions', { 'plan-1': 0, 'session-1': 100 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('editorTabsOpen', true));
    applyState(storePath('editorSessionIds', ['plan-1']));
    openSessionPicker();

    const indicators = deriveSessionIndicators(state.sessions);
    expect(indicators.planReadyIds.has('plan-1')).toBe(false);

    renderChat();

    expect(container?.querySelector('.chat-header-plan-badge')).toBeNull();
    expect(container?.querySelector('.session-item-indicator.is-plan-completed')).toBeNull();
  });

  it('does not mark an empty session with the plan agent as plan ready', () => {
    applyState(
      storePath('sessions', [
        session('plan-blank', 200, { time: { created: 200, updated: 200 } }),
        session('plan-done', 100),
      ])
    );
    applyState(storePath('sessionSelectedAgents', { 'plan-blank': 'plan', 'plan-done': 'plan' }));

    const indicators = deriveSessionIndicators(state.sessions);
    expect(indicators.planReadyIds.has('plan-blank')).toBe(false);
    expect(indicators.planReadyIds.has('plan-done')).toBe(true);
  });

  it('does not mark a plan root ready when a child session failed', () => {
    applyState(
      storePath('sessions', [
        session('plan-1', 200),
        session('child-1', 100, { parentID: 'plan-1' }),
      ])
    );
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('failedSessionIds', ['child-1']));

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('plan-1')).toBe(true);
    expect(indicators.planReadyIds.has('plan-1')).toBe(false);
  });

  it('keeps seen plan sessions in the plan-ready session group', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));

    const indicators = deriveSessionIndicators(state.sessions);

    const groups = groupSessions(
      state.sessions,
      () => false,
      () => false,
      () => false,
      (item) => indicators.planReadyIds.has(item.id),
      (item) => indicators.newlyCompletedIds.has(item.id),
      1_000
    );

    expect(groups.planReady.map((item) => item.id)).toEqual(['plan-1']);
  });

  it('does not show a skip button in the session list for plan-ready sessions', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));

    renderChat();

    expect(container?.querySelector('.session-item-plan-skip')).toBeNull();
    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).some(
        (item) => item.textContent?.trim() === 'plan-1'
      )
    ).toBe(true);
  });

  it('shows a plan tag before trailing session metadata for running plan sessions', () => {
    applyState(
      storePath('sessions', [
        session('plan-1', 300),
        session('plan-child', 250, { parentID: 'plan-1' }),
        session('session-1', 200),
      ])
    );
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('sessionStatus', { 'plan-1': { type: 'busy' } }));

    renderChat();

    const planRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
    );
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const trailing = planRow?.querySelector('.session-item-trailing') as HTMLDivElement | null;
    const planTag = trailing?.querySelector('.session-item-plan-tag');
    const subagentsButton = trailing?.querySelector('.session-item-subagents');
    const age = trailing?.querySelector('.session-item-age');
    const trailingChildren = Array.from(trailing?.children ?? []);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const planTagIndex = trailingChildren.indexOf(planTag as Element);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const subagentsIndex = trailingChildren.indexOf(subagentsButton as Element);
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const ageIndex = trailingChildren.indexOf(age as Element);

    expect(planTag?.textContent?.trim()).toBe('Plan');
    expect(planTagIndex).toBeGreaterThanOrEqual(0);
    if (subagentsIndex >= 0) expect(planTagIndex).toBeLessThan(subagentsIndex);
    expect(planTagIndex).toBeLessThan(ageIndex);
  });

  it('hides the indicator but keeps the plan tag for seen plan-ready sessions', () => {
    applyState(storePath('sessions', [session('plan-1', 200), session('session-1', 100)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(storePath('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 }));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));

    renderChat();

    const planRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
    );

    expect(planRow?.querySelector('.session-item-indicator')).toBeNull();
    expect(planRow?.querySelector('.session-item-plan-tag')?.textContent?.trim()).toBe('Plan');
  });

  it('orders the default session list by age only', () => {
    applyState(
      storePath('sessions', [
        session('running-newest', 500),
        session('failed-middle', 400),
        session('attention-oldest', 300),
      ])
    );
    applyState(storePath('activeSessionId', 'running-newest'));
    applyState(
      storePath('sessionStatus', {
        'running-newest': { type: 'busy' },
      })
    );
    applyState(storePath('failedSessionIds', ['failed-middle']));
    applyState(
      storePath('questions', [{ id: 'question-1', sessionID: 'attention-oldest', questions: [] }])
    );

    renderChat();

    const sidebar = container?.querySelector('.session-list-view-sidebar');
    const titles = trimmedTexts('.session-item-title', sidebar);

    expect(titles).toEqual(['running-newest', 'failed-middle', 'attention-oldest']);
  });

  it('shows native session search results from the search input', async () => {
    const sessions = [
      session('session-1', 500, { title: 'Alpha build' }),
      session('session-2', 400, { title: 'Beta follow-up' }),
      session('session-3', 300, { title: 'Gamma review', directory: '/workspace/reports' }),
    ];
    vi.spyOn(client.session, 'list').mockResolvedValue({
      items: [sessions[2]!],
      hasMore: false,
    });
    applyState(storePath('sessions', sessions));
    applyState(storePath('activeSessionId', 'session-1'));
    openSessionPicker();

    renderChat();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    expect(input).toBeInstanceOf(HTMLInputElement);

    input!.value = 'gamma';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();

    await vi.waitFor(() => {
      const titles = trimmedTexts('.session-item-title');
      expect(titles).toEqual(['Gamma review']);
    });
    flushSolid();
  });

  it('resets keyboard-focused session when the search input regains focus', async () => {
    applyState(
      storePath('sessions', [
        session('session-1', 500, { title: 'Alpha build' }),
        session('session-2', 400, { title: 'Beta follow-up' }),
        session('session-3', 300, { title: 'Gamma review' }),
      ])
    );
    applyState(storePath('activeSessionId', 'session-1'));
    openSessionPicker();

    renderChat();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    const items = Array.from(container?.querySelectorAll('.session-item') ?? []);
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(items).toHaveLength(3);

    items[2]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    flushSolid();
    expect(items[2]?.classList.contains('keyboard-focus')).toBe(true);

    input!.dispatchEvent(new FocusEvent('focus'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.session-item.keyboard-focus')).toBeNull();
  });

  it('shows an empty state for a search with no matching sessions', async () => {
    const sessions = [session('session-1', 500, { title: 'Alpha build' })];
    vi.spyOn(client.session, 'list').mockResolvedValue({ items: [], hasMore: false });
    applyState(storePath('sessions', sessions));
    openSessionPicker();

    renderChat();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    expect(input).toBeInstanceOf(HTMLInputElement);

    input!.value = 'missing';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();

    await vi.waitFor(() => {
      expect(container?.querySelector('.session-empty')?.textContent?.trim()).toBe(
        'No matching sessions'
      );
    });
    flushSolid();
  });

  it('keeps all group headers outside the expanded section scroll region', () => {
    const now = Date.now();
    applyState(
      storePath('sessions', [
        session('recent-session', now - 1_000, { title: 'Recent session' }),
        ...Array.from({ length: 49 }, (_, index) => session(`recent-${index}`, now - 2_000)),
        session('older-session', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session' }),
      ])
    );
    applyState(storePath('activeSessionId', 'recent-session'));
    applyState(
      storePath('lastSeenSessions', {
        'recent-session': now - 1_000,
        'older-session': now - (24 * 60 * 60 * 1_000 + 1),
      })
    );
    openSessionPicker();

    renderChat();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const sections = container?.querySelector('.session-list-sections') as HTMLDivElement | null;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const scrollRegion = sections?.querySelector(
      '.session-list-section.expanded .session-list-section-scroll'
    ) as HTMLDivElement | null;

    expect(sections).toBeInstanceOf(HTMLDivElement);
    expect(scrollRegion).toBeInstanceOf(HTMLDivElement);
    expect(trimmedTexts('.session-item-title', scrollRegion)).toEqual([
      'Recent session',
      ...Array.from({ length: 49 }, (_, index) => `recent-${index}`),
    ]);
    expect(trimmedTexts('.session-list-section-title', sections)).toEqual(['Archive']);
    expect(scrollRegion?.querySelector('.session-list-section-header')).toBeNull();
  });

  it('keeps showing sessions in the default list when all are older than one day', () => {
    const now = Date.now();
    applyState(
      storePath('sessions', [
        session('older-session-a', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session A' }),
        session('older-session-b', now - (2 * 24 * 60 * 60 * 1_000 + 1), {
          title: 'Older session B',
        }),
      ])
    );
    applyState(storePath('activeSessionId', 'older-session-a'));
    applyState(
      storePath('lastSeenSessions', {
        'older-session-a': now - (24 * 60 * 60 * 1_000 + 1),
        'older-session-b': now - (2 * 24 * 60 * 60 * 1_000 + 1),
      })
    );
    openSessionPicker();

    renderChat();

    expect(trimmedTexts('.session-item-title')).toEqual(['Older session A', 'Older session B']);
    expect(container?.querySelector('.session-list-bottom-groups')).toBeNull();
  });

  it('keeps group headers visible when archive is expanded', async () => {
    const now = Date.now();
    applyState(
      storePath('sessions', [
        session('recent-session', now - 1_000),
        ...Array.from({ length: 49 }, (_, index) => session(`recent-${index}`, now - 2_000)),
        session('older-session', now - (24 * 60 * 60 * 1_000 + 1)),
      ])
    );
    applyState(storePath('activeSessionId', 'recent-session'));
    applyState(
      storePath('lastSeenSessions', {
        'recent-session': now - 1_000,
        'older-session': now - (24 * 60 * 60 * 1_000 + 1),
      })
    );
    openSessionPicker();

    renderChat();

    const button = sectionToggle('Archive');
    expect(button).toBeInstanceOf(HTMLButtonElement);

    click(button);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const sectionTitles = trimmedTexts('.session-list-section-title');
    const sessionTitles = trimmedTexts('.session-item-title');

    expect(sectionTitles).toEqual(['Recent', 'Archive']);
    expect(sessionTitles).toEqual(['older-session']);
  });

  it('shows recent sessions in an ephemeral group when archive is open', async () => {
    const now = Date.now();
    applyState(
      storePath('sessions', [
        session('recent-session', now - 1_000, { title: 'Recent session' }),
        ...Array.from({ length: 49 }, (_, index) => session(`recent-${index}`, now - 2_000)),
        session('older-session', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session' }),
      ])
    );
    applyState(storePath('activeSessionId', 'recent-session'));
    applyState(
      storePath('lastSeenSessions', {
        'recent-session': now - 1_000,
        'older-session': now - (24 * 60 * 60 * 1_000 + 1),
      })
    );
    openSessionPicker();

    renderChat();

    const archiveToggle = sectionToggle('Archive');
    expect(archiveToggle).toBeInstanceOf(HTMLButtonElement);

    click(archiveToggle);
    await Promise.resolve();
    flushSolid();

    const sectionTitles = trimmedTexts('.session-list-section-title');
    const sessionTitles = trimmedTexts('.session-item-title');

    expect(sectionTitles).toEqual(['Recent', 'Archive']);
    expect(sessionTitles).toEqual(['Older session']);

    const recentToggle = sectionToggle('Recent');
    expect(recentToggle).toBeInstanceOf(HTMLButtonElement);

    click(recentToggle);
    await Promise.resolve();
    flushSolid();

    const expandedSectionTitles = trimmedTexts('.session-list-section-title');
    const expandedSessionTitles = trimmedTexts('.session-item-title');

    expect(expandedSectionTitles).toEqual(['Archive']);
    expect(expandedSessionTitles).toEqual([
      'Recent session',
      ...Array.from({ length: 49 }, (_, index) => `recent-${index}`),
    ]);
  });

  it('keeps group headers visible when recycle bin is expanded', async () => {
    const now = Date.now();
    applyState(storePath('sessions', [session('active', now - 1_000)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('recycleBinEntries', [deletedSessionEntry(now)]));
    openSessionPicker();

    renderChat();

    const button = sectionToggle('Recycle Bin');
    expect(button).toBeInstanceOf(HTMLButtonElement);

    click(button);
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(trimmedTexts('.session-list-section-title')).toEqual(['Recent', 'Recycle Bin']);
    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).some(
        (item) => item.textContent?.trim() === 'Deleted session'
      )
    ).toBe(true);
  });

  it('expands recycle bin entries that are missing snapshots', async () => {
    const now = Date.now();
    applyState(storePath('sessions', [session('active', now - 1_000)]));
    applyState(storePath('activeSessionId', 'active'));
    // SAFETY: The fixture provides the never fields read by this statement.
    applyState(
      storePath('recycleBinEntries', [
        {
          rootID: 'deleted-session',
          deletedAt: now - 10_000,
          expiresAt: now + 10_000,
        } as never,
      ])
    );
    openSessionPicker();

    renderChat();

    const toggle = sectionToggle('Recycle Bin');

    click(toggle);
    await Promise.resolve();
    flushSolid();

    expect(container?.textContent).not.toContain('Something went wrong');
    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).some(
        (item) => item.textContent?.trim() === 'deleted-session'
      )
    ).toBe(true);
  });

  it('invokes recycle bin row actions', async () => {
    const restoreSpy = vi.spyOn(openCodeModule, 'restoreSession').mockResolvedValue(undefined);
    const deleteSpy = vi
      .spyOn(openCodeModule, 'deleteSessionPermanently')
      .mockResolvedValue(undefined);

    const now = Date.now();
    applyState(storePath('sessions', [session('active', now - 1_000)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('recycleBinEntries', [deletedSessionEntry(now)]));
    openSessionPicker();

    renderChat();

    const toggle = sectionToggle('Recycle Bin');

    click(toggle);
    await Promise.resolve();
    flushSolid();

    const restoreButton = queryButton('button.recycle-bin-restore');
    const deleteButton = queryButton('button.recycle-bin-delete');

    click(restoreButton);
    click(deleteButton);
    await Promise.resolve();
    flushSolid();

    expect(restoreSpy).toHaveBeenCalledWith('deleted-session');
    expect(deleteSpy).not.toHaveBeenCalled();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const confirmButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (item) => item.textContent === 'Confirm'
    ) as HTMLButtonElement | undefined;
    click(confirmButton);
    await Promise.resolve();
    flushSolid();

    expect(deleteSpy).toHaveBeenCalledWith('deleted-session');
  });

  it('does not render the embedded session sidebar when the session picker is open', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    openSessionPicker();

    renderChat();

    expect(container?.querySelector('.chat-session-sidebar')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('shows the desktop workspace with a blank chat when the session picker expands to large screens', async () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', null));
    openSessionPicker();

    renderChat();

    expect(container?.querySelector('.chat-session-sidebar')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);

    dispatchDesktopMediaQueryChange(true);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-workspace')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-session-sidebar')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.session-list-view-sidebar')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-empty-state')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.chat-header-chat-desktop .chat-header-title-text')?.textContent
    ).toBe('New Chat');
  });

  it('shows loading dots before rendering Models on desktop from the session picker', async () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    openSessionPicker();
    setShowModels(true);
    flushSolid();

    renderChat();

    const loading = container?.querySelector('[role="status"][aria-label="Loading models"]');
    expect(loading?.parentElement?.classList.contains('models-panel')).toBe(true);
    expect(loading?.querySelectorAll('.chat-messages-loading-dot')).toHaveLength(3);
    expect(container?.querySelector('.models-header')).toBeNull();

    dispatchDesktopMediaQueryChange(true);
    flushSolid();
    await vi.waitFor(() =>
      expect(container?.querySelector('.models-header')).toBeInstanceOf(HTMLDivElement)
    );
    flushSolid();
    expect(container?.querySelector('[aria-label="Loading models"]')).toBeNull();

    setShowModels(false);
    flushSolid();
    expect(container?.querySelector('.models-panel')).toBeNull();
    setShowModels(true);
    flushSolid();
    await vi.waitFor(() =>
      expect(container?.querySelector('.models-header')).toBeInstanceOf(HTMLDivElement)
    );
    flushSolid();
    expect(container?.querySelector('[aria-label="Loading models"]')).toBeNull();
  });

  it('reports the selected provider as visible only while the chat workspace is shown', () => {
    captureBridgeMessages((sent) => {
      const model = { providerID: 'openai', modelID: 'test-model' };
      applyState(storePath('selectedModel', model));
      renderChat();
      expect(sent.findLast((message) => message.type === 'commands/state')).toMatchObject({
        payload: { model, modelVisible: true },
      });
      setShowModels(true);
      flushSolid();
      expect(sent.findLast((message) => message.type === 'commands/state')).toMatchObject({
        payload: { model, modelVisible: false },
      });
      setShowModels(false);
      flushSolid();
      expect(sent.findLast((message) => message.type === 'commands/state')).toMatchObject({
        payload: { model, modelVisible: true },
      });
    });
  });

  it.each(['session', 'directory', 'server'] as const)(
    'closes a side-question dialog when its %s changes',
    async (change) => {
      applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
      applyState(storePath('activeSessionId', 'session-1'));
      applyState(
        storePath('serverStatus', { state: 'running', url: 'http://localhost:4096', apiVersion: 2 })
      );
      renderChat();
      expect(openSideQuestion()).toBe(true);
      flushSolid();
      await vi.waitFor(() =>
        expect(document.querySelector('.side-question-dialog')).not.toBeNull()
      );
      flushSolid();
      if (change === 'session') setState(storePath('activeSessionId', 'session-2'));
      else if (change === 'directory')
        setState(storePath('sessions', (entry) => entry.id === 'session-1', 'directory', '/moved'));
      else
        setState(
          storePath('serverStatus', {
            state: 'running',
            url: 'http://localhost:5000',
            apiVersion: 2,
          })
        );
      flushSolid();
      await vi.waitFor(() => expect(document.querySelector('.side-question-dialog')).toBeNull());
      flushSolid();
      expect(sideQuestionView()).toBeNull();
    }
  );

  it('opens locked provider re-authentication over chat without showing Models', async () => {
    vi.spyOn(client.config, 'providerCatalog').mockResolvedValue({
      all: [
        { id: 'github-copilot', name: 'GitHub Copilot', source: 'api', models: {} },
        { id: 'openai', name: 'OpenAI', source: 'api', models: {} },
      ],
      default: {},
      connected: ['github-copilot'],
    });
    applyState(
      storePath('providerAuthMethods', {
        'github-copilot': [{ type: 'oauth', label: 'Login with GitHub Copilot' }],
      })
    );
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    renderChat();

    requestProviderConnection('github-copilot');
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    await vi.waitFor(() =>
      expect(document.body.querySelector<HTMLElement>('[role="dialog"]')).toBeInstanceOf(
        HTMLElement
      )
    );
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(container?.querySelector('.models-panel')).toBeNull();
    expect(dialog?.textContent).toContain('Re-authenticate provider');
    expect(dialog?.textContent).toContain('GitHub Copilot');
    expect(dialog?.textContent).toContain('Login with GitHub Copilot');
    expect(dialog?.textContent).not.toContain('Back to providers');
    expect(dialog?.querySelector('[aria-label="Search providers"]')).toBeNull();
  });

  it('opens the Codex browser handoff from a usage notice without starting authentication', async () => {
    vi.spyOn(client.config, 'providerCatalog').mockResolvedValue({
      all: [{ id: 'openai', name: 'OpenAI', source: 'api', models: {} }],
      default: {},
      connected: ['openai'],
    });
    const authorize = vi.spyOn(client.config, 'authorizeProvider');
    applyState(
      storePath('providerAuthMethods', {
        openai: [
          { id: 'chatgpt-token-sharing', type: 'oauth', label: 'Sign in with ChatGPT' },
          { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' },
        ],
      })
    );
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    renderChat();
    requestProviderConnection('openai', 'chatgpt-browser');
    await vi.waitFor(() => expect(document.querySelector('.provider-connect-form')).not.toBeNull());
    flushSolid();
    expect(document.querySelector('.provider-connect-oauth-handoff')).not.toBeNull();
    expect(document.querySelector('.provider-connect-methods')).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('opens the provider picker for a generic connection request', async () => {
    vi.spyOn(client.config, 'providerCatalog').mockResolvedValue({
      all: [
        { id: 'anthropic', name: 'Anthropic', source: 'api', models: {} },
        { id: 'openai', name: 'OpenAI', source: 'api', models: {} },
      ],
      default: {},
      connected: [],
    });
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    renderChat();

    requestProviderConnection();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    await vi.waitFor(() =>
      expect(document.body.querySelector<HTMLElement>('[role="dialog"]')).toBeInstanceOf(
        HTMLElement
      )
    );
    flushSolid();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Connect provider');
    expect(dialog?.textContent).toContain('Anthropic');
    expect(dialog?.textContent).toContain('OpenAI');
    expect(dialog?.querySelector('[aria-label="Search providers"]')).toBeInstanceOf(
      HTMLInputElement
    );
  });

  it('renders Models from the session picker on narrow screens', async () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    openSessionPicker();
    setShowModels(true);
    flushSolid();

    renderChat();

    expect(container?.querySelector('.chat-workspace')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
    await vi.waitFor(() =>
      expect(container?.querySelector('.models-header')).toBeInstanceOf(HTMLDivElement)
    );
    flushSolid();
  });

  it('renders the desktop session pane on the right when configured', async () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    setDesktopSessionPaneSide('right');
    flushSolid();
    dispatchDesktopMediaQueryChange(true);
    flushSolid();

    renderChat();
    await Promise.resolve();
    flushSolid();

    const workspace = container?.querySelector('.chat-workspace');
    const sidebar = container?.querySelector('.chat-session-sidebar');
    const mainShell = container?.querySelector('.chat-main-shell');

    expect(workspace).toBeInstanceOf(HTMLDivElement);
    expect(workspace?.classList.contains('chat-workspace-pane-right')).toBe(true);
    expect(sidebar).toBeInstanceOf(HTMLElement);
    expect(mainShell).toBeInstanceOf(HTMLDivElement);
    expect(workspace?.firstElementChild).toBe(mainShell);
    expect(workspace?.lastElementChild).toBe(sidebar);
  });

  it('keeps the edit composer visible when its message row disappears', async () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(
      storePath('messages', [
        {
          info: {
            id: 'user-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-4o' },
          },
          parts: [
            {
              id: 'text-1',
              messageID: 'user-1',
              sessionID: 'session-1',
              type: 'text',
              text: 'Original prompt',
            },
          ],
        },
      ])
    );
    renderChat();
    startEditingMessage('user-1', 'session-1', 'Revised prompt');
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const composer = container?.querySelector('.rich-composer');
    expect(composer).not.toBeNull();
    expect(composer?.closest('.interactive-list')).not.toBeNull();
    flushSolid();
    applyState(storePath('messages', []));
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.rich-composer')).toBe(composer);
    expect(composer?.closest('[hidden]')).toBeNull();
    flushSolid();
    expect(composer?.closest('.composer-bottom-slot')).not.toBeNull();
    flushSolid();
    expect(composer?.textContent).toContain('Revised prompt');
    const cancel = container?.querySelector<HTMLButtonElement>('[title="Cancel editing (Esc)"]');
    expect(cancel).not.toBeNull();
    cancel?.click();
    flushSolid();
    expect(composer?.closest('.composer-bottom-slot')).not.toBeNull();
    flushSolid();
  });

  it('preserves the live chat DOM and transient state when the desktop pane changes sides', async () => {
    applyState(storePath('sessions', [session('session-1', 500), session('session-2', 400)]));
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(
      storePath(
        'messages',
        Array.from({ length: 60 }, (_, index) => assistantMessageEntry(`assistant-${index + 1}`))
      )
    );
    setDesktopSessionPaneSide('right');
    flushSolid();
    dispatchDesktopMediaQueryChange(true);
    flushSolid();

    renderChat();
    await Promise.resolve();
    flushSolid();

    const messageList = container?.querySelector<HTMLDivElement>('.interactive-list[role="log"]');
    const composer = container?.querySelector<HTMLDivElement>('.rich-composer');
    if (!messageList || !composer) throw new Error('Expected the live message list and composer');
    messageList.scrollTop = 173;
    composer.focus();
    flushSolid();

    setDesktopSessionPaneSide('left');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.chat-workspace-pane-right')).toBeNull();
    expect(container?.querySelector('.interactive-list[role="log"]')).toBe(messageList);
    expect(container?.querySelector('.rich-composer')).toBe(composer);
    expect(messageList.scrollTop).toBe(173);
    expect(document.activeElement).toBe(composer);
  });
});

describe('getHeaderAttentionCount', () => {
  it('omits the active waiting session while the picker is closed', () => {
    const sessions = [
      session('active-attention', 500),
      session('other-attention', 400),
      session('other', 300),
    ];

    expect(
      getHeaderAttentionCount(
        sessions,
        (sessionId) => sessionId === 'active-attention' || sessionId === 'other-attention',
        'active-attention',
        false
      )
    ).toBe(1);
  });

  it('counts all waiting sessions while the picker is open', () => {
    const sessions = [session('active-attention', 500), session('other-attention', 400)];

    expect(getHeaderAttentionCount(sessions, () => true, 'active-attention', true)).toBe(2);
  });

  it('ignores sub-agent sessions in the header count', () => {
    const sessions = [
      session('primary-attention', 500),
      session('subagent-attention', 400, { parentID: 'parent-1' }),
    ];

    expect(getHeaderAttentionCount(sessions, () => true, null, true)).toBe(1);
  });
});

describe('getHeaderFailedCount', () => {
  it('omits the active failed session while the picker is closed', () => {
    const sessions = [
      session('active-failed', 500),
      session('other-failed', 400),
      session('other', 300),
    ];

    expect(
      getHeaderFailedCount(
        sessions,
        (sessionId) => sessionId === 'active-failed' || sessionId === 'other-failed',
        'active-failed',
        false
      )
    ).toBe(1);
  });

  it('ignores sub-agent sessions in the header count', () => {
    const sessions = [
      session('primary-failed', 500),
      session('subagent-failed', 400, { parentID: 'parent-1' }),
    ];

    expect(getHeaderFailedCount(sessions, () => true, null, true)).toBe(1);
  });

  it('counts usage-limit sessions as failed', () => {
    const sessions = [session('limited', 500), session('other', 400)];

    applyState(storePath('sessions', sessions));
    limitSessionUsage('limited');

    expect(
      getHeaderFailedCount(sessions, (sessionId) => isFailedSession(sessionId), null, true)
    ).toBe(1);
  });

  it('surfaces child-session permission prompts on the primary session', () => {
    const sessions = [
      session('session-1', 500),
      session('child-1', 400, { parentID: 'session-1' }),
    ];

    applyState(storePath('sessions', sessions));
    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'child-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'Allow bash',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.permissionIds.has('session-1')).toBe(true);
    expect(indicators.attentionIds.has('session-1')).toBe(true);
  });

  it('counts nested descendants per session subtree for subagent counts', () => {
    const sessions = [
      session('session-1', 500),
      session('child-1', 400, { parentID: 'session-1' }),
      session('grandchild-1', 300, { parentID: 'child-1' }),
    ];

    applyState(storePath('sessions', sessions));

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.subagentCounts.get('session-1')).toBe(2);
    expect(indicators.subagentCounts.get('child-1')).toBe(1);
    expect(indicators.subagentCounts.has('grandchild-1')).toBe(false);
  });
});

describe('getHeaderRunningCount', () => {
  it('omits the active running session while the picker is closed', () => {
    const sessions = [
      session('active-running', 500),
      session('other-running', 400),
      session('other', 300),
    ];

    expect(
      getHeaderRunningCount(
        sessions,
        (sessionId) => sessionId === 'active-running' || sessionId === 'other-running',
        'active-running',
        false
      )
    ).toBe(1);
  });

  it('ignores sub-agent sessions in the header count', () => {
    const sessions = [
      session('primary-running', 500),
      session('subagent-running', 400, { parentID: 'parent-1' }),
    ];

    expect(getHeaderRunningCount(sessions, () => true, null, true)).toBe(1);
  });
});

describe('usage-limit session status precedence', () => {
  it('treats a retrying 429 session as failed instead of running', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(
      storePath('sessionStatus', {
        'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
      })
    );
    limitSessionUsage('session-1');

    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(isFailedSession('session-1')).toBe(true);
    expect(isRunningSession('session-1')).toBe(false);
  });

  it('renders a failed indicator when a session is both retrying and failed', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(
      storePath('sessionStatus', {
        'session-1': { type: 'retry', attempt: 2, message: 'Retrying request', next: 8 },
      })
    );
    applyState(storePath('failedSessionIds', ['session-1']));

    renderChat();

    const indicator = container?.querySelector('.session-item .session-item-indicator');

    expect(indicator?.classList.contains('is-failed')).toBe(true);
    expect(indicator?.getAttribute('aria-label')).toBe('Failed');

    applyState(storePath('lastSeenSessions', 'session-1', 500));

    expect(container?.querySelector('.session-item .session-item-indicator.is-failed')).toBeNull();
    expect(state.failedSessionIds).toEqual(['session-1']);
  });

  it('renders a failure that arrives after the session was already seen', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('lastSeenSessions', 'session-1', 500));
    setSessionFailed('session-1', true);
    flushSolid();

    renderChat();

    expect(
      container?.querySelector('.session-item .session-item-indicator.is-failed')
    ).not.toBeNull();

    applyState(
      storePath('lastSeenSessions', 'session-1', state.failedSessionUpdatedAt['session-1']!)
    );

    expect(container?.querySelector('.session-item .session-item-indicator.is-failed')).toBeNull();
  });

  it('keeps a parent running when a previously failed sub-agent resumes work', () => {
    applyState(
      storePath('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })])
    );
    applyState(
      storePath('sessionStatus', {
        child: { type: 'busy' },
      })
    );
    applyState(storePath('failedSessionIds', ['child']));

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isFailedSession('child')).toBe(false);
    expect(indicators.failedIds.has('child')).toBe(false);
    expect(indicators.failedIds.has('parent')).toBe(false);
    expect(indicators.runningIds.has('child')).toBe(true);
    expect(indicators.runningIds.has('parent')).toBe(true);
  });

  it('does not render a failed indicator for aborted sessions', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(
      storePath('messages', [
        {
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 0 },
            parentID: 'user-1',
            modelID: 'model-1',
            providerID: 'provider-1',
            mode: 'default',
            path: { cwd: '/repo', root: '/repo' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: { name: 'aborted', data: { message: 'Aborted' } },
          },
          parts: [],
        },
      ])
    );

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('session-1')).toBe(false);
  });

  it('renders a plan-ready indicator for unread plan sessions', () => {
    applyState(storePath('sessions', [session('active', 600), session('plan-1', 500)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('lastSeenSessions', { active: 600, 'plan-1': 0 }));
    openSessionPicker();

    renderChat();

    const planRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
    );
    const indicator = planRow?.querySelector('.session-item-indicator');

    expect(indicator?.classList.contains('is-completed')).toBe(false);
    expect(indicator?.classList.contains('is-plan-completed')).toBe(true);
    expect(indicator?.getAttribute('aria-label')).toBe('Plan ready');
    expect(planRow?.querySelector('.session-item-plan-tag')?.textContent?.trim()).toBe('Plan');
    expect(container?.querySelector('.chat-header-plan-badge')).toBeInstanceOf(HTMLButtonElement);
  });

  it('restores the plan-ready indicator when a seen plan receives a newer update', () => {
    applyState(storePath('sessions', [session('active', 600), session('plan-1', 500)]));
    applyState(storePath('activeSessionId', 'active'));
    applyState(storePath('sessionSelectedAgents', { 'plan-1': 'plan' }));
    applyState(storePath('lastSeenSessions', { active: 600, 'plan-1': 500 }));
    openSessionPicker();

    renderChat();

    const getPlanRow = () =>
      Array.from(container?.querySelectorAll('.session-item') ?? []).find(
        (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
      );

    expect(getPlanRow()?.querySelector('.session-item-indicator')).toBeNull();

    applyState(storePath('sessions', [session('active', 600), session('plan-1', 501)]));

    const indicator = getPlanRow()?.querySelector('.session-item-indicator');
    expect(indicator?.classList.contains('is-plan-completed')).toBe(true);
    expect(indicator?.getAttribute('aria-label')).toBe('Plan ready');
    expect(getPlanRow()?.querySelector('.session-item-plan-tag')?.textContent?.trim()).toBe('Plan');
    expect(container?.querySelector('.chat-header-plan-badge')).toBeInstanceOf(HTMLButtonElement);
  });

  it('returns to running once the 429 notice is cleared', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(
      storePath('sessionStatus', {
        'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
      })
    );
    limitSessionUsage('session-1');

    setSessionUsageLimit('session-1', null);
    flushSolid();
    setSessionFailed('session-1', false);
    flushSolid();

    expect(hasActiveUsageLimit('session-1')).toBe(false);
    expect(isFailedSession('session-1')).toBe(false);
    expect(isRunningSession('session-1')).toBe(true);
  });

  it('shows completed indicators only after synced active sessions remain idle', async () => {
    try {
      applyState(storePath('sessions', [session('session-1', 500)]));
      applyState(storePath('activeSessionId', 'session-1'));
      applyState(
        storePath('sessionStatus', {
          'session-1': { type: 'busy' },
        })
      );
      openSessionPicker();

      setMessagesIncremental([assistantMessageEntry('assistant-1')]);
      flushSolid();

      renderChat();

      const row = container?.querySelector('.session-item');
      expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
      expect(isRunningSession('session-1')).toBe(true);
      expect(row?.querySelector('.session-item-indicator')?.classList.contains('is-running')).toBe(
        true
      );

      applyState(storePath('sessionStatus', 'session-1', { type: 'idle' }));

      expect(isRunningSession('session-1')).toBe(false);
      expect(row?.querySelector('.session-item-indicator')?.classList.contains('is-running')).toBe(
        true
      );

      await vi.advanceTimersByTimeAsync(1200);
      flushSolid();
      expect(
        row?.querySelector('.session-item-indicator')?.classList.contains('is-completed')
      ).toBe(true);
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
    }
  });

  it('does not render the active session status next to the chat header title', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(storePath('activeSessionId', 'session-1'));
    setMessagesIncremental([assistantMessageEntry('assistant-1')]);
    flushSolid();

    renderChat();

    expect(container?.querySelector('.chat-header-status-indicator')).toBeNull();
  });

  it('does not treat an incomplete Ralph manager session as running', () => {
    applyState(storePath('sessions', [session('session-1', 500)]));
    applyState(
      storePath('sessionStatus', {
        'session-1': { type: 'busy' },
      })
    );
    startRalphRun('session-1', 'TESTS.md');
    ralphStore.setStatus('session-1', 'incomplete', 'iteration_limit_with_gap');
    flushSolid();

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isRunningSession('session-1')).toBe(false);
    expect(indicators.runningIds.has('session-1')).toBe(false);
  });

  it('does not bubble stale child running status to a done Ralph manager session', () => {
    applyState(
      storePath('sessions', [
        session('session-1', 500),
        session('child-1', 400, { parentID: 'session-1' }),
      ])
    );
    applyState(
      storePath('sessionStatus', {
        'child-1': { type: 'busy' },
      })
    );
    startRalphRun('session-1', 'PLAN.md');
    ralphStore.setStatus('session-1', 'done', 'done_marker');
    flushSolid();

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isRunningSession('child-1')).toBe(false);
    expect(indicators.runningIds.has('session-1')).toBe(false);
    expect(indicators.runningIds.has('child-1')).toBe(false);
  });

  it('does not render stale Ralph child running status in the sub-agent list', async () => {
    applyState(
      storePath('sessions', [
        session('manager', 500),
        session('child-1', 400, { parentID: 'manager' }),
      ])
    );
    applyState(storePath('activeSessionId', 'manager'));
    applyState(storePath('lastSeenSessions', { manager: 500, 'child-1': 400 }));
    applyState(
      storePath('sessionStatus', {
        'child-1': { type: 'busy' },
      })
    );
    startRalphRun('manager', 'TESTS.md');
    ralphStore.setStatus('manager', 'done', 'done_marker');
    flushSolid();

    renderChat();

    const subagentsButton = queryButton('.chat-header-subagents');
    expect(subagentsButton).toBeInstanceOf(HTMLButtonElement);

    click(subagentsButton);
    await Promise.resolve();
    flushSolid();

    const childRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'child-1'
    );

    expect(childRow).toBeInstanceOf(HTMLDivElement);
    expect(childRow?.querySelector('.session-item-indicator')).toBeNull();
  });

  it('bubbles Ralph child usage-limit failures to the manager session indicator', () => {
    applyState(
      storePath('sessions', [
        session('manager', 500),
        session('child-1', 400, { parentID: 'manager' }),
      ])
    );
    startRalphRun('manager', 'TESTS.md');
    upsertRalphChildIteration('running', null);
    limitSessionUsage('child-1');

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('manager')).toBe(true);
    expect(indicators.runningIds.has('manager')).toBe(false);
  });

  it('does not bubble Ralph child failures to a manually stopped manager session', () => {
    applyState(
      storePath('sessions', [
        session('manager', 500),
        session('child-1', 400, { parentID: 'manager' }),
      ])
    );
    startRalphRun('manager', 'TESTS.md');
    upsertRalphChildIteration('failed', 200);
    limitSessionUsage('child-1');
    ralphStore.setStatus('manager', 'stopped', 'manual_stop');
    flushSolid();

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('child-1')).toBe(true);
    expect(indicators.failedIds.has('manager')).toBe(false);
    expect(indicators.runningIds.has('manager')).toBe(false);
  });
});

describe('getHeaderPlanReadyCount', () => {
  it('omits the active plan-ready session while the picker is closed', () => {
    const sessions = [
      session('active-plan-ready', 500),
      session('other-plan-ready', 400),
      session('other', 300),
    ];

    expect(
      getHeaderPlanReadyCount(
        sessions,
        (item) => item.id === 'active-plan-ready' || item.id === 'other-plan-ready',
        'active-plan-ready',
        false
      )
    ).toBe(1);
  });

  it('counts only primary plan-ready sessions', () => {
    const sessions = [
      session('plan-ready-1', 500),
      session('not-plan-ready', 400),
      session('plan-ready-subagent', 300, { parentID: 'parent-1' }),
      session('plan-ready-2', 200),
    ];

    expect(
      getHeaderPlanReadyCount(
        sessions,
        (item) =>
          item.id === 'plan-ready-1' ||
          item.id === 'plan-ready-2' ||
          item.id === 'plan-ready-subagent',
        null,
        true
      )
    ).toBe(2);
  });
});

describe('getHeaderCompletedCount', () => {
  it('omits the active completed session while the picker is closed', () => {
    const sessions = [
      session('active-completed', 500),
      session('other-completed', 400),
      session('other', 300),
    ];

    expect(
      getHeaderCompletedCount(
        sessions,
        (item) => item.id === 'active-completed' || item.id === 'other-completed',
        'active-completed',
        false
      )
    ).toBe(1);
  });

  it('counts only primary completed sessions', () => {
    const sessions = [
      session('completed-1', 500),
      session('other', 400),
      session('completed-subagent', 300, { parentID: 'parent-1' }),
      session('completed-2', 200),
    ];

    expect(
      getHeaderCompletedCount(
        sessions,
        (item) =>
          item.id === 'completed-1' ||
          item.id === 'completed-2' ||
          item.id === 'completed-subagent',
        null,
        true
      )
    ).toBe(2);
  });
});
