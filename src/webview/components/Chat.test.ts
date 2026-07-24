import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { AssistantMessage, Session, ToolPart } from '../types';
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
  getMessageToolSummaryStats,
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
import { EMPTY_SESSION_PRUNE_GRACE_MS } from '../lib/empty-session';
import {
  requestOpenAttentionSessions,
  requestSessionSearchFocus,
  setDesktopSessionPaneSide,
  hasActiveUsageLimit,
  state,
  setSessionFailed,
  setShowSettings,
  setShowSessionPicker,
  setSessionUsageLimit,
  setMessagesIncremental,
  setState,
  skipPlanSession,
} from '../lib/state';
import { ralphStore } from '../lib/stores/ralph-store';
import { clearDirectSessionReturn, rememberDirectSessionReturn } from '../lib/session-navigation';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalMatchMedia: typeof globalThis.matchMedia | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
let desktopMediaQueryMatches = false;
let desktopMediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

function dispatchDesktopMediaQueryChange(matches: boolean) {
  desktopMediaQueryMatches = matches;
  const event = { matches, media: '(min-width: 1400px)' } as MediaQueryListEvent;
  desktopMediaQueryListeners.forEach((listener) => listener(event));
}

function preventKeyboardDefault(event: KeyboardEvent) {
  event.preventDefault();
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  originalMatchMedia = globalThis.matchMedia;
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  desktopMediaQueryMatches = false;
  desktopMediaQueryListeners = new Set();
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
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
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('sessions', []);
  setState('sessionStatus', reconcile({}));
  setState('sessionUsageLimits', reconcile({}));
  setState('failedSessionIds', []);
  setState('recycleBinEntries', []);
  setState('questions', []);
  setState('permissions', []);
  setState('lastSeenSessions', reconcile({}));
  setState('completedSessionResponses', reconcile({}));
  setState('skippedPlanSessions', reconcile({}));
  setState('sessionSelectedAgents', reconcile({}));
  setState('selectedAgent', null);
  setState('activeSessionId', null);
  setState('messages', []);
  setState('queuedMessages', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
  setState('compactingSessionIds', []);
  setDesktopSessionPaneSide('left');
  setShowSessionPicker(false);
  setShowSettings(false);
  clearDirectSessionReturn();
  for (const run of ralphStore.getAllRuns()) {
    ralphStore.removeRun(run.config.managerSessionId);
  }
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.matchMedia = originalMatchMedia;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  vi.restoreAllMocks();
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

function assistantMessageEntry(id: string) {
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

function toolPart(tool: string, metadata: Record<string, unknown>): ToolPart {
  return {
    id: `${tool}-part`,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: `${tool}-call`,
    tool,
    state: {
      status: 'completed',
      input: {},
      output: '',
      title: '',
      metadata,
      time: { start: 0, end: 1 },
    },
  };
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

  it('derives fallback totals from file-changing tool messages', () => {
    expect(
      getMessageToolSummaryStats([
        {
          parts: [
            toolPart('write', { filepath: 'src/a.ts', additions: 4, deletions: 1 }),
            toolPart('apply_patch', {
              files: [
                { type: 'update', relativePath: 'src/a.ts', additions: 2, deletions: 0 },
                { type: 'add', relativePath: 'src/b.ts', additions: 3, deletions: 0 },
              ],
            }),
            {
              id: 'patch-part',
              sessionID: 'session-1',
              messageID: 'message-1',
              type: 'patch',
              hash: 'abc',
              files: ['src/c.ts'],
            },
          ],
        },
      ])
    ).toEqual({ files: 3, additions: 9, deletions: 1 });
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

  it('moves primary sessions older than one day into show more without affecting sub-agent ordering', () => {
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
    ]);
    expect(groups.overflowOther.map((item) => item.id)).toEqual(['other-old']);
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
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-newest']);
    expect(groups.overflowOther.map((item) => item.id)).toEqual(['other-older']);
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
      time: {
        created: now - EMPTY_SESSION_PRUNE_GRACE_MS - 100,
        updated: now - EMPTY_SESSION_PRUNE_GRACE_MS - 100,
      },
    });
    const indicators = {
      runningIds: new Set<string>(),
      attentionIds: new Set<string>(),
      failedIds: new Set<string>(),
      planReadyIds: new Set<string>(),
      newlyCompletedIds: new Set<string>(),
    };

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
    const indicators = {
      runningIds: new Set<string>(),
      attentionIds: new Set<string>(),
      failedIds: new Set<string>(),
      planReadyIds: new Set<string>(),
      newlyCompletedIds: new Set<string>(),
    };

    expect(shouldAutoDeleteEmptySession(fresh, null, indicators)).toBe(false);
  });

  it('hides a freshly created empty session from the list without deleting it', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const now = Date.now();

    setState('sessions', [
      session('new-session', now, {
        title: 'New chat',
        time: { created: now, updated: now },
      }),
    ]);
    setState('activeSessionId', 'new-session');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();

    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );
    expect(titles).not.toContain('New chat');
    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('hides inactive empty sessions from the list and deletes them', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    setState('sessions', [
      session('active', 200),
      session('empty', staleTime, {
        title: 'Empty session',
        time: { created: staleTime, updated: staleTime },
      }),
    ]);
    setState('activeSessionId', 'active');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(container?.textContent).not.toContain('Empty session');
    expect(deleteImmediatelySpy).toHaveBeenCalledWith('empty');
  });

  it('does not delete a newly created empty session that becomes active before the prune timer runs', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const now = Date.now();

    setState('sessions', [
      session('new-session', now, {
        title: 'New session',
        time: { created: now, updated: now },
      }),
    ]);
    setState('activeSessionId', null);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();

    setState('activeSessionId', 'new-session');
    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('hides an active empty session from the list without auto-deleting it', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    setState('sessions', [
      session('new-session', staleTime, {
        title: 'New session',
        time: { created: staleTime, updated: staleTime },
      }),
    ]);
    setState('activeSessionId', 'new-session');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(container?.textContent).not.toContain('New session');
    expect(container?.textContent).toContain('Sessions (0)');
    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
  });

  it('keeps a Ralph manager session visible and skips auto-delete when it is otherwise empty', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const staleTime = Date.now() - EMPTY_SESSION_PRUNE_GRACE_MS - 100;

    setState('sessions', [
      session('manager', staleTime, {
        title: 'Ralph manager',
        time: { created: staleTime, updated: staleTime },
      }),
      session('child-1', staleTime + 1_000, {
        title: 'Ralph iter 1',
        parentID: 'manager',
      }),
    ]);
    setShowSessionPicker(true);
    ralphStore.startRun({
      managerSessionId: 'manager',
      workspaceDirectory: '/workspace',
      planDocPath: 'TESTS.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.upsertIteration('manager', {
      index: 1,
      childSessionId: 'child-1',
      status: 'running',
      startedAt: 100,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();

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
    expect(getSessionListFilterLabel('attention')).toBe('Needs attention');
    expect(getSessionListFilterLabel('failed')).toBe('Failed');
    expect(getSessionListFilterLabel('plan-ready')).toBe('Plan ready');
    expect(getSessionListFilterLabel('completed')).toBe('Completed');
    expect(getSessionListFilterLabel(null)).toBeNull();
  });
});

describe('getPrimarySessionsForFilter', () => {
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

    const archiveButton = container?.querySelector(
      'button.session-list-section-archive'
    ) as HTMLButtonElement | null;
    expect(archiveButton).toBeInstanceOf(HTMLButtonElement);

    archiveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const confirmButton = container?.querySelector(
      'button.session-list-section-confirm'
    ) as HTMLButtonElement | null;
    const cancelButton = container?.querySelector(
      'button.session-list-section-cancel'
    ) as HTMLButtonElement | null;

    expect(confirmButton?.textContent).toBe('Confirm');
    expect(cancelButton?.textContent).toBe('Cancel');
    expect(onArchive).not.toHaveBeenCalled();

    confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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

    container?.querySelector<HTMLButtonElement>('button.session-list-section-archive')?.click();
    setCount(3);

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

    const actionButton = container?.querySelector(
      'button.session-list-section-archive'
    ) as HTMLButtonElement | null;
    expect(actionButton?.getAttribute('aria-label')).toBe('Empty Recycle Bin');
  });
});

describe('header status badges', () => {
  it('opens the session list and focuses search when requested by the host', async () => {
    cleanup = render(() => Chat(), container!);

    requestSessionSearchFocus();
    await Promise.resolve();
    vi.advanceTimersByTime(20);

    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search sessions"]');
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(search);
  });

  it('does not show the reconnect banner for brief event stream degradation', () => {
    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'healthy',
    });

    cleanup = render(() => Chat(), container!);

    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'degraded',
    });
    vi.advanceTimersByTime(9999);
    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'healthy',
    });

    expect(container?.querySelector('.chat-transport-banner')).toBeNull();
  });

  it('keeps the reconnect banner visible briefly after recovery once shown', () => {
    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'healthy',
    });

    cleanup = render(() => Chat(), container!);

    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'degraded',
    });
    vi.advanceTimersByTime(10_000);

    expect(container?.querySelector('.chat-transport-banner')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-transport-title')?.textContent).toBe(
      'Live updates are reconnecting'
    );

    setState('serverStatus', {
      state: 'running',
      url: 'http://127.0.0.1:4096',
      eventStream: 'healthy',
    });
    vi.advanceTimersByTime(1999);

    expect(container?.querySelector('.chat-transport-banner')).toBeInstanceOf(HTMLDivElement);

    vi.advanceTimersByTime(1);

    expect(container?.querySelector('.chat-transport-banner')).toBeNull();
  });

  it('shows a count only for running sessions', () => {
    setState('sessions', [
      session('running-1', 500),
      session('running-2', 400),
      session('failed-1', 300),
      session('attention-1', 200),
      session('plan-1', 100),
      session('completed-1', 50),
    ]);
    setState('activeSessionId', 'active');
    setState('sessionStatus', {
      'running-1': { type: 'busy' },
      'running-2': { type: 'busy' },
    });
    setState('failedSessionIds', ['failed-1']);
    setState('questions', [{ id: 'question-1', sessionID: 'attention-1', questions: [] }]);
    setState('lastSeenSessions', { 'plan-1': 0 });
    setState('completedSessionResponses', { 'completed-1': 50 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-header-running-count')?.textContent).toBe('2');
    expect(container?.querySelector('.chat-header-failed-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-attention-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-plan-badge')?.textContent).toBe('');
    expect(container?.querySelector('.chat-header-completed-badge')?.textContent).toBe('');
  });

  it('renders an embedded session sidebar alongside the active chat view', () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-workspace')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-session-sidebar')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.session-list-view-sidebar')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-main-shell')).toBeInstanceOf(HTMLDivElement);
  });

  it('switches sessions when requested by the extension host', () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);
    setState('sessions', [session('newest', 300), session('middle', 200), session('oldest', 100)]);
    setState('activeSessionId', 'middle');

    cleanup = render(() => Chat(), container!);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'command/switch-session', payload: { direction: 'next' } },
      })
    );

    expect(selectSessionSpy).toHaveBeenCalledWith('oldest');
  });

  it('returns to the sessions list with Escape', async () => {
    setState('sessions', [session('active', 500), session('other', 400)]);
    setState('activeSessionId', 'active');

    cleanup = render(() => Chat(), container!);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();

    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeInstanceOf(HTMLDivElement);
  });

  it('leaves Escape to nested chat controls that consume it', async () => {
    setState('sessions', [session('active', 500), session('other', 400)]);
    setState('activeSessionId', 'active');

    cleanup = render(() => Chat(), container!);
    window.addEventListener('keydown', preventKeyboardDefault);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await Promise.resolve();
    window.removeEventListener('keydown', preventKeyboardDefault);

    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('shows status badges in the desktop chat header', () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', {
      'session-2': { type: 'busy' },
    });

    cleanup = render(() => Chat(), container!);

    const desktopHeader = container?.querySelector('.chat-header-chat-desktop');
    const desktopActions = desktopHeader?.querySelector('.chat-header-actions');

    expect(desktopHeader).toBeInstanceOf(HTMLDivElement);
    expect(desktopHeader?.querySelector('.chat-header-title-text')?.textContent).toBe('session-1');
    expect(desktopActions).toBeInstanceOf(HTMLDivElement);
    expect(desktopHeader?.querySelector('.chat-header-running-badge')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(desktopHeader?.querySelector('.chat-header-running-count')?.textContent).toBe('1');
    expect(desktopHeader?.querySelector('.chat-header-failed-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-attention-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-plan-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-completed-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-btn[title="New chat"]')).toBeInstanceOf(
      HTMLButtonElement
    );
    expect(desktopHeader?.querySelector('.chat-header-btn[title="Fork session"]')).toBeNull();
  });

  it('shows the active session subagent button beside the title and opens its sub-agent list', async () => {
    setState('sessions', [
      session('parent', 500),
      session('child-1', 400, { parentID: 'parent' }),
      session('child-2', 300, { parentID: 'parent' }),
      session('other', 200),
    ]);
    setState('activeSessionId', 'parent');

    cleanup = render(() => Chat(), container!);

    const headerLeft = container?.querySelector('.chat-header-left');
    const title = headerLeft?.querySelector('.chat-header-title-text');
    const subagentsButton = headerLeft?.querySelector(
      '.chat-header-subagents'
    ) as HTMLButtonElement | null;
    const headerChildren = Array.from(headerLeft?.children ?? []);

    expect(title?.textContent).toBe('parent');
    expect(subagentsButton?.getAttribute('title')).toBe('Show 2 sub-agent sessions');
    expect(subagentsButton?.textContent?.trim()).toBe('2');
    expect(headerChildren.indexOf(title as Element)).toBeLessThan(
      headerChildren.indexOf(subagentsButton as Element)
    );

    subagentsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );
    expect(titles).toEqual(['child-1', 'child-2']);
  });

  it('hides the parent subagent button when the active session is a sub-agent', () => {
    setState('sessions', [
      session('parent', 500),
      session('child-1', 400, { parentID: 'parent' }),
      session('child-2', 300, { parentID: 'parent' }),
    ]);
    setState('activeSessionId', 'child-1');

    cleanup = render(() => Chat(), container!);

    const subagentsButton = container?.querySelector(
      '.chat-header-subagents'
    ) as HTMLButtonElement | null;
    expect(subagentsButton).toBeNull();
  });

  it('returns from an active sub-agent session to its top session sub-agent list', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })]);
    setState('activeSessionId', 'child');

    cleanup = render(() => Chat(), container!);

    const backButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to sub-agent sessions"]'
    ) as HTMLButtonElement | null;
    expect(backButton).toBeInstanceOf(HTMLButtonElement);
    expect(
      container?.querySelectorAll('.chat-header-btn[title="Back to sub-agent sessions"]')
    ).toHaveLength(1);

    backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

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
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })]);
    setState('activeSessionId', 'child');
    rememberDirectSessionReturn('child', 'parent');

    cleanup = render(() => Chat(), container!);

    const backButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to parent session"]'
    ) as HTMLButtonElement | null;
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('shows desktop sub-agent navigation in both the chat header and session sidebar', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);
    desktopMediaQueryMatches = true;
    setState('sessions', [
      session('parent', 500),
      session('child', 400, { parentID: 'parent' }),
      session('sibling', 300, { parentID: 'parent' }),
      session('other', 200),
    ]);
    setState('activeSessionId', 'child');

    cleanup = render(() => Chat(), container!);

    const desktopBackButton = container?.querySelector(
      '.chat-header-chat-desktop .chat-header-btn[title="Back to parent session"]'
    ) as HTMLButtonElement | null;
    const sidebar = container?.querySelector('.session-list-view-sidebar');
    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');
    expect(desktopBackButton).toBeInstanceOf(HTMLButtonElement);
    expect(
      container?.querySelectorAll('.chat-header-btn[title="Back to parent session"]')
    ).toHaveLength(1);
    expect(sidebarHeader?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for parent'
    );
    expect(
      sidebarHeader?.querySelector('.chat-header-btn[title="Back to sessions"]')
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      Array.from(sidebar?.querySelectorAll('.session-item-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['child', 'sibling']);

    sidebarHeader
      ?.querySelector<HTMLButtonElement>('.chat-header-btn[title="Back to sessions"]')
      ?.click();
    await Promise.resolve();

    expect(
      Array.from(sidebar?.querySelectorAll('.session-item-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['parent', 'other']);
    expect(selectSessionSpy).not.toHaveBeenCalled();

    desktopBackButton?.click();
    await Promise.resolve();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
  });

  it('returns from a nested sub-agent session to the top session sub-agent list', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [
      session('top', 500),
      session('child', 400, { parentID: 'top' }),
      session('grandchild', 300, { parentID: 'child' }),
    ]);
    setState('activeSessionId', 'grandchild');

    cleanup = render(() => Chat(), container!);

    const topButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to sub-agent sessions"]'
    ) as HTMLButtonElement | null;
    expect(topButton).toBeInstanceOf(HTMLButtonElement);

    topButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(selectSessionSpy).not.toHaveBeenCalled();
    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Sub-agents for top'
    );
    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );
    expect(titles).toEqual(['child', 'grandchild']);
  });

  it('returns from the sub-agent list to the parent session', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })]);
    setState('activeSessionId', 'parent');

    cleanup = render(() => Chat(), container!);

    const subagentsButton = container?.querySelector(
      '.chat-header-subagents'
    ) as HTMLButtonElement | null;
    subagentsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const backButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to parent session"]'
    ) as HTMLButtonElement | null;
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(selectSessionSpy).toHaveBeenCalledWith('parent');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('shows session status badges in the desktop session sidebar header', () => {
    setState('sessions', [
      session('running-1', 500),
      session('failed-1', 400),
      session('attention-1', 300),
      session('plan-1', 200),
      session('completed-1', 150),
      session('session-1', 100),
    ]);
    setState('activeSessionId', 'running-1');
    setState('sessionStatus', {
      'running-1': { type: 'busy' },
    });
    setState('failedSessionIds', ['failed-1']);
    setState('questions', [{ id: 'question-1', sessionID: 'attention-1', questions: [] }]);
    setState('lastSeenSessions', { 'plan-1': 0 });
    setState('completedSessionResponses', { 'completed-1': 150 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

    cleanup = render(() => Chat(), container!);

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
    expect(sidebarHeader?.querySelector('.chat-header-btn[title="New chat"]')).toBeInstanceOf(
      HTMLButtonElement
    );
  });

  it('auto-opens the only filtered sibling session from the chat header', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [session('active', 500), session('failed-target', 400)]);
    setState('activeSessionId', 'active');
    setState('failedSessionIds', ['failed-target']);

    cleanup = render(() => Chat(), container!);

    const failedBadge = container?.querySelector(
      '.chat-header-failed-badge'
    ) as HTMLButtonElement | null;
    expect(failedBadge).toBeInstanceOf(HTMLButtonElement);

    failedBadge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(selectSessionSpy).toHaveBeenCalledWith('failed-target');
    expect(container?.querySelector('.chat-header-filter-chip')).toBeNull();
  });

  it('switches to a draft chat view without creating a session', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');

    setState('sessions', [session('active', 500)]);
    setState('activeSessionId', 'active');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const newChatButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="New chat"]'
    ) as HTMLButtonElement | null;
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    newChatButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

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

  it('reuses an untouched active session instead of creating another from chat view', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const now = Date.now();
    setState('sessions', [
      session('draft-session', now, {
        title: 'New session',
        time: { created: now, updated: now },
      }),
    ]);
    setState('activeSessionId', 'draft-session');

    cleanup = render(() => Chat(), container!);

    const newChatButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="New chat"]'
    ) as HTMLButtonElement | null;
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    newChatButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('draft-session');
  });

  it('reuses an untouched active session instead of creating another from the session picker', async () => {
    const createSessionSpy = vi
      .spyOn(openCodeModule, 'createSession')
      .mockResolvedValue('new-session');
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const now = Date.now();
    setState('sessions', [
      session('draft-session', now, {
        title: 'New session',
        time: { created: now, updated: now },
      }),
    ]);
    setState('activeSessionId', 'draft-session');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const newChatButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="New chat"]'
    ) as HTMLButtonElement | null;
    expect(newChatButton).toBeInstanceOf(HTMLButtonElement);

    newChatButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteImmediatelySpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(state.activeSessionId).toBe('draft-session');
    expect(
      container?.querySelector('.session-list-view:not(.session-list-view-sidebar)')
    ).toBeNull();
  });

  it('deletes an untouched active session when returning to the sessions list', async () => {
    const deleteImmediatelySpy = vi
      .spyOn(openCodeModule, 'deleteSessionImmediately')
      .mockResolvedValue(undefined);

    const now = Date.now();
    setState('sessions', [
      session('draft-session', now, {
        title: 'New session',
        time: { created: now, updated: now },
      }),
    ]);
    setState('activeSessionId', 'draft-session');

    cleanup = render(() => Chat(), container!);

    const backButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to sessions"]'
    ) as HTMLButtonElement | null;
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(deleteImmediatelySpy).toHaveBeenCalledWith('draft-session');
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('adds a brief chat view transition class after the new chat opens', async () => {
    setState('sessions', [session('active', 500)]);
    setState('activeSessionId', 'active');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const newChatButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="New chat"]'
    ) as HTMLButtonElement | null;
    newChatButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(
      container?.querySelector('.interactive-session')?.classList.contains('chat-view-entering')
    ).toBe(true);

    vi.advanceTimersByTime(180);
    await Promise.resolve();

    expect(
      container?.querySelector('.interactive-session')?.classList.contains('chat-view-entering')
    ).toBe(false);
  });

  it('filters completed sessions from the header badge', async () => {
    setState('sessions', [
      session('active', 500),
      session('completed-1', 400),
      session('completed-2', 300),
      session('other', 200),
    ]);
    setState('activeSessionId', 'active');
    setState('lastSeenSessions', { active: 500, other: 200 });
    setState('completedSessionResponses', { 'completed-1': 400, 'completed-2': 300 });

    cleanup = render(() => Chat(), container!);

    const completedBadge = container?.querySelector(
      '.chat-header-completed-badge'
    ) as HTMLButtonElement | null;
    expect(completedBadge).toBeInstanceOf(HTMLButtonElement);

    completedBadge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.chat-header-filter-chip-label')?.textContent).toBe(
      'Completed'
    );
    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );
    expect(titles).toEqual(['completed-1', 'completed-2']);
  });

  it('keeps the active completed session out of the chat header but shows it in the sessions list', () => {
    setState('sessions', [session('active-completed', 500), session('other', 400)]);
    setState('activeSessionId', 'active-completed');
    setState('lastSeenSessions', { other: 400 });
    setState('completedSessionResponses', { 'active-completed': 500 });

    cleanup = render(() => Chat(), container!);

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

  it('keeps the active completed session indicator when its messages are loaded', () => {
    setState('sessions', [session('session-1', 500), session('other', 400)]);
    setState('activeSessionId', 'session-1');
    setState('lastSeenSessions', { other: 400 });
    setState('completedSessionResponses', { 'session-1': 500 });
    setState('messages', [assistantMessageEntry('assistant-1')]);

    cleanup = render(() => Chat(), container!);

    const activeIndicator = Array.from(container?.querySelectorAll('.session-item') ?? [])
      .find(
        (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'session-1'
      )
      ?.querySelector('.session-item-indicator');
    expect(activeIndicator?.classList.contains('is-completed')).toBe(true);
  });

  it('does not treat generic unread session updates as completed responses', () => {
    setState('sessions', [session('active', 500), session('metadata-update', 400)]);
    setState('activeSessionId', 'active');
    setState('lastSeenSessions', { active: 500, 'metadata-update': 0 });

    cleanup = render(() => Chat(), container!);

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
    setState('sessions', [session('session-1', 500)]);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    setState('permissions', [
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
    ]);

    cleanup = render(() => Chat(), container!);

    const indicator = container?.querySelector('.session-item-indicator');
    expect(indicator?.classList.contains('is-attention')).toBe(true);
    expect(indicator?.getAttribute('title')).toBe('Permission request pending');
  });

  it('leaves running spinner timing to CSS', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', { 'session-1': { type: 'busy' } });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const headerSpinner = container?.querySelector(
      '.chat-header-running-spinner'
    ) as HTMLElement | null;
    const indicator = container?.querySelector(
      '.session-item .session-item-indicator'
    ) as HTMLElement | null;

    expect(headerSpinner?.style.animationDelay).toBe('');
    expect(indicator?.classList.contains('is-running')).toBe(true);
    expect(indicator?.style.animationDelay).toBe('');
  });

  it('keeps the active session in the sessions picker after returning from chat', async () => {
    const now = Date.now();
    setState('sessions', [
      session('active-completed', now - 1_000),
      session('plan-ready', now - 2_000),
      session('other', now - 3_000),
    ]);
    setState('activeSessionId', 'active-completed');
    setState('lastSeenSessions', {
      'active-completed': now - 1_000,
      'plan-ready': 0,
      other: now - 3_000,
    });
    setState('sessionSelectedAgents', { 'plan-ready': 'plan' });

    cleanup = render(() => Chat(), container!);

    const backButton = container?.querySelector(
      '.chat-header .chat-header-btn[title="Back to sessions"]'
    ) as HTMLButtonElement | null;
    expect(backButton).toBeInstanceOf(HTMLButtonElement);

    backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );

    expect(titles).toEqual(['active-completed', 'plan-ready', 'other']);
  });

  it('keeps opening the filtered session list when multiple sibling sessions match', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [
      session('active', 500),
      session('failed-1', 400),
      session('failed-2', 300),
    ]);
    setState('activeSessionId', 'active');
    setState('failedSessionIds', ['failed-1', 'failed-2']);

    cleanup = render(() => Chat(), container!);

    const failedBadge = container?.querySelector(
      '.chat-header-failed-badge'
    ) as HTMLButtonElement | null;
    expect(failedBadge).toBeInstanceOf(HTMLButtonElement);

    failedBadge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(selectSessionSpy).not.toHaveBeenCalled();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('opens attention sessions from state and auto-selects a single match', async () => {
    const selectSessionSpy = vi
      .spyOn(openCodeModule, 'selectSession')
      .mockResolvedValue(undefined as never);

    setState('sessions', [session('active', 500), session('attention-target', 400)]);
    setState('activeSessionId', 'active');
    setState('questions', [{ id: 'question-1', sessionID: 'attention-target', questions: [] }]);

    cleanup = render(() => Chat(), container!);

    requestOpenAttentionSessions();
    await Promise.resolve();

    expect(selectSessionSpy).toHaveBeenCalledWith('attention-target');
    expect(container?.querySelector('.chat-header-filter-chip')).toBeNull();
  });

  it('hides skipped plans from the plan-ready badge', () => {
    setState('sessions', [session('plan-1', 200), session('session-1', 100)]);
    setState('activeSessionId', 'session-1');
    setState('lastSeenSessions', { 'plan-1': 0 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });
    skipPlanSession('plan-1', 200);

    cleanup = render(() => Chat(), container!);

    const sidebarHeader = container?.querySelector('.chat-session-sidebar-header');
    expect(sidebarHeader?.querySelector('.chat-header-plan-badge')).toBeNull();
  });

  it('keeps seen plan sessions in the plan-ready badge until skipped or implemented', () => {
    setState('sessions', [session('plan-1', 200), session('session-1', 100)]);
    setState('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

    const indicators = deriveSessionIndicators(state.sessions);
    expect(indicators.planReadyIds.has('plan-1')).toBe(true);
    expect(indicators.newlyCompletedIds.has('plan-1')).toBe(false);
  });

  it('does not mark an empty session with the plan agent as plan ready', () => {
    setState('sessions', [
      session('plan-blank', 200, { time: { created: 200, updated: 200 } }),
      session('plan-done', 100),
    ]);
    setState('sessionSelectedAgents', { 'plan-blank': 'plan', 'plan-done': 'plan' });

    const indicators = deriveSessionIndicators(state.sessions);
    expect(indicators.planReadyIds.has('plan-blank')).toBe(false);
    expect(indicators.planReadyIds.has('plan-done')).toBe(true);
  });

  it('keeps seen plan sessions in the plan-ready session group', () => {
    setState('sessions', [session('plan-1', 200), session('session-1', 100)]);
    setState('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

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
    setState('sessions', [session('plan-1', 200), session('session-1', 100)]);
    setState('activeSessionId', 'session-1');
    setState('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.session-item-plan-skip')).toBeNull();
    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).some(
        (item) => item.textContent?.trim() === 'plan-1'
      )
    ).toBe(true);
  });

  it('shows a plan tag before trailing session metadata for running plan sessions', () => {
    setState('sessions', [
      session('plan-1', 300),
      session('plan-child', 250, { parentID: 'plan-1' }),
      session('session-1', 200),
    ]);
    setState('activeSessionId', 'session-1');
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });
    setState('sessionStatus', { 'plan-1': { type: 'busy' } });

    cleanup = render(() => Chat(), container!);

    const planRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
    );
    const trailing = planRow?.querySelector('.session-item-trailing') as HTMLDivElement | null;
    const planTag = trailing?.querySelector('.session-item-plan-tag');
    const subagentsButton = trailing?.querySelector('.session-item-subagents');
    const age = trailing?.querySelector('.session-item-age');
    const trailingChildren = Array.from(trailing?.children ?? []);
    const planTagIndex = trailingChildren.indexOf(planTag as Element);
    const subagentsIndex = trailingChildren.indexOf(subagentsButton as Element);
    const ageIndex = trailingChildren.indexOf(age as Element);

    expect(planTag?.textContent?.trim()).toBe('Plan');
    expect(planTagIndex).toBeGreaterThanOrEqual(0);
    if (subagentsIndex >= 0) expect(planTagIndex).toBeLessThan(subagentsIndex);
    expect(planTagIndex).toBeLessThan(ageIndex);
  });

  it('continues to show a plan tag for plan-ready sessions', () => {
    setState('sessions', [session('plan-1', 200), session('session-1', 100)]);
    setState('activeSessionId', 'session-1');
    setState('lastSeenSessions', { 'plan-1': 200, 'session-1': 100 });
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });

    cleanup = render(() => Chat(), container!);

    const planRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'plan-1'
    );

    expect(planRow?.querySelector('.session-item-plan-tag')?.textContent?.trim()).toBe('Plan');
  });

  it('orders the default session list by age only', () => {
    setState('sessions', [
      session('running-newest', 500),
      session('failed-middle', 400),
      session('attention-oldest', 300),
    ]);
    setState('activeSessionId', 'running-newest');
    setState('sessionStatus', {
      'running-newest': { type: 'busy' },
    });
    setState('failedSessionIds', ['failed-middle']);
    setState('questions', [{ id: 'question-1', sessionID: 'attention-oldest', questions: [] }]);

    cleanup = render(() => Chat(), container!);

    const sidebar = container?.querySelector('.session-list-view-sidebar');
    const titles = Array.from(sidebar?.querySelectorAll('.session-item-title') ?? []).map((item) =>
      item.textContent?.trim()
    );

    expect(titles).toEqual(['running-newest', 'failed-middle', 'attention-oldest']);
  });

  it('filters the default sessions list from the search input', async () => {
    setState('sessions', [
      session('session-1', 500, { title: 'Alpha build' }),
      session('session-2', 400, { title: 'Beta follow-up' }),
      session('session-3', 300, { title: 'Gamma review', directory: '/workspace/reports' }),
    ]);
    setState('activeSessionId', 'session-1');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    expect(input).toBeInstanceOf(HTMLInputElement);

    input!.value = 'reports';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const titles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );

    expect(titles).toEqual(['Gamma review']);
  });

  it('resets keyboard-focused session when the search input regains focus', async () => {
    setState('sessions', [
      session('session-1', 500, { title: 'Alpha build' }),
      session('session-2', 400, { title: 'Beta follow-up' }),
      session('session-3', 300, { title: 'Gamma review' }),
    ]);
    setState('activeSessionId', 'session-1');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    const items = Array.from(container?.querySelectorAll('.session-item') ?? []);
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(items).toHaveLength(3);

    items[2]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(items[2]?.classList.contains('keyboard-focus')).toBe(true);

    input!.dispatchEvent(new FocusEvent('focus'));
    await Promise.resolve();

    expect(container?.querySelector('.session-item.keyboard-focus')).toBeNull();
  });

  it('shows an empty state for a search with no matching sessions', async () => {
    setState('sessions', [session('session-1', 500, { title: 'Alpha build' })]);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const input = container?.querySelector('.session-list-search-input') as HTMLInputElement | null;
    expect(input).toBeInstanceOf(HTMLInputElement);

    input!.value = 'missing';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    expect(container?.querySelector('.session-empty')?.textContent?.trim()).toBe(
      'No matching sessions'
    );
  });

  it('pins archive groups outside the scrolling recent sessions list', () => {
    const now = Date.now();
    setState('sessions', [
      session('recent-session', now - 1_000, { title: 'Recent session' }),
      session('older-session', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session' }),
    ]);
    setState('activeSessionId', 'recent-session');
    setState('lastSeenSessions', {
      'recent-session': now - 1_000,
      'older-session': now - (24 * 60 * 60 * 1_000 + 1),
    });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const scrollRegion = container?.querySelector(
      '.session-list-scroll-primary'
    ) as HTMLDivElement | null;
    const bottomGroups = container?.querySelector(
      '.session-list-bottom-groups'
    ) as HTMLDivElement | null;

    expect(scrollRegion).toBeInstanceOf(HTMLDivElement);
    expect(bottomGroups).toBeInstanceOf(HTMLDivElement);
    expect(
      Array.from(scrollRegion?.querySelectorAll('.session-item-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Recent session']);
    expect(
      Array.from(bottomGroups?.querySelectorAll('.session-list-section-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Archive']);
    expect(bottomGroups?.querySelector('.session-list-section-archive')).toBeNull();
  });

  it('keeps showing sessions in the default list when all are older than one day', () => {
    const now = Date.now();
    setState('sessions', [
      session('older-session-a', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session A' }),
      session('older-session-b', now - (2 * 24 * 60 * 60 * 1_000 + 1), {
        title: 'Older session B',
      }),
    ]);
    setState('activeSessionId', 'older-session-a');
    setState('lastSeenSessions', {
      'older-session-a': now - (24 * 60 * 60 * 1_000 + 1),
      'older-session-b': now - (2 * 24 * 60 * 60 * 1_000 + 1),
    });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Older session A', 'Older session B']);
    expect(container?.querySelector('.session-list-bottom-groups')).toBeNull();
  });

  it('scrolls the show more header into view when expanded', async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const now = Date.now();
    setState('sessions', [
      session('recent-session', now - 1_000),
      session('older-session', now - (24 * 60 * 60 * 1_000 + 1)),
    ]);
    setState('activeSessionId', 'recent-session');
    setState('lastSeenSessions', {
      'recent-session': now - 1_000,
      'older-session': now - (24 * 60 * 60 * 1_000 + 1),
    });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const button = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Archive')) as HTMLButtonElement | undefined;
    expect(button).toBeInstanceOf(HTMLButtonElement);

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const sectionTitles = Array.from(
      container?.querySelectorAll('.session-list-section-title') ?? []
    ).map((item) => item.textContent?.trim());
    const sessionTitles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );

    expect(sectionTitles).toEqual(['Recent', 'Archive']);
    expect(sessionTitles).toEqual(['older-session']);
  });

  it('shows recent sessions in an ephemeral group when archive is open', async () => {
    const now = Date.now();
    setState('sessions', [
      session('recent-session', now - 1_000, { title: 'Recent session' }),
      session('older-session', now - (24 * 60 * 60 * 1_000 + 1), { title: 'Older session' }),
    ]);
    setState('activeSessionId', 'recent-session');
    setState('lastSeenSessions', {
      'recent-session': now - 1_000,
      'older-session': now - (24 * 60 * 60 * 1_000 + 1),
    });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const archiveToggle = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Archive')) as HTMLButtonElement | undefined;
    expect(archiveToggle).toBeInstanceOf(HTMLButtonElement);

    archiveToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const sectionTitles = Array.from(
      container?.querySelectorAll('.session-list-section-title') ?? []
    ).map((item) => item.textContent?.trim());
    const sessionTitles = Array.from(container?.querySelectorAll('.session-item-title') ?? []).map(
      (item) => item.textContent?.trim()
    );

    expect(sectionTitles).toEqual(['Recent', 'Archive']);
    expect(sessionTitles).toEqual(['Older session']);

    const recentToggle = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Recent')) as HTMLButtonElement | undefined;
    expect(recentToggle).toBeInstanceOf(HTMLButtonElement);

    recentToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const expandedSectionTitles = Array.from(
      container?.querySelectorAll('.session-list-section-title') ?? []
    ).map((item) => item.textContent?.trim());
    const expandedSessionTitles = Array.from(
      container?.querySelectorAll('.session-item-title') ?? []
    ).map((item) => item.textContent?.trim());

    expect(expandedSectionTitles).toEqual(['Archive']);
    expect(expandedSessionTitles).toEqual(['Recent session']);
  });

  it('scrolls the recycle bin header into view when expanded', async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const now = Date.now();
    setState('sessions', [session('active', now - 1_000)]);
    setState('activeSessionId', 'active');
    setState('recycleBinEntries', [
      {
        rootID: 'deleted-session',
        deletedAt: now - 10_000,
        expiresAt: now + 10_000,
        root: {
          id: 'deleted-session',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Deleted session',
          version: '1',
          time: { created: now - 20_000, updated: now - 10_000 },
        },
        sessions: [
          {
            id: 'deleted-session',
            projectID: 'project-1',
            directory: '/repo',
            title: 'Deleted session',
            version: '1',
            time: { created: now - 20_000, updated: now - 10_000 },
          },
        ],
      },
    ]);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const button = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Recycle Bin')) as HTMLButtonElement | undefined;
    expect(button).toBeInstanceOf(HTMLButtonElement);

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(
      Array.from(container?.querySelectorAll('.session-list-section-title') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Recent', 'Recycle Bin']);
    expect(
      Array.from(container?.querySelectorAll('.session-item-title') ?? []).some(
        (item) => item.textContent?.trim() === 'Deleted session'
      )
    ).toBe(true);
  });

  it('expands recycle bin entries that are missing snapshots', async () => {
    const now = Date.now();
    setState('sessions', [session('active', now - 1_000)]);
    setState('activeSessionId', 'active');
    setState('recycleBinEntries', [
      {
        rootID: 'deleted-session',
        deletedAt: now - 10_000,
        expiresAt: now + 10_000,
      } as never,
    ]);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const toggle = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Recycle Bin')) as HTMLButtonElement | undefined;

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

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
    setState('sessions', [session('active', now - 1_000)]);
    setState('activeSessionId', 'active');
    setState('recycleBinEntries', [
      {
        rootID: 'deleted-session',
        deletedAt: now - 10_000,
        expiresAt: now + 10_000,
        root: {
          id: 'deleted-session',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Deleted session',
          version: '1',
          time: { created: now - 20_000, updated: now - 10_000 },
        },
        sessions: [
          {
            id: 'deleted-session',
            projectID: 'project-1',
            directory: '/repo',
            title: 'Deleted session',
            version: '1',
            time: { created: now - 20_000, updated: now - 10_000 },
          },
        ],
      },
    ]);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const toggle = Array.from(
      container?.querySelectorAll('button.session-list-section-toggle') ?? []
    ).find((item) => item.textContent?.includes('Recycle Bin')) as HTMLButtonElement | undefined;

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const restoreButton = container?.querySelector(
      'button.recycle-bin-restore'
    ) as HTMLButtonElement | null;
    const deleteButton = container?.querySelector(
      'button.recycle-bin-delete'
    ) as HTMLButtonElement | null;

    restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(restoreSpy).toHaveBeenCalledWith('deleted-session');
    expect(deleteSpy).toHaveBeenCalledWith('deleted-session');
  });

  it('does not render the embedded session sidebar when the session picker is open', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('activeSessionId', 'session-1');
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-session-sidebar')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
  });

  it('shows the desktop workspace with a blank chat when the session picker expands to large screens', async () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', null);
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-session-sidebar')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);

    dispatchDesktopMediaQueryChange(true);
    await Promise.resolve();

    expect(container?.querySelector('.chat-workspace')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-session-sidebar')).toBeInstanceOf(HTMLElement);
    expect(container?.querySelector('.session-list-view-sidebar')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.chat-empty-state')).toBeInstanceOf(HTMLDivElement);
    expect(
      container?.querySelector('.chat-header-chat-desktop .chat-header-title-text')?.textContent
    ).toBe('New Chat');
  });

  it('renders settings on desktop while the session picker state is active', async () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');
    setShowSessionPicker(true);
    setShowSettings(true);

    cleanup = render(() => Chat(), container!);

    dispatchDesktopMediaQueryChange(true);
    await Promise.resolve();

    expect(container?.querySelector('.settings-panel')).toBeInstanceOf(HTMLDivElement);
  });

  it('renders settings from the session picker on narrow screens', () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');
    setShowSessionPicker(true);
    setShowSettings(true);

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-workspace')).toBeNull();
    expect(container?.querySelector('.session-list-view')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.settings-panel')).toBeInstanceOf(HTMLDivElement);
  });

  it('renders the desktop session pane on the right when configured', async () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');
    setDesktopSessionPaneSide('right');
    dispatchDesktopMediaQueryChange(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();

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

  it('keeps the message list available when switching the desktop session pane from right to left', async () => {
    setState('sessions', [session('session-1', 500), session('session-2', 400)]);
    setState('activeSessionId', 'session-1');
    setState(
      'messages',
      Array.from({ length: 60 }, (_, index) => assistantMessageEntry(`assistant-${index + 1}`))
    );
    setDesktopSessionPaneSide('right');
    dispatchDesktopMediaQueryChange(true);

    cleanup = render(() => Chat(), container!);
    await Promise.resolve();

    setDesktopSessionPaneSide('left');
    await Promise.resolve();
    await Promise.resolve();

    expect(container?.querySelector('.chat-workspace-pane-right')).toBeNull();
    expect(container?.querySelector('.interactive-list[role="log"]')).toBeInstanceOf(
      HTMLDivElement
    );
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

    setState('sessions', sessions);
    setSessionUsageLimit('limited', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 8_000,
      attempt: 2,
      sessionID: 'limited',
    });

    expect(
      getHeaderFailedCount(sessions, (sessionId) => isFailedSession(sessionId), null, true)
    ).toBe(1);
  });

  it('surfaces child-session permission prompts on the primary session', () => {
    const sessions = [
      session('session-1', 500),
      session('child-1', 400, { parentID: 'session-1' }),
    ];

    setState('sessions', sessions);
    setState('permissions', [
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
    ]);

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

    setState('sessions', sessions);

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
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
    });
    setSessionUsageLimit('session-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 8_000,
      attempt: 2,
      sessionID: 'session-1',
    });

    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(isFailedSession('session-1')).toBe(true);
    expect(isRunningSession('session-1')).toBe(false);
  });

  it('renders a failed indicator when a session is both retrying and failed', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', {
      'session-1': { type: 'retry', attempt: 2, message: 'Retrying request', next: 8 },
    });
    setState('failedSessionIds', ['session-1']);

    cleanup = render(() => Chat(), container!);

    const indicator = container?.querySelector('.session-item .session-item-indicator');

    expect(indicator?.classList.contains('is-failed')).toBe(true);
    expect(indicator?.getAttribute('aria-label')).toBe('Failed');
  });

  it('keeps a parent running when a previously failed sub-agent resumes work', () => {
    setState('sessions', [session('parent', 500), session('child', 400, { parentID: 'parent' })]);
    setState('sessionStatus', {
      child: { type: 'busy' },
    });
    setState('failedSessionIds', ['child']);

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isFailedSession('child')).toBe(false);
    expect(indicators.failedIds.has('child')).toBe(false);
    expect(indicators.failedIds.has('parent')).toBe(false);
    expect(indicators.runningIds.has('child')).toBe(true);
    expect(indicators.runningIds.has('parent')).toBe(true);
  });

  it('does not render a failed indicator for aborted sessions', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('messages', [
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
    ]);

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('session-1')).toBe(false);
  });

  it('renders a plan-ready indicator for unread plan sessions', () => {
    setState('sessions', [session('active', 600), session('plan-1', 500)]);
    setState('activeSessionId', 'active');
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });
    setState('lastSeenSessions', { active: 600, 'plan-1': 0 });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const indicator = container?.querySelector('.session-item .session-item-indicator');

    expect(indicator?.classList.contains('is-completed')).toBe(false);
    expect(indicator?.classList.contains('is-plan-completed')).toBe(true);
    expect(indicator?.getAttribute('aria-label')).toBe('Plan ready');
  });

  it('returns to running once the 429 notice is cleared', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', {
      'session-1': { type: 'retry', attempt: 2, message: '429 usage limit reached', next: 8 },
    });
    setSessionUsageLimit('session-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 8_000,
      attempt: 2,
      sessionID: 'session-1',
    });

    setSessionUsageLimit('session-1', null);
    setSessionFailed('session-1', false);

    expect(hasActiveUsageLimit('session-1')).toBe(false);
    expect(isFailedSession('session-1')).toBe(false);
    expect(isRunningSession('session-1')).toBe(true);
  });

  it('shows completed indicators after synced active messages have completed', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('activeSessionId', 'session-1');
    setState('sessionStatus', {
      'session-1': { type: 'busy' },
    });
    setShowSessionPicker(true);

    setMessagesIncremental([assistantMessageEntry('assistant-1')]);

    cleanup = render(() => Chat(), container!);

    const row = container?.querySelector('.session-item');
    const indicator = row?.querySelector('.session-item-indicator');

    expect(state.sessionStatus['session-1']).toEqual({ type: 'idle' });
    expect(isRunningSession('session-1')).toBe(false);
    expect(indicator?.classList.contains('is-completed')).toBe(true);
  });

  it('does not render the active session status next to the chat header title', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('activeSessionId', 'session-1');
    setMessagesIncremental([assistantMessageEntry('assistant-1')]);

    cleanup = render(() => Chat(), container!);

    expect(container?.querySelector('.chat-header-status-indicator')).toBeNull();
  });

  it('does not treat an incomplete Ralph manager session as running', () => {
    setState('sessions', [session('session-1', 500)]);
    setState('sessionStatus', {
      'session-1': { type: 'busy' },
    });
    ralphStore.startRun({
      managerSessionId: 'session-1',
      workspaceDirectory: '/workspace',
      planDocPath: 'TESTS.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.setStatus('session-1', 'incomplete', 'iteration_limit_with_gap');

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isRunningSession('session-1')).toBe(false);
    expect(indicators.runningIds.has('session-1')).toBe(false);
  });

  it('does not bubble stale child running status to a done Ralph manager session', () => {
    setState('sessions', [
      session('session-1', 500),
      session('child-1', 400, { parentID: 'session-1' }),
    ]);
    setState('sessionStatus', {
      'child-1': { type: 'busy' },
    });
    ralphStore.startRun({
      managerSessionId: 'session-1',
      workspaceDirectory: '/workspace',
      planDocPath: 'PLAN.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.setStatus('session-1', 'done', 'done_marker');

    const indicators = deriveSessionIndicators(state.sessions);

    expect(isRunningSession('child-1')).toBe(false);
    expect(indicators.runningIds.has('session-1')).toBe(false);
    expect(indicators.runningIds.has('child-1')).toBe(false);
  });

  it('does not render stale Ralph child running status in the sub-agent list', async () => {
    setState('sessions', [
      session('manager', 500),
      session('child-1', 400, { parentID: 'manager' }),
    ]);
    setState('activeSessionId', 'manager');
    setState('lastSeenSessions', { manager: 500, 'child-1': 400 });
    setState('sessionStatus', {
      'child-1': { type: 'busy' },
    });
    ralphStore.startRun({
      managerSessionId: 'manager',
      workspaceDirectory: '/workspace',
      planDocPath: 'TESTS.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.setStatus('manager', 'done', 'done_marker');

    cleanup = render(() => Chat(), container!);

    const subagentsButton = container?.querySelector(
      '.chat-header-subagents'
    ) as HTMLButtonElement | null;
    expect(subagentsButton).toBeInstanceOf(HTMLButtonElement);

    subagentsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    const childRow = Array.from(container?.querySelectorAll('.session-item') ?? []).find(
      (item) => item.querySelector('.session-item-title')?.textContent?.trim() === 'child-1'
    );

    expect(childRow).toBeInstanceOf(HTMLDivElement);
    expect(childRow?.querySelector('.session-item-indicator')).toBeNull();
  });

  it('bubbles Ralph child usage-limit failures to the manager session indicator', () => {
    setState('sessions', [
      session('manager', 500),
      session('child-1', 400, { parentID: 'manager' }),
    ]);
    ralphStore.startRun({
      managerSessionId: 'manager',
      workspaceDirectory: '/workspace',
      planDocPath: 'TESTS.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.upsertIteration('manager', {
      index: 1,
      childSessionId: 'child-1',
      status: 'running',
      startedAt: 100,
      endedAt: null,
      filesChanged: [],
      verification: {},
    });
    setSessionUsageLimit('child-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 8_000,
      attempt: 2,
      sessionID: 'child-1',
    });

    const indicators = deriveSessionIndicators(state.sessions);

    expect(indicators.failedIds.has('manager')).toBe(true);
    expect(indicators.runningIds.has('manager')).toBe(false);
  });

  it('does not bubble Ralph child failures to a manually stopped manager session', () => {
    setState('sessions', [
      session('manager', 500),
      session('child-1', 400, { parentID: 'manager' }),
    ]);
    ralphStore.startRun({
      managerSessionId: 'manager',
      workspaceDirectory: '/workspace',
      planDocPath: 'TESTS.md',
      iterations: 15,
      promptTemplate: 'Prompt',
      permissionMode: 'full',
      model: null,
      agent: null,
      createdAt: 1,
    });
    ralphStore.upsertIteration('manager', {
      index: 1,
      childSessionId: 'child-1',
      status: 'failed',
      startedAt: 100,
      endedAt: 200,
      filesChanged: [],
      verification: {},
    });
    setSessionUsageLimit('child-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 8_000,
      attempt: 2,
      sessionID: 'child-1',
    });
    ralphStore.setStatus('manager', 'stopped', 'manual_stop');

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
