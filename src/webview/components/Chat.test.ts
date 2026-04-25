import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { Session } from '../types';
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
  getOtherSessions,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  getSubagentSessionsForParent,
  groupSessions,
  isFailedSession,
  isRunningSession,
  SessionListSectionHeader,
  shouldShowSessionHeaderBadge,
} from './Chat';
import {
  setDesktopSessionPaneSide,
  hasActiveUsageLimit,
  state,
  setSessionFailed,
  setShowSettings,
  setShowSessionPicker,
  setSessionUsageLimit,
  setState,
  skipPlanSession,
} from '../lib/state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalMatchMedia: typeof globalThis.matchMedia | undefined;
let desktopMediaQueryMatches = false;
let desktopMediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

function dispatchDesktopMediaQueryChange(matches: boolean) {
  desktopMediaQueryMatches = matches;
  const event = { matches, media: '(min-width: 1400px)' } as MediaQueryListEvent;
  desktopMediaQueryListeners.forEach((listener) => listener(event));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  originalMatchMedia = globalThis.matchMedia;
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
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('sessions', []);
  setState('sessionStatus', reconcile({}));
  setState('sessionUsageLimits', reconcile({}));
  setState('failedSessionIds', []);
  setState('questions', []);
  setState('permissions', []);
  setState('lastSeenSessions', reconcile({}));
  setState('skippedPlanSessions', reconcile({}));
  setState('sessionSelectedAgents', reconcile({}));
  setState('selectedAgent', null);
  setState('activeSessionId', null);
  setState('messages', []);
  setState('queuedMessages', []);
  setState('pendingAttentionSessionIds', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
  setState('compactingSessionIds', []);
  setDesktopSessionPaneSide('left');
  setShowSessionPicker(false);
  setShowSettings(false);
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.matchMedia = originalMatchMedia;
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
});

describe('header status badges', () => {
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

  it('shows only the title in the desktop chat header', () => {
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
    expect(desktopActions).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-running-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-running-count')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-failed-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-attention-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-plan-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-completed-badge')).toBeNull();
    expect(desktopHeader?.querySelector('.chat-header-btn[title="New chat"]')).toBeNull();
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

  it('filters completed sessions from the header badge', async () => {
    setState('sessions', [
      session('active', 500),
      session('completed-1', 400),
      session('completed-2', 300),
      session('other', 200),
    ]);
    setState('activeSessionId', 'active');
    setState('lastSeenSessions', { active: 500, other: 200 });

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

    cleanup = render(() => Chat(), container!);

    const chatHeader = container?.querySelector('.interactive-session > .chat-header');
    expect(chatHeader?.querySelector('.chat-header-completed-badge')).toBeNull();
    expect(
      container?.querySelector('.chat-session-sidebar-header .chat-header-completed-badge')
    ).toBeInstanceOf(HTMLButtonElement);
    const activeIndicator = container?.querySelector(
      '.session-item.active .session-item-indicator'
    );
    expect(activeIndicator?.classList.contains('is-completed')).toBe(true);
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

  it('renders a completed indicator for unread plan sessions', () => {
    setState('sessions', [session('active', 600), session('plan-1', 500)]);
    setState('activeSessionId', 'active');
    setState('sessionSelectedAgents', { 'plan-1': 'plan' });
    setState('lastSeenSessions', { active: 600, 'plan-1': 0 });
    setShowSessionPicker(true);

    cleanup = render(() => Chat(), container!);

    const indicator = container?.querySelector('.session-item .session-item-indicator');

    expect(indicator?.classList.contains('is-completed')).toBe(true);
    expect(indicator?.classList.contains('is-plan-completed')).toBe(false);
    expect(indicator?.getAttribute('aria-label')).toBe('Completed');
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
