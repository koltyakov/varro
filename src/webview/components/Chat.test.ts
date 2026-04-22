import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { Session } from '../types';
import { normalizeSessionTitle } from '../../shared/session-title';
import {
  archiveSessionGroup,
  Chat,
  getAttentionSessions,
  getArchiveSessionGroupConfirmationMessage,
  getHeaderAttentionCount,
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
  hasActiveUsageLimit,
  setSessionFailed,
  setSessionUsageLimit,
  setState,
} from '../lib/state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('sessions', []);
  setState('sessionStatus', {});
  setState('sessionUsageLimits', {});
  setState('failedSessionIds', []);
  setState('questions', []);
  setState('permissions', []);
  setState('lastSeenSessions', {});
  setState('sessionSelectedAgents', {});
  setState('activeSessionId', null);
  globalThis.ResizeObserver = originalResizeObserver;
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
  it('separates sub-agent sessions from primary session groups', () => {
    const sessions = [
      session('running-primary', 500),
      session('attention-primary', 400),
      session('other-primary', 300),
      session('subagent-newer', 600, { parentID: 'parent-1' }),
      session('subagent-older', 200, { parentID: 'parent-2' }),
    ];

    const groups = groupSessions(
      sessions,
      (sessionId) => sessionId === 'running-primary',
      (sessionId) => sessionId === 'attention-primary',
      () => false,
      () => false,
      () => false,
      10
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

  it('caps surfaced primary others without affecting sub-agent ordering', () => {
    const sessions = [
      session('other-1', 500),
      session('subagent-1', 490, { parentID: 'parent-1' }),
      session('other-2', 480),
      session('subagent-2', 470, { parentID: 'parent-2' }),
      session('other-3', 460),
    ];

    const groups = groupSessions(
      sessions,
      () => false,
      () => false,
      () => false,
      () => false,
      () => false,
      2
    );

    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-1', 'other-2']);
    expect(groups.overflowOther.map((item) => item.id)).toEqual(['other-3']);
    expect(groups.subagents.map((item) => item.id)).toEqual(['subagent-1', 'subagent-2']);
  });

  it('keeps priority statuses outside others and sorts them by priority then age', () => {
    const sessions = [
      session('other-newest', 900),
      session('running-newer', 800),
      session('attention-older', 700),
      session('failed-older', 600),
      session('plan-ready-newer', 500),
      session('failed-newer', 400),
      session('attention-newer', 300),
      session('plan-ready-older', 200),
      session('other-older', 100),
    ];

    const groups = groupSessions(
      sessions,
      (sessionId) => sessionId === 'running-newer',
      (sessionId) => sessionId === 'attention-older' || sessionId === 'attention-newer',
      (sessionId) => sessionId === 'failed-older' || sessionId === 'failed-newer',
      (item) => item.id === 'plan-ready-newer' || item.id === 'plan-ready-older',
      () => false,
      1
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
        (item) => item.id === 'plan-ready-primary'
      ).map((item) => item.id)
    ).toEqual(['plan-ready-primary']);
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
  });

  it('keeps other badges visible', () => {
    expect(shouldShowSessionHeaderBadge('failed', 'running')).toBe(true);
    expect(shouldShowSessionHeaderBadge(null, 'plan-ready')).toBe(true);
  });
});

describe('normalizeSessionTitle', () => {
  it('collapses generated timestamped new-session titles', () => {
    expect(normalizeSessionTitle('New session - 2026-04-22T17:00:10.819Z')).toBe('New session');
  });

  it('preserves custom titles', () => {
    expect(normalizeSessionTitle('New session - onboarding notes')).toBe(
      'New session - onboarding notes'
    );
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
