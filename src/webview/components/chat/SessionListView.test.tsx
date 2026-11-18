import { flush as flushSolid, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { render } from '@solidjs/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types';
import type { SessionDiffSummary } from '../../../shared/protocol';
import { client } from '../../lib/client';
import {
  error,
  markSessionResponseCompleted,
  markSessionResponseInterrupted,
  markSessionSeen,
  setSessions,
  setError,
  setShowSessionPicker,
  setState,
  showSessionPicker,
  state as appState,
} from '../../lib/state';
import { selectSession } from '../../hooks/useOpenCode';
import {
  getSessionDiffSummaryStateForTests,
  resetSessionDiffSummaryStateForTests,
  deriveSessionIndicators,
  getSessionStatusIndicatorKind,
  isRunningSession,
  SessionListSectionHeader,
  SessionListView,
} from './SessionListView';
import { SessionActionFeedback } from './SessionActionFeedback';
import { SessionLocationIndicator } from './SessionLocationIndicator';
import {
  applySessionShareOverride,
  resetSessionShareOverridesForTests,
} from '../../lib/session-share-overrides';
import { fixture } from '../../test-fixtures';
import {
  compressIcon,
  gitIcon,
  flashSolidIcon,
  forwardMessageIcon,
  hourglassIcon,
} from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
import * as locationActions from '../../lib/session-location-actions';

type TestRuntimeValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | TestRuntimeObject
  | readonly TestRuntimeValue[];
interface TestRuntimeObject {
  readonly [key: string]: TestRuntimeValue;
  readonly type?: string;
  readonly id?: string | number;
  readonly message?: string;
}

const renameSessionMock = vi.hoisted(() => vi.fn());
const reloadSessionsMock = vi.hoisted(() => vi.fn());
const loadMoreSessionsMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise SessionListView's useOpenCode module integration. */
vi.mock('../../hooks/useOpenCode', () => ({
  deleteSession: vi.fn(),
  deleteSessionPermanently: vi.fn(),
  emptyRecycleBin: vi.fn(),
  restoreSession: vi.fn(),
  renameSession: renameSessionMock,
  reloadSessions: reloadSessionsMock,
  loadMoreSessions: loadMoreSessionsMock,
  selectSession: vi.fn(),
}));

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
const originalIntersectionObserver = globalThis.IntersectionObserver;

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    summary: { files: 0, additions: 0, deletions: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function openSessionActions(row: HTMLElement, x = 40, y = 50) {
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
  );
}

function restoreRealTimers() {
  // Unmounting a focused input queues jsdom's focus fixup on its rendering interval.
  // Finish that frame before discarding fake timers, or later frames can stall.
  vi.advanceTimersToNextFrame();
  vi.useRealTimers();
}

function createDragDataTransfer() {
  const values = new Map<string, string>();
  const types: string[] = [];
  // SAFETY: The fixture provides the DataTransfer fields exercised by these drag tests.
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

describe('deriveSessionIndicators', () => {
  it.each(['local', 'metadata'] as const)(
    'counts %s child compaction as active work on both child and parent',
    (source) => {
      const sessions = [
        session('root', 1),
        session('child', 2, {
          parentID: 'root',
          time: { created: 1, updated: 2, compacting: source === 'metadata' ? 3 : undefined },
        }),
      ];
      setSessions(sessions);
      flushSolid();
      if (source === 'local') setState(storePath('compactingSessionIds', ['child']));
      flushSolid();
      setState(
        storePath('sessionStatus', {
          root: { type: 'idle' },
          child: { type: 'idle' },
        })
      );
      flushSolid();
      setState(storePath('completedSessionResponses', { root: 10, child: 10 }));
      flushSolid();
      setState(storePath('lastSeenSessions', { root: 0, child: 0 }));
      flushSolid();

      const indicators = deriveSessionIndicators(sessions, new Set(['child']));
      expect([...indicators.runningIds].toSorted()).toEqual(['child', 'root']);
      expect([...indicators.compactingIds].toSorted()).toEqual(['child', 'root']);
      expect(indicators.pendingIds.size).toBe(0);
      expect(indicators.newlyCompletedIds.size).toBe(0);
      expect(isRunningSession('child')).toBe(true);
    }
  );

  it('keeps failures and attention ahead of the compacting indicator', () => {
    const input = {
      isFailed: false,
      hasPendingInput: false,
      isRunning: true,
      isPending: true,
      isCompacting: true,
      isPlanReady: true,
      isCompleted: true,
    };
    expect(getSessionStatusIndicatorKind(input)).toBe('compacting');
    expect(getSessionStatusIndicatorKind({ ...input, hasPendingInput: true })).toBe('attention');
    expect(getSessionStatusIndicatorKind({ ...input, isFailed: true })).toBe('failed');
  });

  it('keeps pending waits unfinished and prefers active work in the same tree', () => {
    const sessions = [session('root', 1), session('child', 2, { parentID: 'root' })];
    setSessions(sessions);
    flushSolid();
    setState(
      storePath('sessionStatus', {
        root: { type: 'idle' },
        child: { type: 'busy', background: true, backgroundStartedAt: 1 },
      })
    );
    flushSolid();
    const waiting = deriveSessionIndicators(sessions, new Set(['child']));
    expect([...waiting.pendingIds].toSorted()).toEqual(['child', 'root']);
    expect(waiting.runningIds.has('root')).toBe(true);
    expect(waiting.newlyCompletedIds.has('root')).toBe(false);

    setState(storePath('sessionStatus', 'root', { type: 'busy' }));
    flushSolid();
    const active = deriveSessionIndicators(sessions, new Set(['child']));
    expect([...active.pendingIds]).toEqual(['child']);
  });
  it('handles cyclic and deeply nested session parent data without recursive overflow', () => {
    const cyclic = [
      session('cycle-a', 1, { parentID: 'cycle-b' }),
      session('cycle-b', 2, { parentID: 'cycle-a' }),
    ];
    setSessions(cyclic);
    flushSolid();
    expect(() => deriveSessionIndicators(cyclic)).not.toThrow();

    const depth = 15_000;
    const nested = Array.from({ length: depth }, (_, index) =>
      session(`nested-${index}`, index + 1, {
        parentID: index === 0 ? undefined : `nested-${index - 1}`,
      })
    );
    setSessions(nested);
    flushSolid();

    const indicators = deriveSessionIndicators(nested);
    expect(indicators.subagentCounts.get('nested-0')).toBe(depth - 1);
    expect(indicators.subagentCounts.has(`nested-${depth - 1}`)).toBe(false);
  });
});

beforeEach(() => {
  resetSessionShareOverridesForTests();
  flushSolid();
  resetSessionDiffSummaryStateForTests();
  flushSolid();
  setState(storePath('sessions', []));
  flushSolid();
  setState(storePath('providers', []));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionSelectedModels'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionSelectedModels'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('pinnedSessionIds', []));
  flushSolid();
  setState(storePath('activeSessionId', null));
  flushSolid();
  setState(storePath('editorTabsOpen', false));
  flushSolid();
  setState(storePath('editorSessionIds', []));
  flushSolid();
  setState(storePath('openEditorSessionIds', []));
  flushSolid();
  setState(storePath('sessionStatus', {}));
  flushSolid();
  setState(storePath('compactingSessionIds', []));
  flushSolid();
  setState(storePath('queuedMessages', []));
  flushSolid();
  setState(
    storePath('editorContext', {
      workspacePath: null,
      workspaceFolders: [],
      activeFile: null,
      selection: null,
      diagnostics: [],
    })
  );
  flushSolid();
  setState(storePath('editorTabsOpen', false));
  flushSolid();
  setState((draft) => {
    const current = draft['completedSessionResponses'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['completedSessionResponses'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState((draft) => {
    const current = draft['interruptedSessionResponses'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['interruptedSessionResponses'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('sessionsLoadError', null));
  flushSolid();
  setState(storePath('sessionsHasMore', false));
  flushSolid();
  setState(storePath('sessionsLoadingMore', false));
  flushSolid();
  setState(storePath('sessionsPaginationError', null));
  flushSolid();
  setState(storePath('recycleBinLoadError', null));
  flushSolid();
  setError(null);
  flushSolid();
  renameSessionMock.mockReset();
  renameSessionMock.mockResolvedValue(true);
  reloadSessionsMock.mockReset();
  reloadSessionsMock.mockResolvedValue(undefined);
  loadMoreSessionsMock.mockReset();
  loadMoreSessionsMock.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  setState(storePath('sessions', []));
  flushSolid();
  setState(storePath('providers', []));
  flushSolid();
  setState((draft) => {
    const current = draft['sessionSelectedModels'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionSelectedModels'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('pinnedSessionIds', []));
  flushSolid();
  setState(storePath('sessionStatus', {}));
  flushSolid();
  setState(storePath('compactingSessionIds', []));
  flushSolid();
  setState(storePath('queuedMessages', []));
  flushSolid();
  setState((draft) => {
    const current = draft['completedSessionResponses'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['completedSessionResponses'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState((draft) => {
    const current = draft['interruptedSessionResponses'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['interruptedSessionResponses'] = incoming;
    else reconcile(incoming)(current);
  });
  flushSolid();
  setState(storePath('sessionsLoadError', null));
  flushSolid();
  setState(storePath('sessionsHasMore', false));
  flushSolid();
  setState(storePath('sessionsLoadingMore', false));
  flushSolid();
  setState(storePath('sessionsPaginationError', null));
  flushSolid();
  setState(storePath('recycleBinLoadError', null));
  flushSolid();
  setError(null);
  flushSolid();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension;
  vi.restoreAllMocks();
  flushSolid();
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    // SAFETY: The fixture provides the Partial<typeof globalThis> fields read by this statement.
    delete (globalThis as Partial<typeof globalThis>).IntersectionObserver;
  }
  resetSessionDiffSummaryStateForTests();
  flushSolid();
  resetSessionShareOverridesForTests();
  flushSolid();
});

describe('SessionListSectionHeader icons', () => {
  it('uses sized adapter icons and preserves the expanded chevron state', () => {
    const onToggle = vi.fn();
    cleanup = render(
      () => (
        <SessionListSectionHeader
          title="Archive"
          count={2}
          expanded={true}
          onToggle={onToggle}
          onArchive={vi.fn()}
        />
      ),
      container
    );
    flushSolid();

    const archiveIcon = container.querySelector<HTMLElement>('.session-list-section-archive-icon');
    expect(archiveIcon?.classList).toContain('ui-icon');
    expect(archiveIcon?.style.getPropertyValue('--ui-icon-width')).toBe('14px');

    const chevron = container.querySelector<HTMLElement>('.session-list-section-chevron');
    expect(chevron?.classList).toContain('ui-icon');
    expect(chevron?.classList).toContain('expanded');
    expect(chevron?.style.getPropertyValue('--ui-icon-width')).toBe('12px');

    container.querySelector<HTMLButtonElement>('.session-list-section-chevron-button')!.click();
    flushSolid();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('SessionListView keyboard recovery', () => {
  it.each(['local', 'metadata'] as const)(
    'shows the compress icon in the running filter during %s compaction',
    (source) => {
      vi.useFakeTimers();
      setSessions([session('compacting', 10), session('idle', 9)]);
      flushSolid();
      setState(
        storePath('sessionStatus', { compacting: { type: 'idle' }, idle: { type: 'idle' } })
      );
      flushSolid();
      try {
        cleanup = render(() => <SessionListView sessionFilter="running" />, container);
        flushSolid();
        expect(container.querySelector('.session-item')).toBeNull();

        if (source === 'local') setState(storePath('compactingSessionIds', ['compacting']));
        else setState(storePath('sessions', 0, 'time', 'compacting', 11));
        flushSolid();

        expect(container.querySelectorAll('.session-item')).toHaveLength(1);
        const indicator = container.querySelector<HTMLElement>(
          '.session-status-indicator.is-compacting'
        );
        expect(indicator?.getAttribute('title')).toBe('Compacting');
        expect(indicator?.getAttribute('aria-label')).toBe('Compacting');
        expect(
          indicator
            ?.querySelector<HTMLElement>('.ui-icon')
            ?.style.getPropertyValue('--ui-icon-mask')
        ).toBe(toCssUrl(compressIcon));
        expect(container.querySelector('.session-status-indicator.is-running')).toBeNull();

        setState(storePath('sessionStatus', 'compacting', { type: 'busy' }));
        flushSolid();
        expect(container.querySelector('.session-status-indicator.is-compacting')).not.toBeNull();
        if (source === 'local') setState(storePath('compactingSessionIds', []));
        else setState(storePath('sessions', 0, 'time', 'compacting', storePath.DELETE));
        flushSolid();
        expect(container.querySelector('.session-status-indicator.is-compacting')).toBeNull();
        expect(container.querySelector('.session-status-indicator.is-running')).not.toBeNull();

        setState(storePath('sessionStatus', 'compacting', { type: 'idle' }));
        flushSolid();
        vi.advanceTimersByTime(1200);
        flushSolid();
        expect(container.querySelector('.session-item')).toBeNull();
      } finally {
        cleanup?.();
        flushSolid();
        cleanup = undefined;
        restoreRealTimers();
        flushSolid();
      }
    }
  );

  it('replaces the spinner with a counter-free hourglass after one minute of background waiting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    flushSolid();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    setSessions([session('waiting', Date.now())]);
    flushSolid();
    setState(
      storePath('sessionStatus', {
        waiting: { type: 'busy', background: true, backgroundStartedAt: Date.now() },
      })
    );
    flushSolid();
    try {
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      vi.advanceTimersByTime(59_999);
      flushSolid();
      expect(container.querySelector('.session-status-indicator.is-running')).not.toBeNull();
      vi.advanceTimersByTime(1);
      flushSolid();
      const pending = container.querySelector<HTMLElement>('.session-status-indicator.is-pending');
      expect(pending?.getAttribute('aria-label')).toBe('Pending background task');
      expect(pending?.textContent).toBe('');
      expect(
        pending?.querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
      ).toBe(toCssUrl(hourglassIcon));
      expect(container.querySelector('.session-status-indicator.is-running')).toBeNull();
      setState(storePath('sessionStatus', 'waiting', { type: 'busy', background: false }));
      flushSolid();
      expect(container.querySelector('.session-status-indicator.is-pending')).toBeNull();
      expect(container.querySelector('.session-status-indicator.is-running')).not.toBeNull();
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
      restoreRealTimers();
      flushSolid();
    }
  });
  it.each(['idle', 'busy'] as const)('mounts a visible %s session with its clocks', (type) => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    setSessions([session('visible-session', Date.now())]);
    flushSolid();
    setState(storePath('sessionStatus', { 'visible-session': { type } }));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.querySelector('.session-item')?.textContent).toContain('visible-session');
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 1_000)).toBe(type === 'busy');
  });

  it.each([false, true])('handles Escape with no sessions, embedded=%s', (embedded) => {
    setSessions([]);
    flushSolid();
    setShowSessionPicker(true);
    flushSolid();
    cleanup = render(() => <SessionListView embedded={embedded} />, container);
    flushSolid();
    container
      .querySelector('.session-list-view')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    flushSolid();
    expect(showSessionPicker()).toBe(embedded);
  });
});

describe('SessionListView model details', () => {
  it('shares the header worktree verification with the sessions list', async () => {
    const directory = '/worktrees/feature';
    setState(storePath('editorContext', 'workspacePath', '/repo'));
    flushSolid();
    setSessions([
      session('worktree', Date.now(), {
        directory,
        transfer: { originDirectory: '/repo', available: true },
      }),
    ]);
    flushSolid();
    const location = vi.spyOn(client.varro.session, 'location').mockResolvedValue({
      directory,
      isGitWorktree: true,
    });
    cleanup = render(
      () => (
        <>
          <SessionListView />
          <SessionLocationIndicator
            sessionId="worktree"
            directory={directory}
            isGitWorktree={appState.sessions[0]?.isGitWorktree}
            moved={true}
          />
        </>
      ),
      container
    );
    flushSolid();

    await vi.waitFor(() => {
      flushSolid();
      expect(container.querySelector('.chat-header-location')?.getAttribute('aria-label')).toBe(
        'Session Git worktree'
      );
    });
    expect(location).toHaveBeenCalledExactlyOnceWith('worktree', { directory });
    expect(appState.sessions[0]?.isGitWorktree).toBe(true);
    const label = container.querySelector('.session-item-folder')!;
    expect(label.textContent).toBe('feature');
    expect(
      label
        .querySelector<HTMLElement>('.session-item-folder-meta-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(gitIcon));
    expect(container.querySelector('[aria-label="Git worktree"]')).not.toBeNull();
  });

  it.each([false, true])(
    'offers location actions from a moved row icon, worktree=%s',
    (worktree) => {
      const copy = vi.spyOn(locationActions, 'copySessionFolderPath').mockResolvedValue();
      setSessions([
        session('moved', Date.now(), {
          directory: '/outside',
          isGitWorktree: worktree,
          transfer: { originDirectory: '/repo', available: true },
        }),
      ]);
      flushSolid();
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      container
        .querySelector('.session-item-folder-meta-icon')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      flushSolid();
      const items = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      expect(items.some((item) => item.textContent?.trim() === 'Merge changes')).toBe(worktree);
      items.find((item) => item.textContent?.trim() === 'Copy folder path')!.click();
      flushSolid();
      expect(copy).toHaveBeenCalledExactlyOnceWith('/outside');
    }
  );

  it.each([false, true])(
    'uses the Git icon and path for a verified worktree, moved=%s',
    (moved) => {
      setState(storePath('editorContext', 'workspacePath', '/repo'));
      flushSolid();
      setSessions([
        session('worktree', Date.now(), {
          directory: '/worktrees/feature',
          isGitWorktree: true,
          transfer: moved ? { originDirectory: '/repo', available: true } : undefined,
        }),
      ]);
      flushSolid();
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      const label = container.querySelector('.session-item-folder')!;
      expect(label.textContent).toBe('feature');
      expect(label.textContent).not.toContain('Worktree:');
      expect(label.textContent).not.toContain('Moved to');
      expect(label.getAttribute('title')).toBe('/worktrees/feature');
      const icon = label.querySelector<HTMLElement>('.session-item-folder-meta-icon')!;
      expect(icon.getAttribute('aria-label')).toBe('Git worktree');
      expect(icon.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(gitIcon));
    }
  );

  it('hides a moved link from its origin list without deleting or switching the active conversation', async () => {
    const moved = session('moved', Date.now(), {
      directory: '/outside',
      transfer: { originDirectory: '/repo', available: false },
    });
    setState(storePath('editorContext', 'workspacePath', '/repo'));
    flushSolid();
    setSessions([moved, session('local', Date.now() - 1)]);
    flushSolid();
    setState(storePath('activeSessionId', 'moved'));
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    const hide = vi.spyOn(client.varro.session, 'hideTransfer').mockResolvedValue(true);
    const reload = deferred<void>();
    reloadSessionsMock.mockReturnValueOnce(reload.promise);
    const count = vi.fn();
    cleanup = render(() => <SessionListView onPrimarySessionsCountChange={count} />, container);
    flushSolid();
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    const action = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent === 'Hide from this list');
    expect(action).toBeDefined();
    action!.click();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelectorAll('.session-item')).toHaveLength(1));
    flushSolid();
    expect(container.querySelector('.session-item')?.textContent).toContain('local');
    expect(hide).toHaveBeenCalledExactlyOnceWith('moved', { directory: '/repo' });
    expect(appState.activeSessionId).toBe('moved');
    expect(appState.sessions.find((item) => item.id === 'moved')).toBeDefined();
    expect(count).toHaveBeenLastCalledWith(1);
    expect(document.querySelector('.session-item-actions-menu')).toBeNull();
    expect(reloadSessionsMock).toHaveBeenCalledOnce();
    expect(appState.sessions.find((item) => item.id === 'moved')?.transfer?.hiddenOrigins).toEqual([
      '/repo',
    ]);
    reload.resolve();
    flushSolid();
  });

  it('keeps the moved link visible and reports a failed hide', async () => {
    setSessions([
      session('moved', Date.now(), {
        directory: '/outside',
        transfer: { originDirectory: '/repo', available: false },
      }),
    ]);
    flushSolid();
    vi.spyOn(client.varro.session, 'hideTransfer').mockRejectedValue(
      new Error('Storage unavailable')
    );
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent === 'Hide from this list')!
      .click();
    flushSolid();
    await vi.waitFor(() => expect(error()).toBe('Storage unavailable'));
    flushSolid();
    expect(container.querySelectorAll('.session-item')).toHaveLength(1);
    expect(reloadSessionsMock).not.toHaveBeenCalled();
  });

  it('hides only the dismissed origin when switching a multi-root list', () => {
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [
          { name: 'Repo', path: '/repo' },
          { name: 'Outside', path: '/outside' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setSessions([
      session('moved', Date.now(), {
        directory: '/outside',
        transfer: { originDirectory: '/repo', available: true, hiddenOrigins: ['/repo'] },
      }),
    ]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    expect(container.querySelectorAll('.session-item')).toHaveLength(1);
    const selector = container.querySelector('.session-list-workspace-selector')!;
    selector.querySelector<HTMLButtonElement>('.workspace-picker-button')!.click();
    flushSolid();
    selector.querySelector<HTMLButtonElement>('[data-workspace-path="/repo"]')!.click();
    flushSolid();
    expect(container.querySelectorAll('.session-item')).toHaveLength(0);
  });

  it('does not restore hidden links through native search results', async () => {
    const moved = session('moved', Date.now(), {
      directory: '/outside',
      transfer: { originDirectory: '/repo', available: false, hidden: true },
    });
    setSessions([moved]);
    flushSolid();
    vi.spyOn(client.session, 'list').mockResolvedValue({ items: [moved], hasMore: false });
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const search = container.querySelector<HTMLInputElement>('.session-list-search-input')!;
    search.value = 'moved';
    search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalled());
    flushSolid();
    expect(container.querySelectorAll('.session-item')).toHaveLength(0);
  });

  it.each([false, true])(
    'does not offer hiding for a destination-folder session, transfer=%s',
    (transfer) => {
      setState(storePath('editorContext', 'workspacePath', '/repo'));
      flushSolid();
      setSessions([
        session('local', Date.now(), {
          transfer: transfer ? { originDirectory: '/other', available: true } : undefined,
        }),
      ]);
      flushSolid();
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
      flushSolid();
      expect(document.querySelector('.session-item-actions-menu')?.textContent).not.toContain(
        'Hide from this list'
      );
    }
  );

  it('keeps a transferred conversation in the origin folder with a workspace-style destination label', async () => {
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [
          { name: 'Repo', path: '/repo' },
          { name: 'Other', path: '/other' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setState(
      storePath('sessions', [
        session('Transferred conversation', Date.now(), {
          directory: '/outside',
          transfer: { originDirectory: '/repo', available: false },
        }),
        session('Other conversation', Date.now() - 1, { directory: '/other' }),
      ])
    );
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const selector = container.querySelector('.session-list-workspace-selector');
    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo"]')?.click();
    flushSolid();
    await vi.waitFor(() => expect(container.querySelectorAll('.session-item')).toHaveLength(1));
    flushSolid();
    const row = container.querySelector('.session-item');
    expect(row?.textContent).toContain('Transferred conversation');
    expect(row?.querySelector('.session-item-folder')?.textContent).toBe('Moved to outside');
    expect(row?.querySelector('.session-item-folder')?.getAttribute('title')).toBe('/outside');
    vi.mocked(selectSession).mockClear();
    row?.querySelector<HTMLButtonElement>('.session-item-main')?.click();
    flushSolid();
    expect(selectSession).toHaveBeenCalledWith(
      'Transferred conversation',
      expect.objectContaining({ directory: '/outside' })
    );
  });
  it('persists project scope from the search-row picker and hides it while searching', async () => {
    const getScope = vi
      .spyOn(client.varro.sessionHistoryScope, 'get')
      .mockResolvedValue({ scope: 'project', git: true });
    const setScope = vi
      .spyOn(client.varro.sessionHistoryScope, 'set')
      .mockResolvedValue({ scope: 'descendants', git: true });
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'Repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();

    cleanup = render(() => <SessionListView onPrimarySessionsCountChange={vi.fn()} />, container);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const trigger = container.querySelector<HTMLButtonElement>('.session-history-scope-trigger')!;
    expect(getScope).toHaveBeenCalledWith('/repo');
    expect(trigger.textContent).toContain('Project');
    reloadSessionsMock.mockClear();
    trigger.click();
    flushSolid();
    const below = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.session-history-scope-option')
    ).find((option) => option.textContent?.includes('Nested'))!;
    below.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(setScope).toHaveBeenCalledWith('/repo', 'descendants');
    expect(reloadSessionsMock).toHaveBeenCalledOnce();

    const search = container.querySelector<HTMLInputElement>('.session-list-search-input')!;
    search.value = 'active';
    search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();
    expect(container.querySelector('.session-history-scope-picker')).toBeNull();

    container.querySelector<HTMLButtonElement>('.session-list-search-clear')!.click();
    flushSolid();
    expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
      'Nested'
    );
    expect(getScope).toHaveBeenCalledOnce();
    expect(reloadSessionsMock).toHaveBeenCalledOnce();
  });

  it('updates the scope picker immediately while persistence remains pending', async () => {
    vi.spyOn(client.varro.sessionHistoryScope, 'get').mockResolvedValue({
      scope: 'directory',
      git: true,
    });
    let resolveSet!: (result: { scope: 'descendants'; git: true }) => void;
    const setRequest = new Promise<{ scope: 'descendants'; git: true }>((resolve) => {
      resolveSet = resolve;
    });
    vi.spyOn(client.varro.sessionHistoryScope, 'set').mockReturnValue(setRequest);
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'Repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
        'Folder'
      );
    });
    flushSolid();
    const trigger = container.querySelector<HTMLButtonElement>('.session-history-scope-trigger')!;
    trigger.click();
    flushSolid();
    const nested = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.session-history-scope-option')
    ).find((option) => option.textContent?.includes('Nested'))!;
    nested.click();
    flushSolid();

    expect(trigger.textContent).toContain('Nested');
    expect(container.querySelector('.session-history-scope-menu')).toBeNull();
    expect(reloadSessionsMock).not.toHaveBeenCalled();

    resolveSet({ scope: 'descendants', git: true });
    flushSolid();
    await vi.waitFor(() => expect(reloadSessionsMock).toHaveBeenCalledOnce());
    flushSolid();
  });

  it('ignores a scope save that completes after the directory changes', async () => {
    const save = deferred<{ scope: 'directory'; git: true }>();
    vi.spyOn(client.varro.sessionHistoryScope, 'get').mockImplementation(async (directory) => ({
      scope: directory === '/repo-b' ? 'project' : 'directory',
      git: true,
    }));
    const setScope = vi
      .spyOn(client.varro.sessionHistoryScope, 'set')
      .mockReturnValue(save.promise);
    setState(
      storePath('editorContext', {
        workspacePath: '/repo-a',
        workspaceFolders: [{ name: 'Repo A', path: '/repo-a' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setState(
      storePath('sessions', [session('nested-session', 1, { directory: '/repo-b/nested' })])
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
        'Folder'
      );
    });
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-history-scope-trigger')!.click();
    flushSolid();
    Array.from(container.querySelectorAll<HTMLButtonElement>('.session-history-scope-option'))
      .find((option) => option.textContent?.includes('Nested'))!
      .click();
    flushSolid();
    expect(setScope).toHaveBeenCalledWith('/repo-a', 'descendants');

    setState(
      storePath('editorContext', {
        workspacePath: '/repo-b',
        workspaceFolders: [{ name: 'Repo B', path: '/repo-b' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
        'Project'
      );
      expect(container.querySelector('.session-item-folder')?.getAttribute('title')).toBe(
        '/repo-b/nested'
      );
    });
    flushSolid();
    expect(reloadSessionsMock).toHaveBeenCalledOnce();

    save.resolve({ scope: 'directory', git: true });
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
      'Project'
    );
    expect(container.querySelector('.session-item-folder')?.getAttribute('title')).toBe(
      '/repo-b/nested'
    );
    expect(reloadSessionsMock).toHaveBeenCalledOnce();
  });

  it('ignores a scope save error after unmount', async () => {
    const save = deferred<{ scope: 'descendants'; git: true }>();
    vi.spyOn(client.varro.sessionHistoryScope, 'get').mockResolvedValue({
      scope: 'directory',
      git: true,
    });
    vi.spyOn(client.varro.sessionHistoryScope, 'set').mockReturnValue(save.promise);
    setState(
      storePath('editorContext', {
        workspacePath: '/repo',
        workspaceFolders: [{ name: 'Repo', path: '/repo' }],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
        'Folder'
      );
    });
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-history-scope-trigger')!.click();
    flushSolid();
    Array.from(container.querySelectorAll<HTMLButtonElement>('.session-history-scope-option'))
      .find((option) => option.textContent?.includes('Nested'))!
      .click();
    flushSolid();

    cleanup();
    flushSolid();
    cleanup = undefined;
    save.reject(new Error('stale save failure'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(error()).toBeNull();
    expect(reloadSessionsMock).not.toHaveBeenCalled();
  });

  it.each(['descendants', 'project'] as const)(
    'shows compact folder names for sessions outside the current folder in %s scope',
    async (scope) => {
      vi.spyOn(client.varro.sessionHistoryScope, 'get').mockResolvedValue({ scope, git: true });
      setState(
        storePath('editorContext', {
          workspacePath: '/repo',
          workspaceFolders: [{ name: 'Repo', path: '/repo' }],
          activeFile: null,
          selection: null,
          diagnostics: [],
        })
      );
      flushSolid();
      setState(
        storePath('sessions', [
          session('root-session', 2, { directory: '/repo' }),
          session('nested-session', 1, { directory: '/repo/src/qil-frontend-web' }),
        ])
      );
      flushSolid();

      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      await vi.waitFor(() => {
        expect(container.querySelectorAll('.session-item-folder')).toHaveLength(1);
      });
      flushSolid();

      const folder = container.querySelector<HTMLElement>('.session-item-folder');
      expect(folder?.textContent).toBe('qfw');
      expect(folder?.title).toBe('/repo/src/qil-frontend-web');
      expect(
        container
          .querySelector('.session-item-folder')
          ?.closest('.session-item')
          ?.querySelector('.session-item-title-text')?.textContent
      ).toBe('nested-session');
      flushSolid();
    }
  );

  it('shows folder scope only after selecting a folder in a multi-root workspace', async () => {
    const onPrimarySessionsCountChange = vi.fn();
    const getScope = vi.spyOn(client.varro.sessionHistoryScope, 'get').mockResolvedValue({
      scope: 'project',
      git: true,
    });
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState(
      storePath('editorContext', {
        workspacePath: '/repo-a',
        workspaceFolders: [
          { name: 'carpathia-lambda-label-management', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setState(
      storePath('sessions', [
        session('session-1', 2, { directory: '/repo-a', workspaceScope: 'workspace' }),
        session('session-2', 1, { directory: '/repo-b' }),
      ])
    );
    flushSolid();
    setShowSessionPicker(false);
    flushSolid();

    cleanup = render(
      () => <SessionListView onPrimarySessionsCountChange={onPrimarySessionsCountChange} />,
      container
    );
    flushSolid();

    const selector = container.querySelector('.session-list-workspace-selector');
    const search = container.querySelector('.session-list-search');
    expect(selector?.nextElementSibling).toBe(search);
    expect(selector?.textContent).toContain('Folder:');
    expect(selector?.textContent).toContain('Workspace');
    expect(selector?.querySelector('.workspace-picker-folder-icon')).toBeNull();
    expect(container.querySelector('.session-history-scope-picker')).toBeNull();
    expect(getScope).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.session-item-folder-meta-icon')).toHaveLength(2);
    expect(onPrimarySessionsCountChange).toHaveBeenLastCalledWith(2);
    expect(
      Array.from(container.querySelectorAll('.session-item-folder')).map(
        (element) => element.textContent
      )
    ).toEqual(['Workspace', 'Repo B']);

    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo-b"]')?.click();
    flushSolid();
    await vi.waitFor(() => expect(getScope).toHaveBeenCalledWith('/repo-b'));
    flushSolid();
    expect(send).toHaveBeenCalledWith({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: expect.any(Number) },
    });
    expect(selector?.textContent).toContain('Repo B');
    expect(showSessionPicker()).toBe(false);
    expect(
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      )
    ).toEqual(['session-2']);
    expect(container.querySelectorAll('.session-item-folder-meta-icon')).toHaveLength(0);
    expect(container.querySelector('.session-item-meta')?.textContent).not.toContain('Repo B');
    expect(container.querySelector('.session-history-scope-trigger')?.textContent).toContain(
      'Project'
    );
    expect(onPrimarySessionsCountChange).toHaveBeenLastCalledWith(1);

    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('.workspace-popover-all')?.click();
    flushSolid();
    setState(storePath('editorContext', 'workspacePath', '/repo-b'));
    flushSolid();
    expect(selector?.textContent).toContain('Workspace');
    expect(container.querySelector('.session-history-scope-picker')).toBeNull();
    expect(getScope).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('.session-item-title-text')).toHaveLength(2);
    expect(onPrimarySessionsCountChange).toHaveBeenLastCalledWith(2);

    send.mockClear();
    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('.workspace-popover-all')?.click();
    flushSolid();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'workspace/select' }));
  });

  it('shows the empty state when the selected folder has no sessions', () => {
    setState(
      storePath('editorContext', {
        workspacePath: '/repo-a',
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setState(storePath('sessions', [session('session-a', 1, { directory: '/repo-a' })]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const selector = container.querySelector('.session-list-workspace-selector');
    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo-b"]')?.click();
    flushSolid();

    expect(container.querySelector('.session-item')).toBeNull();
    expect(container.textContent).toContain('No sessions yet');
  });

  it('opens an Alt-clicked session row in an editor tab', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    container
      .querySelector<HTMLButtonElement>('.session-item-main')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        directory: '/repo',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: undefined,
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('reveals an editor when its session is selected from the sidebar', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState(storePath('editorTabsOpen', true));
    flushSolid();
    setState(storePath('editorSessionIds', ['session-1']));
    flushSolid();
    setState(storePath('openEditorSessionIds', ['session-1']));
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    setState(
      storePath('sessionSelectedModels', {
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      })
    );
    flushSolid();
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        directory: '/repo',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('does not show an unread completion dot for a session visible in an editor tab', () => {
    setState(storePath('sessions', [session('session-1', 500)]));
    flushSolid();
    setState(storePath('lastSeenSessions', { 'session-1': 100 }));
    flushSolid();
    setState(storePath('completedSessionResponses', { 'session-1': 500 }));
    flushSolid();
    setState(storePath('editorTabsOpen', true));
    flushSolid();
    setState(storePath('editorSessionIds', ['session-1']));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.querySelector('.session-item-indicator.is-completed')).toBeNull();
  });

  it('shows an unread completion dot when its open editor tab is not visible', () => {
    setState(storePath('sessions', [session('session-1', 500)]));
    flushSolid();
    setState(storePath('lastSeenSessions', { 'session-1': 100 }));
    flushSolid();
    setState(storePath('completedSessionResponses', { 'session-1': 500 }));
    flushSolid();
    setState(storePath('editorTabsOpen', true));
    flushSolid();
    setState(storePath('editorSessionIds', []));
    flushSolid();
    setState(storePath('openEditorSessionIds', ['session-1']));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.querySelector('.session-item-indicator.is-completed')).not.toBeNull();
  });

  it.each(['build', 'plan'])('shows a red marker for an unread interrupted %s session', (agent) => {
    setState(storePath('sessions', [session('session-1', 500)]));
    flushSolid();
    setState(storePath('lastSeenSessions', { 'session-1': 100 }));
    flushSolid();
    setState(storePath('sessionSelectedAgents', { 'session-1': agent }));
    flushSolid();
    markSessionResponseInterrupted('session-1', 500);
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const marker = container.querySelector('.session-item-indicator.is-failed');
    expect(marker?.getAttribute('aria-label')).toBe('Interrupted');
    expect(container.querySelector('.session-item-indicator.is-completed')).toBeNull();
    expect(container.querySelector('.session-item-indicator.is-plan-completed')).toBeNull();

    markSessionSeen('session-1', 500);
    flushSolid();
    expect(container.querySelector('.session-item-indicator.is-failed')).toBeNull();
  });

  it('replaces an unread interrupted marker with a later completion', () => {
    setState(storePath('sessions', [session('session-1', 500)]));
    flushSolid();
    setState(storePath('lastSeenSessions', { 'session-1': 100 }));
    flushSolid();
    setState(storePath('sessionSelectedAgents', { 'session-1': 'build' }));
    flushSolid();
    markSessionResponseInterrupted('session-1', 500);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    expect(container.querySelector('.session-item-indicator.is-failed')).not.toBeNull();

    markSessionResponseCompleted('session-1', 600);
    flushSolid();

    expect(container.querySelector('.session-item-indicator.is-failed')).toBeNull();
    expect(container.querySelector('.session-item-indicator.is-completed')).not.toBeNull();
  });

  it.each(['busy', 'retry', 'visible-editor'] as const)(
    'does not show an interrupted marker while the session is %s',
    (visibility) => {
      setState(storePath('sessions', [session('session-1', 500)]));
      flushSolid();
      setState(storePath('lastSeenSessions', { 'session-1': 100 }));
      flushSolid();
      markSessionResponseInterrupted('session-1', 500);
      flushSolid();
      if (visibility === 'visible-editor') setState(storePath('editorSessionIds', ['session-1']));
      else
        setState(
          storePath('sessionStatus', {
            'session-1':
              visibility === 'retry'
                ? { type: 'retry', attempt: 1, message: 'Retrying', next: Date.now() + 1_000 }
                : { type: 'busy' },
          })
        );
      flushSolid();

      cleanup = render(() => <SessionListView />, container);
      flushSolid();

      expect(container.querySelector('.session-item-indicator.is-failed')).toBeNull();
    }
  );

  it('shows an unread child interruption on its parent and acknowledges it on parent read', () => {
    setSessions([session('root', 500), session('child', 500, { parentID: 'root' })]);
    flushSolid();
    setState(storePath('sessionStatus', { root: { type: 'idle' }, child: { type: 'idle' } }));
    flushSolid();
    setState(storePath('lastSeenSessions', { root: 100, child: 100 }));
    flushSolid();
    markSessionResponseInterrupted('child', 500);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(
      container.querySelector('.session-item-indicator.is-failed')?.getAttribute('aria-label')
    ).toBe('Interrupted');
    markSessionSeen('root', 500);
    flushSolid();
    expect(container.querySelector('.session-item-indicator.is-failed')).toBeNull();
  });

  it('reveals a hidden editor when its session is selected from the sidebar', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState(storePath('editorTabsOpen', true));
    flushSolid();
    setState(storePath('editorSessionIds', []));
    flushSolid();
    setState(storePath('openEditorSessionIds', ['session-1']));
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-editor',
      payload: {
        sessionId: 'session-1',
        directory: '/repo',
        rootSessionId: 'session-1',
        title: 'session-1',
        model: undefined,
      },
    });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('opens unrelated sessions in the sidebar while another chat editor is open', () => {
    const send = vi.fn((message: TestRuntimeValue) => {
      structuredClone(message);
    });
    // SAFETY: The fixture provides the bridge callback used by postMessage.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setState(storePath('editorTabsOpen', true));
    flushSolid();
    setState(storePath('editorSessionIds', ['other-session']));
    flushSolid();
    setState(storePath('openEditorSessionIds', ['other-session']));
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    vi.mocked(selectSession).mockClear();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();

    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session/open-in-editor' })
    );
    expect(selectSession).toHaveBeenCalledWith('session-1', { directory: '/repo' });
  });

  it('renders hover-only model details and the provider icon in the row', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'very_high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5.6-sol': {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              capabilities: {},
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      const row = container.querySelector('.session-item');
      expect(row?.getAttribute('title')).toBeNull();
      expect(row?.classList.contains('has-model-details')).toBe(true);
      expect(row?.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · GPT-5.6 Sol · Very High'
      );
      const icon = row?.querySelector<HTMLElement>('.session-item-provider-icon');
      expect(icon).not.toBeNull();
      expect(icon?.style.getPropertyValue('--provider-icon-mask')).toContain('url(');
      expect(row?.querySelector('.session-item-provider-name')).toBeNull();
    });
    flushSolid();

    vi.mocked(selectSession).mockClear();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();
    expect(selectSession).toHaveBeenCalledWith('session-1', {
      directory: '/repo',
      selectedModel: {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'very_high',
      },
    });
  });

  it.each([
    { name: 'GPT-6.1 Sol Fast', count: 1, text: 'GPT-6.1 Sol ' },
    { name: 'GPT-6.1 Sol Ultrafast', count: 2, text: 'GPT-6.1 Sol ' },
    { name: 'GPT-6.1 Sol', count: 0, text: 'GPT-6.1 Sol' },
  ])('renders $name with $count speed icons instead of emoji', async ({ name, count, text }) => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-6.1-sol': {
              id: 'gpt-6.1-sol',
              name,
              capabilities: {},
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      const details = container.querySelector('.session-item-model-meta');
      expect(details?.textContent).toBe(` · ${text} · High`);
      expect(details?.textContent).not.toContain('⚡');
      const icons = details?.querySelectorAll<HTMLElement>('.model-speed-icon');
      expect(icons).toHaveLength(count);
      icons?.forEach((icon) => {
        expect(icon.classList).toContain('ui-icon');
        expect(icon.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(flashSolidIcon));
      });
    });
    flushSolid();
  });

  it('shows the provider name when no provider icon is available', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('providers', [
        {
          id: 'local-gateway',
          name: 'Local Gateway',
          source: 'custom',
          models: {
            'claude-sonnet': {
              id: 'claude-sonnet',
              name: 'Claude Sonnet',
              capabilities: {},
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    setState(
      storePath('sessions', [
        session('session-1', Date.now(), {
          model: { providerID: 'local-gateway', id: 'claude-sonnet' },
        }),
      ])
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · Claude Sonnet · Default'
      );
      expect(container.querySelector('.session-item-provider-icon')).toBeNull();
      expect(container.querySelector('.session-item-provider-name')?.textContent).toBe(
        'Local Gateway'
      );
    });
    flushSolid();
  });

  it('shows and opens with the message summary instead of a persisted selection', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5.6-sol': {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              capabilities: {},
              cost: { input: 0, output: 0 },
            },
            'gpt-5.6-luna': {
              id: 'gpt-5.6-luna',
              name: 'GPT-5.6 Luna',
              capabilities: {},
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    setState(
      storePath('sessionSelectedModels', {
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-luna', variant: 'max' },
      })
    );
    flushSolid();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-model-meta')?.textContent).toBe(
        ' · GPT-5.6 Sol · High'
      );
    });
    flushSolid();

    vi.mocked(selectSession).mockClear();
    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();
    expect(selectSession).toHaveBeenCalledWith('session-1', {
      directory: '/repo',
      selectedModel: {
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        variant: 'high',
      },
    });
  });

  it('reveals model details for every row while Alt is held', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('sessions', [
        session('session-1', Date.now()),
        session('session-2', Date.now() - 1),
      ])
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.session-item.has-model-details')).toHaveLength(2);
    });
    flushSolid();
    const list = container.querySelector('.session-list-view')!;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    flushSolid();
    expect(list.classList.contains('show-all-model-details')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushSolid();
    expect(list.classList.contains('show-all-model-details')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    flushSolid();
    expect(list.classList.contains('show-all-model-details')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushSolid();
    window.dispatchEvent(new Event('blur'));
    flushSolid();
    expect(list.classList.contains('show-all-model-details')).toBe(false);
  });
});

describe('SessionListView queued messages', () => {
  it('shows reactive per-session queue counts with the outcome icon', async () => {
    const now = Date.now();
    setState(
      storePath('sessions', [
        session('session-1', now, { summary: { files: 1, additions: 0, deletions: 0 } }),
        session('session-2', now - 1, { summary: { files: 1, additions: 0, deletions: 0 } }),
        session('session-3', now - 2, { summary: { files: 1, additions: 0, deletions: 0 } }),
      ])
    );
    flushSolid();
    setState(
      storePath('queuedMessages', [
        { id: 'queue-1', sessionId: 'session-1', text: 'First follow-up' },
        { id: 'queue-2', sessionId: 'session-1', text: 'Second follow-up' },
        { id: 'queue-3', sessionId: 'session-2', text: 'Other session follow-up' },
      ])
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.session-item'));
    const row = (title: string) =>
      rows().find((item) => item.querySelector('.session-item-title-text')?.textContent === title)!;

    const firstCount = row('session-1').querySelector<HTMLElement>(
      '[aria-label="2 queued messages"]'
    );
    const firstButton = row('session-1').querySelector<HTMLButtonElement>('.session-item-main');
    expect(firstCount?.textContent).toBe('2');
    expect(row('session-1').dataset.sessionId).toBe('session-1');
    expect(firstCount?.dataset.sessionId).toBe('session-1');
    expect(firstCount?.dataset.queuedMessageCount).toBe('2');
    expect(firstCount?.id).toBeTruthy();
    expect(firstButton?.getAttribute('aria-describedby')).toBe(firstCount?.id);
    expect(firstCount?.closest('.session-item-trailing')).not.toBeNull();
    flushSolid();
    expect(
      firstCount
        ?.querySelector<HTMLElement>('.session-item-queued-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(forwardMessageIcon));
    const secondCount = row('session-2').querySelector<HTMLElement>(
      '[aria-label="1 queued message"]'
    );
    expect(secondCount?.textContent).toBe('1');
    expect(
      row('session-2').querySelector('.session-item-main')?.getAttribute('aria-describedby')
    ).toBe(secondCount?.id);
    expect(row('session-3').querySelector('.session-item-queued-counter')).toBeNull();
    expect(
      row('session-3').querySelector('.session-item-main')?.getAttribute('aria-describedby')
    ).toBeNull();

    setState(
      storePath(
        'queuedMessages',
        appState.queuedMessages.filter((item) => item.sessionId !== 'session-1')
      )
    );
    flushSolid();

    await vi.waitFor(() => {
      expect(row('session-1').querySelector('.session-item-queued-counter')).toBeNull();
      expect(row('session-2').querySelector('[aria-label="1 queued message"]')).not.toBeNull();
    });
    flushSolid();
  });
});

describe('SessionListView diff summaries', () => {
  it('does not reread settled row statistics when another summary resolves', async () => {
    const pending = deferred<SessionDiffSummary>();
    let settledTokenReads = 0;
    const settled: SessionDiffSummary = {
      files: 2,
      additions: 6,
      deletions: 4,
      get tokens() {
        settledTokenReads += 1;
        return 900;
      },
      durationMs: 65_000,
      activeStartedAt: null,
    };
    vi.spyOn(client.varro.session, 'diffSummary').mockImplementation((id) =>
      id === 'settled' ? Promise.resolve(settled) : pending.promise
    );
    const now = Date.now();
    setSessions([session('settled', now), session('pending', now - 1)]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const settledRow = container.querySelector('[data-session-id="settled"]');
    const pendingRow = container.querySelector('[data-session-id="pending"]');
    await vi.waitFor(() => expect(settledRow?.textContent).toContain('900 tokens'));
    flushSolid();
    expect(pendingRow?.querySelector('.session-item-meta-skeleton')).not.toBeNull();
    const previousText = settledRow?.textContent;
    settledTokenReads = 0;

    pending.resolve({
      files: 3,
      additions: 10,
      deletions: 2,
      tokens: 1200,
      durationMs: 10_000,
      activeStartedAt: null,
    });
    flushSolid();
    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
    flushSolid();

    expect(settledTokenReads).toBe(0);
    expect(container.querySelector('[data-session-id="settled"]')).toBe(settledRow);
    expect(container.querySelector('[data-session-id="pending"]')).toBe(pendingRow);
    expect(settledRow?.textContent).toBe(previousText);
    expect(pendingRow?.textContent).toContain('3 files');
    expect(pendingRow?.querySelector('.session-item-meta-skeleton')).toBeNull();
  });

  it('shows a skeleton instead of zero counters while the aggregate summary loads', async () => {
    const pending = deferred<{
      files: number;
      additions: number;
      deletions: number;
      tokens: number;
      durationMs: number;
      activeStartedAt: number | null;
    }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta-skeleton')).not.toBeNull();
    });
    flushSolid();
    expect(container.querySelector('.session-item-meta')?.textContent).not.toContain('0 files');

    pending.resolve({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      durationMs: 65_000,
      activeStartedAt: null,
    });
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta-skeleton')).toBeNull();
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('2 files');
    });
    flushSolid();
    expect(container.querySelector('.session-item-cost')).toBeNull();
  });

  it('uses the aggregate session diff response instead of loading full diffs or messages', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 12_345,
      tokenBreakdown: {
        session: {
          total: 100,
          input: 100,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.0074,
        },
        subagents: {
          total: 200,
          input: 200,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.0626,
        },
        subagentCount: 2,
      },
      durationMs: 65_000,
      activeStartedAt: null,
    });
    const diffSpy = vi.spyOn(client.session, 'diff').mockResolvedValue([]);
    const messagesSpy = vi.spyOn(client.session, 'messages').mockResolvedValue([]);
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() =>
      expect(diffSummarySpy).toHaveBeenCalledWith('session-1', expect.any(Number), {
        directory: '/repo',
      })
    );
    flushSolid();
    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('2 files');
    });
    flushSolid();
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('+6');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('-4');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('12k tokens');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('1m 5s');
    const tokenLabel = Array.from(container.querySelectorAll('.session-item-meta span')).find(
      (element) => element.textContent === '12k tokens'
    );
    expect(tokenLabel).toBeDefined();
    expect(tokenLabel?.hasAttribute('title')).toBe(false);
    expect(container.querySelector('[title="1m 5s total time worked"]')).not.toBeNull();
    expect(container.querySelector('.session-item-cost')?.textContent).toBe('$0.07');
    expect(container.querySelector('.session-item-meta')?.textContent).toContain('1m 5s · $0.07');
    expect(diffSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();
  });

  it('compacts large edit counts', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 62,
      additions: 8_190,
      deletions: 32_568,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('62 files');
      expect(meta).toContain('+8190');
      expect(meta).toContain('-33K');
    });
    flushSolid();
  });

  it('labels trimmed file summaries without zero line counts', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      filesTruncated: true,
      historyStatsUnavailable: true,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('Large change set');
      expect(meta).not.toContain('+0');
      expect(meta).not.toContain('-0');
      expect(meta).not.toContain('tokens');
    });
    flushSolid();
  });

  it('uses loaded diff counts when stale edit counts already exist on the session', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 2,
      additions: 6,
      deletions: 4,
      tokens: 900,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('sessions', [
        session('session-1', Date.now(), {
          summary: { files: 1, additions: 3, deletions: 2 },
        }),
      ])
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() =>
      expect(diffSummarySpy).toHaveBeenCalledWith('session-1', expect.any(Number), {
        directory: '/repo',
      })
    );
    flushSolid();
    await vi.waitFor(() => {
      const meta = container.querySelector('.session-item-meta')?.textContent;
      expect(meta).toContain('2 files');
      expect(meta).toContain('+6');
      expect(meta).toContain('-4');
      expect(meta).toContain('900 tokens');
    });
    flushSolid();
  });

  it('updates the duration of a running session every second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    flushSolid();
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 5_000,
      activeStartedAt: 90_000,
    });
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    setState(storePath('sessions', [session('session-1', 100_000)]));
    flushSolid();

    try {
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      await vi.advanceTimersByTimeAsync(0);
      flushSolid();
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('15s');

      await vi.advanceTimersByTimeAsync(2_000);
      flushSolid();
      expect(container.querySelector('.session-item-meta')?.textContent).toContain('17s');
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
      restoreRealTimers();
      flushSolid();
    }
  });

  it('caps and drops queued work when sessions are no longer visible', async () => {
    const pending = deferred<{
      files: number;
      additions: number;
      deletions: number;
      tokens: number;
      durationMs: number;
      activeStartedAt: number | null;
    }>();
    vi.spyOn(client.varro.session, 'diffSummary').mockReturnValue(pending.promise);
    setState(
      storePath(
        'sessions',
        Array.from({ length: 160 }, (_, index) => session(`session-${index}`, Date.now() - index))
      )
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(getSessionDiffSummaryStateForTests().active).toBe(4);
    expect(getSessionDiffSummaryStateForTests().queued).toBeGreaterThan(0);
    expect(getSessionDiffSummaryStateForTests().queued).toBeLessThan(30);

    setState(storePath('sessions', []));
    flushSolid();
    expect(getSessionDiffSummaryStateForTests().queued).toBe(0);

    pending.resolve({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    flushSolid();
    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
    flushSolid();
  });

  it('loads summaries only when rows approach the scroll viewport', async () => {
    const callbacks = new Map<Element, IntersectionObserverCallback>();
    let observerCount = 0;
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {
        observerCount += 1;
      }

      observe(target: Element) {
        callbacks.set(target, this.callback);
      }

      unobserve(target: Element) {
        callbacks.delete(target);
      }

      disconnect() {}
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.IntersectionObserver =
      fixture<typeof IntersectionObserver>(TestIntersectionObserver);
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setState(
      storePath(
        'sessions',
        Array.from({ length: 20 }, (_, index) => session(`viewport-session-${index}`, now - index))
      )
    );
    flushSolid();

    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();
    expect(diffSummarySpy).not.toHaveBeenCalled();

    const rows = Array.from(container.querySelectorAll('.session-item')).slice(0, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => callbacks.has(row))).toBe(true);
    expect(observerCount).toBe(1);
    for (const row of rows) {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      callbacks.get(row)?.(
        [{ target: row, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(3));
    flushSolid();
    await vi.waitFor(() =>
      expect(getSessionDiffSummaryStateForTests()).toMatchObject({ active: 0, queued: 0 })
    );
    flushSolid();
  });

  it('bounds cached summaries across changing visible session sets', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    for (let batch = 0; batch < 3; batch += 1) {
      setState(
        storePath(
          'sessions',
          Array.from({ length: 90 }, (_, index) =>
            session(`batch-${batch}-session-${index}`, Date.now() - index)
          )
        )
      );
      flushSolid();
      await vi.waitFor(
        () => {
          const state = getSessionDiffSummaryStateForTests();
          expect(state.active).toBe(0);
          expect(state.queued).toBe(0);
        },
        { timeout: 5_000 }
      );
      flushSolid();
    }

    const state = getSessionDiffSummaryStateForTests();
    expect(state.cached).toBe(state.cacheLimit);
  });

  it('settles failures for a revision instead of immediately retrying', async () => {
    const diffSummarySpy = vi
      .spyOn(client.varro.session, 'diffSummary')
      .mockRejectedValue(new Error('server unavailable'));
    const updated = Date.now();
    setState(storePath('sessions', [session('session-1', updated)]));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => expect(getSessionDiffSummaryStateForTests().active).toBe(0));
    flushSolid();
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState(storePath('sessions', [session('session-1', updated)]));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(diffSummarySpy).toHaveBeenCalledTimes(1);

    setState(storePath('sessions', [session('session-1', updated + 1)]));
    flushSolid();
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
    flushSolid();
  });

  it('refreshes a root summary when a descendant session updates', async () => {
    const diffSummarySpy = vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 100,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_000, { parentID: 'session-1' }),
    ]);
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(1));
    flushSolid();

    setSessions([
      session('session-1', 100_000),
      session('child-1', 100_001, {
        parentID: 'session-1',
        tokens: {
          input: 200,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ]);
    flushSolid();

    await vi.waitFor(() => expect(diffSummarySpy).toHaveBeenCalledTimes(2));
    flushSolid();
    expect(diffSummarySpy).toHaveBeenNthCalledWith(2, 'session-1', 100_001, {
      directory: '/repo',
    });
  });
});

describe('SessionListView pins', () => {
  it('does not show a reorder handle for the only pinned session', () => {
    const now = Date.now();
    setState(storePath('sessions', [session('pinned', now), session('unpinned', now - 1_000)]));
    flushSolid();
    setState(storePath('pinnedSessionIds', ['pinned']));
    flushSolid();
    setState(
      storePath('sessionStatus', {
        pinned: { type: 'busy', background: true },
        unpinned: { type: 'busy', background: true },
      })
    );
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const pinnedRow = container.querySelector<HTMLElement>('[data-session-id="pinned"]');
    expect(pinnedRow?.querySelector('.session-item-drag-handle')).toBeNull();
    expect(pinnedRow?.querySelector('.session-item-leading.has-status')).not.toBeNull();
    expect(container.querySelector('.session-item-leading.can-reorder')).toBeNull();
  });

  it('keeps a non-blocking service counter visible in the sessions list while the session is idle', () => {
    setState(storePath('sessions', [session('server', Date.now())]));
    flushSolid();
    setState(storePath('sessionStatus', { server: { type: 'idle', backgroundServices: 1 } }));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const badge = container.querySelector('.session-item-background-services');
    expect(badge?.getAttribute('aria-label')).toBe('1 running background service');
    expect(badge?.querySelector('.session-item-subagents-count')?.textContent).toBe('1');
    setState(storePath('sessionStatus', { server: { type: 'idle' } }));
    flushSolid();
    expect(container.querySelector('.session-item-background-services')).toBeNull();
  });

  it('pins and unpins a session from its row menu and marks it', async () => {
    const setPinned = vi
      .spyOn(client.varro.session, 'setPinned')
      .mockResolvedValueOnce(['session-1'])
      .mockResolvedValueOnce([]);
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const row = () => container.querySelector<HTMLElement>('.session-item')!;
    expect(row().querySelector('.session-item-pin')).toBeNull();
    expect(row().querySelector('.session-item-archive')).toBeNull();

    expect(row().querySelector('[aria-label="Session actions"]')).toBeNull();
    openSessionActions(row());
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Pin session')!
      .click();
    flushSolid();

    await vi.waitFor(() =>
      expect(setPinned).toHaveBeenCalledWith('session-1', true, { directory: '/repo' })
    );
    flushSolid();
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(true);
      const pinnedIcon = row().querySelector<HTMLElement>('.session-item-pinned-icon');
      expect(pinnedIcon?.classList).toContain('ui-icon');
      expect(pinnedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    });
    flushSolid();
    openSessionActions(row());
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Unpin session')!
      .click();
    flushSolid();

    await vi.waitFor(() =>
      expect(setPinned).toHaveBeenLastCalledWith('session-1', false, { directory: '/repo' })
    );
    flushSolid();
    await vi.waitFor(() => {
      expect(row().classList.contains('is-pinned')).toBe(false);
      expect(row().querySelector('[aria-label="Pinned session"]')).toBeNull();
    });
    flushSolid();
  });

  it('separates the pinned group from the first unpinned session', () => {
    const now = Date.now();
    setState(
      storePath('sessions', [
        session('unpinned', now),
        session('pinned-newer', now - 1_000),
        session('pinned-older', now - 2_000),
      ])
    );
    flushSolid();
    setState(storePath('pinnedSessionIds', ['pinned-newer', 'pinned-older']));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.session-item'));
    expect(rows.map((row) => row.querySelector('.session-item-title-text')?.textContent)).toEqual([
      'pinned-newer',
      'pinned-older',
      'unpinned',
    ]);
    expect(rows.filter((row) => row.classList.contains('starts-unpinned-group'))).toEqual([
      rows[2],
    ]);
  });

  it('renders persisted pin order and reorders pinned sessions by drag and drop', async () => {
    const reorderPinned = vi
      .spyOn(client.varro.session, 'reorderPinned')
      .mockResolvedValue(['pinned-newer', 'pinned-older']);
    const now = Date.now();
    setState(
      storePath('sessions', [
        session('pinned-newer', now),
        session('pinned-older', now - 1_000),
        session('unpinned', now + 1_000),
      ])
    );
    flushSolid();
    setState(storePath('pinnedSessionIds', ['pinned-older', 'pinned-newer']));
    flushSolid();
    setState(storePath('sessionStatus', { 'pinned-newer': { type: 'busy' } }));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.session-item'));
    expect(rows().map((row) => row.dataset.sessionId)).toEqual([
      'pinned-older',
      'pinned-newer',
      'unpinned',
    ]);
    const handles = container.querySelectorAll<HTMLElement>('.session-item-drag-handle');
    expect(handles).toHaveLength(2);
    expect(container.querySelectorAll('.session-item-leading.can-reorder')).toHaveLength(2);
    expect(
      container.querySelector('[data-session-id="unpinned"] .session-item-leading.can-reorder')
    ).toBeNull();
    expect(rows()[0]?.querySelector('.session-item-leading.has-status')).toBeNull();
    expect(
      rows()[0]?.querySelector('.session-item-leading > .session-item-drag-handle')
    ).not.toBeNull();
    expect(
      rows()[1]?.querySelector('.session-item-leading.has-status > .session-status-indicator')
    ).not.toBeNull();
    expect(
      rows()[1]?.querySelector('.session-item-leading.has-status > .session-item-drag-handle')
    ).not.toBeNull();

    const dataTransfer = createDragDataTransfer();
    dispatchDragEvent(handles[0]!, 'dragstart', dataTransfer);
    flushSolid();
    dispatchDragEvent(rows()[1]!, 'dragover', dataTransfer);
    flushSolid();
    expect(rows()[0]?.classList.contains('is-dragging-pinned')).toBe(true);
    expect(rows()[1]?.classList.contains('is-drag-over-pinned')).toBe(true);
    dispatchDragEvent(rows()[1]!, 'drop', dataTransfer);
    flushSolid();

    await vi.waitFor(() =>
      expect(reorderPinned).toHaveBeenCalledWith('pinned-older', 'pinned-newer', {
        directory: '/repo',
        targetDirectory: '/repo',
      })
    );
    flushSolid();
    await vi.waitFor(() =>
      expect(rows().map((row) => row.dataset.sessionId)).toEqual([
        'pinned-newer',
        'pinned-older',
        'unpinned',
      ])
    );
    flushSolid();
  });

  it('supports keyboard pin reordering and restores order after a failed write', async () => {
    const reorderPinned = vi
      .spyOn(client.varro.session, 'reorderPinned')
      .mockRejectedValue(new Error('write failed'));
    const now = Date.now();
    setState(storePath('sessions', [session('first', now), session('second', now - 1_000)]));
    flushSolid();
    setState(storePath('pinnedSessionIds', ['first', 'second']));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    container
      .querySelector<HTMLButtonElement>('[aria-label="Reorder pinned session: first"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    flushSolid();

    await vi.waitFor(() =>
      expect(reorderPinned).toHaveBeenCalledWith('first', 'second', {
        directory: '/repo',
        targetDirectory: '/repo',
      })
    );
    flushSolid();
    await vi.waitFor(() => expect(error()).toBe('write failed'));
    flushSolid();
    expect(appState.pinnedSessionIds).toEqual(['first', 'second']);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.session-item')).map(
        (row) => row.dataset.sessionId
      )
    ).toEqual(['first', 'second']);
  });
});

describe('SessionListView selection', () => {
  it('does not steal focus after pointer interaction during mount', () => {
    let focusCallback: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        focusCallback = callback;
        return 42;
      });
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const sessionButton = container.querySelector<HTMLButtonElement>('.session-item-main')!;
    sessionButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSolid();
    sessionButton.focus();
    flushSolid();
    focusCallback?.(performance.now());
    flushSolid();

    expect(document.activeElement).toBe(sessionButton);
    expect(requestFrame).toHaveBeenCalledOnce();
    cleanup();
    flushSolid();
    cleanup = undefined;
    expect(cancelFrame).toHaveBeenCalledWith(42);
  });

  it('does not highlight the active session in the session picker', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.querySelector('.session-item')?.classList.contains('active')).toBe(false);
    expect(container.querySelector('.session-item-main')?.getAttribute('aria-current')).toBeNull();
  });

  it('highlights the active session in the embedded desktop list', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setState(
      storePath('sessions', [
        session('session-1', Date.now()),
        session('session-2', Date.now() - 1),
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();

    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();

    const items = container.querySelectorAll('.session-item');
    expect(items[0]?.classList.contains('active')).toBe(true);
    expect(items[0]?.querySelector('.session-item-main')?.getAttribute('aria-current')).toBe(
      'page'
    );
    expect(items[1]?.classList.contains('active')).toBe(false);
    expect(items[1]?.querySelector('.session-item-main')?.getAttribute('aria-current')).toBeNull();
  });

  it('reports an active session reselect without reloading it', () => {
    vi.mocked(selectSession).mockClear();
    const onActiveSessionReselect = vi.fn();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    cleanup = render(
      () => <SessionListView embedded onActiveSessionReselect={onActiveSessionReselect} />,
      container
    );
    flushSolid();

    container.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();

    expect(selectSession).not.toHaveBeenCalled();
    expect(onActiveSessionReselect).toHaveBeenCalledOnce();
  });

  it('navigates, wraps, scrolls, and selects sessions with the keyboard', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    setState(
      storePath('sessions', [
        session('session-1', Date.now()),
        session('session-2', Date.now() - 1),
      ])
    );
    flushSolid();

    try {
      cleanup = render(() => <SessionListView embedded />, container);
      flushSolid();
      const list = container.querySelector<HTMLElement>('.session-list-view')!;
      const items = Array.from(container.querySelectorAll<HTMLElement>('.session-item'));

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      flushSolid();
      await Promise.resolve();
      flushSolid();
      expect(items[0]?.classList.contains('keyboard-focus')).toBe(true);

      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      flushSolid();
      expect(selectSession).toHaveBeenCalledWith('session-1', { directory: '/repo' });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('synchronizes keyboard selection when a session receives focus', () => {
    setState(
      storePath('sessions', [
        session('session-1', Date.now()),
        session('session-2', Date.now() - 1),
      ])
    );
    flushSolid();
    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();

    const buttons = container.querySelectorAll<HTMLButtonElement>('.session-item-main');
    buttons[1]!.focus();
    flushSolid();

    expect(
      container.querySelectorAll('.session-item')[1]?.classList.contains('keyboard-focus')
    ).toBe(true);
  });

  it('does not let stationary hover override keyboard selection after a refresh', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const now = Date.now();
    setState(storePath('sessions', [session('session-1', now), session('session-2', now - 1)]));
    flushSolid();

    try {
      cleanup = render(() => <SessionListView embedded />, container);
      flushSolid();

      const list = container.querySelector<HTMLElement>('.session-list-view')!;
      let items = container.querySelectorAll<HTMLElement>('.session-item');
      items[0]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      flushSolid();
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      flushSolid();
      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);

      setState(
        storePath('sessions', [session('session-1', now + 1), session('session-2', now - 1)])
      );
      flushSolid();
      await Promise.resolve();
      flushSolid();
      items = container.querySelectorAll<HTMLElement>('.session-item');
      items[0]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      flushSolid();

      expect(items[1]?.classList.contains('keyboard-focus')).toBe(true);
      items[0]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      flushSolid();
      expect(items[0]?.classList.contains('keyboard-focus')).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('clears pointer focus when the pointer leaves a session', () => {
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();

    const item = container.querySelector<HTMLElement>('.session-item')!;
    item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    flushSolid();
    expect(item.classList.contains('keyboard-focus')).toBe(true);

    item.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(item.classList.contains('keyboard-focus')).toBe(false);
  });

  it('selects a session from the trailing row area', () => {
    vi.mocked(selectSession).mockClear();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();

    container.querySelector<HTMLElement>('.session-item-age')!.click();
    flushSolid();

    expect(selectSession).toHaveBeenCalledWith('session-1', { directory: '/repo' });
  });

  it('opens desktop sessions on pointer down without double-selecting on click', () => {
    vi.mocked(selectSession).mockClear();
    setState(storePath('sessions', [session('session-1', Date.now())]));
    flushSolid();
    cleanup = render(() => <SessionListView embedded />, container);
    flushSolid();
    const row = container.querySelector<HTMLElement>('.session-item')!;
    const capturePointer = vi.fn();
    row.setPointerCapture = capturePointer;

    row.querySelector<HTMLElement>('.session-item-main')!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 7,
        pointerType: 'mouse',
      })
    );
    flushSolid();
    expect(capturePointer).toHaveBeenCalledWith(7);
    expect(selectSession).toHaveBeenCalledWith('session-1', { directory: '/repo' });

    row.querySelector<HTMLElement>('.session-item-main')!.click();
    flushSolid();
    expect(selectSession).toHaveBeenCalledTimes(1);

    const trailingControl = document.createElement('button');
    row.append(trailingControl);
    trailingControl.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 8 })
    );
    flushSolid();
    expect(capturePointer).toHaveBeenCalledTimes(1);
    expect(selectSession).toHaveBeenCalledTimes(1);
  });

  it('opens picker sessions on pointer down without starting text selection', () => {
    vi.mocked(selectSession).mockClear();
    const now = Date.now();
    setState(storePath('sessions', [session('session-1', now), session('session-2', now - 1)]));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    const row = container.querySelector<HTMLElement>('.session-item')!;

    const pointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 7,
      pointerType: 'mouse',
    });
    row.querySelector<HTMLElement>('.session-item-main')!.dispatchEvent(pointerDown);
    flushSolid();

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(selectSession).toHaveBeenCalledWith('session-1', { directory: '/repo' });
    setState(storePath('sessions', [session('session-2', now + 1), session('session-1', now)]));
    flushSolid();
    row.querySelector<HTMLElement>('.session-item-main')!.click();
    flushSolid();
    expect(selectSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionListView ordering', () => {
  it('keeps the spinner when a completion dot briefly returns to running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    flushSolid();
    setState(storePath('sessions', [session('session-1', 500)]));
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    setState(storePath('completedSessionResponses', { 'session-1': 10_000 }));
    flushSolid();

    try {
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1200);
      flushSolid();
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      setState(storePath('sessionStatus', 'session-1', { type: 'idle' }));
      flushSolid();
      await vi.advanceTimersByTimeAsync(1199);
      flushSolid();
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-running')
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      expect(
        container.querySelector('.session-item-indicator')?.classList.contains('is-completed')
      ).toBe(true);
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
      restoreRealTimers();
      flushSolid();
    }
  });

  it('preserves a running indicator across same-session updates', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now)]);
    flushSolid();
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const indicator = container.querySelector('.session-item-indicator.is-running');
    expect(indicator).not.toBeNull();

    setSessions([session('session-1', now + 1, { title: 'Updated title' })]);
    flushSolid();

    expect(container.querySelector('.session-item-indicator.is-running')).toBe(indicator);
  });

  it('keeps similarly updated sessions in newest-created-first order', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([
      session('older-created', now - 1_000, {
        time: { created: now - 50_000, updated: now - 1_000 },
      }),
      session('newer-created', now - 20_000, {
        time: { created: now - 30_000, updated: now - 20_000 },
      }),
    ]);
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      )
    ).toEqual(['newer-created', 'older-created']);
  });
});

describe('SessionListView actions', () => {
  it('hides rename and recycle-bin actions for sub-agent sessions', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([session('parent', 2), session('child', 1, { parentID: 'parent' })]);
    flushSolid();

    cleanup = render(() => <SessionListView subagentParentId="parent" />, container);
    flushSolid();
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();

    const menu = document.querySelector<HTMLElement>('[aria-label="Session actions"]');
    expect(menu?.textContent).not.toContain('Rename');
    expect(menu?.textContent).not.toContain('Move to Recycle Bin');
    expect(menu?.textContent).toContain('Copy session ID');
    expect(menu?.textContent).toContain('Open in Editor');
    expect(menu?.textContent).toContain('Open in Terminal');
    expect(menu?.textContent).not.toContain('Share session');
  });

  it('opens a session in a terminal from its row menu', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    setSessions([session('session-1', Date.now())]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open in Terminal')!
      .click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-opencode',
      payload: { sessionId: 'session-1', directory: '/repo' },
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens a session in the sidebar from its row menu', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
      send;
    setSessions([session('session-1', Date.now())]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Open')!
      .click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'session/open-in-sidebar',
      payload: { sessionId: 'session-1', directory: '/repo' },
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it.each(['Open in Editor', 'Open in Window'])(
    'opens a session using %s from its row menu',
    (label) => {
      const send = vi.fn((message: TestRuntimeValue) => {
        structuredClone(message);
      });
      // SAFETY: The fixture provides the unknown fields read by this statement.
      (window as { __sendToExtension?: (message: TestRuntimeValue) => void }).__sendToExtension =
        send;
      vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
        files: 0,
        additions: 0,
        deletions: 0,
        tokens: 0,
        durationMs: 0,
        activeStartedAt: null,
      });
      setSessions([session('session-1', Date.now())]);
      flushSolid();
      setState(
        storePath('sessionSelectedModels', {
          'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
        })
      );
      flushSolid();
      cleanup = render(() => <SessionListView />, container);
      flushSolid();

      openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
      flushSolid();
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent?.trim() === label)!
        .click();
      flushSolid();

      expect(send).toHaveBeenCalledWith({
        type: 'session/open-in-editor',
        payload: {
          sessionId: 'session-1',
          directory: '/repo',
          title: 'session-1',
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
          inWindow: label === 'Open in Window' || undefined,
        },
      });
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
  );

  it('clears an existing v1 share link and copies the session ID from its row menu', async () => {
    const activityUpdatedAt = Date.now() - 60_000;
    const shareUpdatedAt = Date.now();
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const unshareResult = session('session-1', shareUpdatedAt + 1, {
      share: { url: 'https://share.test/1' },
    });
    const pendingUnshare = deferred<Session>();
    const unshare = vi.spyOn(client.session, 'unshare').mockReturnValue(pendingUnshare.promise);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    setState(
      storePath('sessions', [
        session('session-1', activityUpdatedAt, { share: { url: 'https://share.test/1' } }),
      ])
    );
    flushSolid();

    try {
      cleanup = render(
        () => (
          <>
            <SessionListView />
            <SessionActionFeedback />
          </>
        ),
        container
      );
      flushSolid();
      const row = container.querySelector<HTMLElement>('.session-item')!;

      expect(row.querySelector('.session-item-shared-marker')?.getAttribute('title')).toBe(
        'Session is shared'
      );
      const sharedIcon = row.querySelector<HTMLElement>('.shared-session-icon');
      expect(sharedIcon?.classList).toContain('ui-icon');
      expect(sharedIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');

      openSessionActions(row);
      flushSolid();
      const sharedActions = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      sharedActions.find((button) => button.textContent?.trim() === 'Unshare session')!.click();
      flushSolid();

      expect(document.querySelector('[role="menu"]')).toBeNull();
      await vi.waitFor(() =>
        expect(unshare).toHaveBeenCalledWith('session-1', { directory: '/repo' })
      );
      flushSolid();
      const inFlightEvent = applySessionShareOverride({
        ...unshareResult,
        share: undefined,
      });
      flushSolid();
      expect(inFlightEvent.time.updated).toBe(activityUpdatedAt);

      pendingUnshare.resolve(unshareResult);
      flushSolid();
      await vi.waitFor(() => {
        const feedback = document.querySelector<HTMLElement>('.session-action-feedback');
        expect(feedback?.textContent?.trim()).toBe('Session unshared');
        expect(feedback?.getAttribute('aria-live')).toBe('polite');
        expect(feedback?.querySelector('.session-action-feedback-glyph')?.classList).toContain(
          'ui-icon'
        );
      });
      flushSolid();
      expect(appState.sessions[0]?.time.updated).toBe(activityUpdatedAt);
      expect(row.querySelector('.session-item-shared-marker')).toBeNull();
      openSessionActions(row);
      flushSolid();
      const unsharedActions = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      );
      expect(unsharedActions.some((button) => button.textContent?.trim() === 'Share session')).toBe(
        false
      );
      expect(
        unsharedActions.some((button) => button.textContent?.trim() === 'Unshare session')
      ).toBe(false);
      unsharedActions.find((button) => button.textContent?.trim() === 'Copy session ID')!.click();
      flushSolid();
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('session-1'));
      flushSolid();
      await vi.waitFor(() => {
        expect(document.querySelector('.session-action-feedback')?.textContent?.trim()).toBe(
          'Session ID copied'
        );
      });
      flushSolid();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
        flushSolid();
      }
      flushSolid();
    }
  });

  it('closes the context menu without selecting another session with one click', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState(
      storePath('sessions', [session('session-1', updated), session('session-2', updated - 1)])
    );
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    const owningRow = rows[0]!;
    const otherRow = rows[1]!;
    vi.mocked(selectSession).mockClear();
    openSessionActions(owningRow);
    flushSolid();

    expect(owningRow.classList.contains('is-context-selected')).toBe(true);
    expect(otherRow.classList.contains('is-context-obscured')).toBe(true);
    expect(owningRow.hasAttribute('inert')).toBe(true);
    expect(otherRow.hasAttribute('inert')).toBe(true);

    otherRow.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    flushSolid();
    expect(otherRow.classList.contains('keyboard-focus')).toBe(false);

    otherRow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    flushSolid();
    otherRow.querySelector<HTMLButtonElement>('.session-item-main')!.click();
    flushSolid();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(otherRow.classList.contains('is-context-obscured')).toBe(false);
    expect(otherRow.hasAttribute('inert')).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('freezes session row order until the context menu closes', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    setSessions([session('session-1', updated), session('session-2', updated + 1)]);
    flushSolid();

    const rowTitles = () =>
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      );
    expect(rowTitles()).toEqual(['session-1', 'session-2']);

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    flushSolid();

    expect(rowTitles()).toEqual(['session-2', 'session-1']);
  });

  it('keeps the context menu and owning row selected across session list updates', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();

    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);
    flushSolid();

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('keeps an in-progress rename across session list updates', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('.session-list-search-input')
      )
    );
    flushSolid();

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    input.value = 'Draft rename';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();
    input.focus();
    flushSolid();
    input.setSelectionRange(5, 5);
    flushSolid();
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    flushSolid();

    const unrelatedMutation = document.createElement('div');
    document.body.append(unrelatedMutation);
    await Promise.resolve();
    flushSolid();
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
    unrelatedMutation.remove();
    flushSolid();

    setSessions([
      session('session-1', now + 1, { title: 'Updated session' }),
      session('archived-session', now - 2 * 24 * 60 * 60 * 1_000),
    ]);
    flushSolid();

    await vi.waitFor(() => {
      const updatedInput = document.querySelector<HTMLInputElement>('[id^="session-rename-"]');
      expect(updatedInput?.value).toBe('Draft rename');
      expect(document.activeElement).toBe(updatedInput);
      expect(updatedInput?.selectionStart).toBe(5);
      expect(updatedInput?.selectionEnd).toBe(5);
    });
    flushSolid();
    expect(
      container.querySelector('.session-item')?.classList.contains('is-context-selected')
    ).toBe(true);
  });

  it('does not override repeated caret placement while renaming', async () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const now = Date.now();
    setSessions([session('session-1', now, { title: 'First session' })]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
    const setSelectionRange = vi.spyOn(input, 'setSelectionRange');

    input.setSelectionRange(3, 3);
    flushSolid();
    setSelectionRange.mockClear();
    input.dispatchEvent(new Event('select', { bubbles: true }));
    flushSolid();
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    flushSolid();

    input.setSelectionRange(8, 8);
    flushSolid();
    setSelectionRange.mockClear();
    input.dispatchEvent(new Event('select', { bubbles: true }));
    flushSolid();
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(setSelectionRange).not.toHaveBeenCalled();
    expect(input.selectionStart).toBe(8);
    expect(input.selectionEnd).toBe(8);
  });

  it('closes the context menu when rename is cancelled', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setSessions([session('session-1', updated), session('session-2', updated - 1)]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const rows = container.querySelectorAll<HTMLElement>('.session-item');
    openSessionActions(rows[0]!);
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.trim() === 'Rename')!
      .click();
    flushSolid();
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!
      .click();
    flushSolid();

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('.session-item-actions-backdrop')).toBeNull();
    expect(rows[0]!.classList.contains('is-context-selected')).toBe(false);
    expect(rows[1]!.classList.contains('is-context-obscured')).toBe(false);
  });

  it('disables Rename for a read-only moved link without opening the form', () => {
    setSessions([
      session('moved', Date.now(), {
        directory: '/outside',
        transfer: { originDirectory: '/repo', available: false },
      }),
    ]);
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
    flushSolid();

    const rename = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.trim() === 'Rename')!;
    expect(rename.disabled).toBe(true);
    expect(rename.title).toBe('Open the destination folder to rename this moved conversation');
    rename.click();
    flushSolid();

    expect(document.querySelector('.session-item-rename-form')).toBeNull();
    expect(renameSessionMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'renames a writable session from its row menu, moved=%s',
    async (moved) => {
      vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
        files: 0,
        additions: 0,
        deletions: 0,
        tokens: 0,
        durationMs: 0,
        activeStartedAt: null,
      });
      setSessions([
        session('session-1', Date.now(), {
          transfer: moved ? { originDirectory: '/other', available: true } : undefined,
        }),
      ]);
      flushSolid();
      cleanup = render(() => <SessionListView />, container);
      flushSolid();

      openSessionActions(container.querySelector<HTMLElement>('.session-item')!);
      flushSolid();
      const rename = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((button) => button.textContent?.trim() === 'Rename')!;
      expect(rename.disabled).toBe(false);
      expect(rename.hasAttribute('title')).toBe(false);
      rename.click();
      flushSolid();

      const input = document.querySelector<HTMLInputElement>('[id^="session-rename-"]')!;
      input.value = '  Better title  ';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
      input.closest('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));
      flushSolid();

      await vi.waitFor(() => {
        expect(renameSessionMock).toHaveBeenCalledWith('session-1', 'Better title');
      });
      flushSolid();
      await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
      flushSolid();
    }
  );

  it('opens the row menu at the right-click position without an actions button', () => {
    vi.spyOn(client.varro.session, 'diffSummary').mockResolvedValue({
      files: 0,
      additions: 0,
      deletions: 0,
      tokens: 0,
      durationMs: 0,
      activeStartedAt: null,
    });
    const updated = Date.now();
    setState(
      storePath('sessions', [
        session('parent', updated),
        session('child', updated - 1, { parentID: 'parent' }),
      ])
    );
    flushSolid();
    cleanup = render(() => <SessionListView onOpenSubagents={vi.fn()} />, container);
    flushSolid();

    const row = container.querySelector<HTMLElement>('.session-item')!;
    expect(row.querySelector('.session-item-actions-trigger')).toBeNull();

    openSessionActions(row, 72, 84);
    flushSolid();

    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.left).toBe('72px');
    expect(menu.style.top).toBe('84px');
  });
});

describe('SessionListView load errors', () => {
  it('shows the bottom separator only for secondary groups or overflowing sessions', async () => {
    const now = Date.now();
    setState(storePath('sessions', [session('recent', now)]));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const list = container.querySelector<HTMLElement>('.session-list-view')!;
    const scroll = container.querySelector<HTMLElement>('.session-list-scroll')!;
    expect(list.classList).not.toContain('has-bottom-separator');

    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 101 },
    });
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(list.classList).toContain('has-bottom-separator');

    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 100 });
    window.dispatchEvent(new Event('resize'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(list.classList).not.toContain('has-bottom-separator');

    setState(
      storePath('sessions', [
        ...Array.from({ length: 50 }, (_, index) => session(`recent-${index}`, now - index)),
        session('archived', now - 2 * 86_400_000),
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(list.classList).toContain('has-bottom-separator');
  });

  it('loads an archive session instead of showing an unknown zero count', async () => {
    const now = Date.now();
    const recent = Array.from({ length: 50 }, (_, index) =>
      session(`recent-${index}`, now - index)
    );
    const archived = session('archived', now - 2 * 86_400_000);
    loadMoreSessionsMock.mockImplementationOnce(async () => {
      setState(storePath('sessions', [...recent, archived]));
      setState(storePath('sessionsHasMore', false));
    });
    setState(storePath('sessions', recent));
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.textContent).not.toContain('0+');
    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    flushSolid();
    await vi.waitFor(() => {
      const archive = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
      ).find((button) => button.textContent?.includes('Archive'));
      expect(archive?.textContent).toContain('1');
    });
    flushSolid();
  });

  it('offers continuation when the loaded page has no visible sessions', () => {
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.textContent).not.toContain('No sessions yet');
    expect(container.querySelector('.session-list-continuation')).not.toBeNull();
    expect(container.textContent).not.toContain('Load more');
  });

  it('observes a continuation sentinel that appears after mount and disconnects on disposal', async () => {
    const observed = new Map<Element, IntersectionObserverCallback>();
    const disconnect = vi.fn();
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observed.set(target, this.callback);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        disconnect();
        observed.clear();
      }
    }
    globalThis.IntersectionObserver =
      fixture<typeof IntersectionObserver>(TestIntersectionObserver);

    cleanup = render(() => <SessionListView />, container);
    flushSolid();
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    await Promise.resolve();
    flushSolid();

    setState(storePath('sessionsHasMore', true));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const continuation = container.querySelector('.session-list-continuation')!;
    expect(observed.has(continuation)).toBe(true);
    loadMoreSessionsMock.mockClear();
    // SAFETY: The callback fixture supplies the browser entry and observer shapes used by this test.
    observed.get(continuation)?.(
      [{ target: continuation, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    flushSolid();

    setState(storePath('sessionsHasMore', false));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observed.size).toBe(0);

    setState(storePath('sessionsHasMore', true));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(observed.has(container.querySelector('.session-list-continuation')!)).toBe(true);

    cleanup();
    flushSolid();
    cleanup = undefined;
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('does not paginate beyond recent sessions for a status filter', () => {
    setState(storePath('sessions', [session('running', Date.now())]));
    flushSolid();
    setState(storePath('sessionStatus', { running: { type: 'busy' } }));
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();

    cleanup = render(() => <SessionListView sessionFilter="running" />, container);
    flushSolid();

    expect(container.querySelector('.session-item-title-text')?.textContent).toBe('running');
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();
  });

  it('shows a lower-bound archive count and loads another session window', async () => {
    const callbacks = new Map<Element, IntersectionObserverCallback>();
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        callbacks.set(target, this.callback);
      }
      unobserve(target: Element) {
        callbacks.delete(target);
      }
      disconnect() {}
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.IntersectionObserver =
      fixture<typeof IntersectionObserver>(TestIntersectionObserver);
    const now = Date.now();
    const archivedSessions = Array.from({ length: 50 }, (_, index) =>
      session(`archived-${index}`, now - (index + 2) * 86_400_000)
    );
    setState(
      storePath('sessions', [
        ...Array.from({ length: 50 }, (_, index) => session(`recent-${index}`, now - index)),
        ...archivedSessions,
      ])
    );
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const archive = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
    ).find((button) => button.textContent?.includes('Archive'));
    expect(archive?.textContent).toContain('50+');
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();

    archive!.click();
    flushSolid();
    const continuation = container.querySelector('.session-list-continuation')!;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    callbacks.get(continuation)?.(
      [{ target: continuation, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    flushSolid();
  });

  it('loads another session window by default while Archive has fewer than 50 sessions', async () => {
    const now = Date.now();
    setState(
      storePath('sessions', [session('recent', now), session('archived', now - 2 * 86_400_000)])
    );
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();

    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    flushSolid();
  });

  it('searches all sessions without adding search-only sessions to the archive', async () => {
    const now = Date.now();
    const loadedSessions = [
      ...Array.from({ length: 50 }, (_, index) => session(`recent-${index}`, now - index)),
      session('archived', now - 2 * 86_400_000),
    ];
    const searchOnlySession = session('deep-archive', now - 30 * 86_400_000, {
      title: 'Flick through old notes',
    });
    vi.spyOn(client.session, 'list').mockResolvedValueOnce({
      items: [searchOnlySession],
      hasMore: false,
    });
    setState(storePath('sessions', loadedSessions));
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    await vi.waitFor(() => expect(loadMoreSessionsMock).toHaveBeenCalledOnce());
    flushSolid();

    const getArchive = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('.session-list-section-toggle')
      ).find((button) => button.textContent?.includes('Archive'))!;
    expect(getArchive().textContent).toContain('1+');
    getArchive().click();
    flushSolid();

    const search = container.querySelector<HTMLInputElement>('.session-list-search-input')!;
    search.value = '  flick  ';
    search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSolid();

    await vi.waitFor(() => {
      expect(container.querySelector('.session-item-title-text')?.textContent).toBe(
        'Flick through old notes'
      );
    });
    flushSolid();
    expect(client.session.list).toHaveBeenCalledOnce();
    expect(client.session.list).toHaveBeenCalledWith({
      limit: 30,
      search: 'flick',
      roots: true,
      signal: expect.any(AbortSignal),
    });
    expect(loadMoreSessionsMock).toHaveBeenCalledOnce();
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(appState.sessions).toEqual(loadedSessions);

    const clearIcon = container.querySelector<HTMLElement>('.session-list-search-clear-icon');
    expect(clearIcon?.classList).toContain('ui-icon');
    expect(clearIcon?.style.getPropertyValue('--ui-icon-width')).toBe('10px');
    container.querySelector<HTMLButtonElement>('.session-list-search-clear')!.click();
    flushSolid();

    expect(container.textContent).not.toContain('Flick through old notes');
    expect(getArchive().textContent).toContain('1+');
    expect(appState.sessions).toEqual(loadedSessions);
  });

  it('debounces search, aborts immediately, and ignores stale responses', async () => {
    vi.useFakeTimers();
    const first = deferred<{ items: Session[]; hasMore: false }>();
    const second = deferred<{ items: Session[]; hasMore: false }>();
    const list = vi
      .spyOn(client.session, 'list')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    try {
      cleanup = render(() => <SessionListView />, container);
      flushSolid();
      const search = container.querySelector<HTMLInputElement>('.session-list-search-input')!;
      search.value = 'first';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();

      await vi.advanceTimersByTimeAsync(199);
      flushSolid();
      expect(list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      expect(list).toHaveBeenCalledOnce();
      const firstSignal = list.mock.calls[0]![0]!.signal!;

      search.value = 'second';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
      expect(firstSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(199);
      flushSolid();
      expect(list).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      flushSolid();
      expect(list).toHaveBeenCalledTimes(2);

      second.resolve({
        items: [session('current-result', 2, { title: 'Current result' })],
        hasMore: false,
      });
      flushSolid();
      await vi.advanceTimersByTimeAsync(0);
      flushSolid();
      expect(container.querySelector('.session-item-title-text')?.textContent).toBe(
        'Current result'
      );

      first.resolve({
        items: [session('stale-result', 1, { title: 'Stale result' })],
        hasMore: false,
      });
      flushSolid();
      await vi.advanceTimersByTimeAsync(0);
      flushSolid();
      expect(container.querySelector('.session-item-title-text')?.textContent).toBe(
        'Current result'
      );

      search.value = 'cancelled';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
      container.querySelector<HTMLButtonElement>('.session-list-search-clear')!.click();
      flushSolid();
      await vi.advanceTimersByTimeAsync(200);
      flushSolid();
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      cleanup?.();
      flushSolid();
      cleanup = undefined;
      restoreRealTimers();
      flushSolid();
    }
  });

  it('resolves paginated sub-agents without adding archive sessions to loaded state', async () => {
    const now = Date.now();
    const loadedSessions = [
      session('parent', now, { directory: '/repo-a' }),
      session('loaded-child', now - 1, { parentID: 'parent', directory: '/repo-a' }),
    ];
    const unrelatedArchiveSession = session('unrelated-archive', now - 30 * 86_400_000);
    const paginatedChild = session('paginated-child', now - 2, {
      parentID: 'parent',
      directory: '/repo-b',
    });
    vi.spyOn(client.session, 'list')
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [...loadedSessions, unrelatedArchiveSession, paginatedChild],
        hasMore: false,
      });
    setState(storePath('sessions', loadedSessions));
    flushSolid();
    setState(storePath('sessionsHasMore', true));
    flushSolid();
    setState(
      storePath('editorContext', {
        workspacePath: '/repo-a',
        workspaceFolders: [
          { name: 'Repo A', path: '/repo-a' },
          { name: 'Repo B', path: '/repo-b' },
        ],
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();

    cleanup = render(() => <SessionListView subagentParentId="parent" />, container);
    flushSolid();

    await vi.waitFor(() => {
      expect(
        Array.from(container.querySelectorAll('.session-item-title-text')).map(
          (element) => element.textContent
        )
      ).toEqual(['loaded-child', 'paginated-child']);
    });
    flushSolid();
    const selector = container.querySelector('.session-list-workspace-selector');
    selector?.querySelector<HTMLButtonElement>('.workspace-picker-button')?.click();
    flushSolid();
    selector?.querySelector<HTMLButtonElement>('[data-workspace-path="/repo-b"]')?.click();
    flushSolid();
    expect(
      Array.from(container.querySelectorAll('.session-item-title-text')).map(
        (element) => element.textContent
      )
    ).toEqual(['paginated-child']);
    expect(client.session.list).toHaveBeenNthCalledWith(1, {
      limit: 100,
      signal: expect.any(AbortSignal),
    });
    expect(client.session.list).toHaveBeenNthCalledWith(2, {
      limit: 200,
      signal: expect.any(AbortSignal),
    });
    expect(client.session.list).toHaveBeenNthCalledWith(3, {
      limit: 400,
      signal: expect.any(AbortSignal),
    });
    expect(client.session.list).toHaveBeenNthCalledWith(4, {
      limit: 800,
      signal: expect.any(AbortSignal),
    });
    expect(loadMoreSessionsMock).not.toHaveBeenCalled();
    expect(container.querySelector('.session-list-continuation')).toBeNull();
    expect(container.textContent).not.toContain('unrelated-archive');
    expect(appState.sessions).toEqual(loadedSessions);
  });

  it('shows a retryable error instead of the empty state when sessions fail to load', async () => {
    setState(storePath('sessionsLoadError', 'Failed to load sessions'));
    flushSolid();
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    const errorRow = container.querySelector('.session-load-error');
    expect(errorRow?.textContent).toContain('Failed to load sessions');
    expect(container.textContent).not.toContain('No sessions yet');

    const retry = errorRow?.querySelector<HTMLButtonElement>('.session-load-error-retry');
    expect(retry).not.toBeNull();
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() => expect(reloadSessionsMock).toHaveBeenCalledTimes(1));
    flushSolid();
  });

  it('keeps the empty state when sessions load fine', () => {
    cleanup = render(() => <SessionListView />, container);
    flushSolid();

    expect(container.querySelector('.session-load-error')).toBeNull();
    expect(container.textContent).toContain('No sessions yet');
  });
});
