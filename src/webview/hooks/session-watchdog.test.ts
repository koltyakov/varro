import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { Message, Part, SessionStatus } from '../types';
import {
  forceReconcileIdleSessionWithDependencies,
  hasLocalEvidenceTurnDone,
  hasStreamedFinalResponse,
  reconcileStuckSessionsWithDependencies,
  registerStuckSessionWatchdogEffect,
  selectUnsettledLatestAssistant,
  STUCK_SESSION_GRACE_MS,
  STUCK_SESSION_WATCHDOG_INTERVAL_MS,
} from './session/session-watchdog';

type MessageEntry = { info: Message; parts: Part[] };

function assistant(id: string, sessionID: string, overrides: Partial<Message> = {}): MessageEntry {
  return {
    info: {
      id,
      sessionID,
      role: 'assistant',
      time: { created: 1 },
      ...overrides,
    } as Message,
    parts: [],
  };
}

function user(id: string, sessionID: string): MessageEntry {
  return {
    info: { id, sessionID, role: 'user', time: { created: 1 } } as Message,
    parts: [],
  };
}

function baseReconcileDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadSessionStatuses: vi.fn(async () => ({}) as Record<string, SessionStatus>),
    getLocalSessionStatuses: vi.fn(() => ({}) as Record<string, SessionStatus>),
    getActiveSessionId: vi.fn(() => null as string | null),
    isLoading: vi.fn(() => false),
    isAwaitingInput: vi.fn(() => false),
    hasPendingAbort: vi.fn(() => false),
    forceReconcileIdleSession: vi.fn(async () => {}),
    logError: vi.fn(),
    getMessages: vi.fn(() => [] as MessageEntry[]),
    getStreamingText: vi.fn(() => ({ partId: null, text: '' })),
    ...overrides,
  };
}

describe('reconcileStuckSessionsWithDependencies', () => {
  it('does not poll the server when nothing is locally busy', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'idle' } }) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.loadSessionStatuses).not.toHaveBeenCalled();
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
  });

  it('waits for the grace window before force-reconciling a stuck session', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();

    // First observation: server idle but UI busy -> start grace timer, no action.
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.get('s1')).toBe(1000);

    // Still within grace.
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS - 1);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();

    // Grace elapsed -> reconcile and clear the timer.
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
    expect(timers.has('s1')).toBe(false);
  });

  it('clears the timer when the server reports the session still busy', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      loadSessionStatuses: async () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>([['s1', 1]]);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.has('s1')).toBe(false);
  });

  it('never settles sessions awaiting input or pending abort', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () =>
        ({ s1: { type: 'busy' }, s2: { type: 'busy' } }) as Record<string, SessionStatus>,
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
      isAwaitingInput: (id: string) => id === 's1',
      hasPendingAbort: (id: string) => id === 's2',
    });
    const timers = new Map<string, number>([
      ['s1', 1],
      ['s2', 1],
    ]);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it('treats a retry status as busy and a server error/absence as idle', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () =>
        ({ s1: { type: 'retry', attempt: 1 } }) as unknown as Record<string, SessionStatus>,
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>([['s1', 1]]);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
  });

  it('keeps the grace timer when the status poll throws', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      loadSessionStatuses: async () => {
        throw new Error('network down');
      },
    });
    const timers = new Map<string, number>([['s1', 1]]);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith('stuckSessionWatchdog', expect.any(Error));
    expect(timers.get('s1')).toBe(1);
  });

  it('recovers an orphaned loading flag for the active session even with no busy status', async () => {
    // Completion event was missed: the session status is idle, but the global
    // loading flag (which drives the "Thinking..." spinner) is still on.
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'idle' } }) as Record<string, SessionStatus>,
      getActiveSessionId: () => 's1',
      isLoading: () => true,
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();

    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.get('s1')).toBe(1000);

    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
  });

  it('does not treat the active session as stuck when the loading flag clears', async () => {
    const loadSessionStatuses = vi.fn(async () => ({}) as Record<string, SessionStatus>);
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'idle' } }) as Record<string, SessionStatus>,
      getActiveSessionId: () => 's1',
      isLoading: () => false,
      loadSessionStatuses,
    });
    const timers = new Map<string, number>([['s1', 1]]);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(loadSessionStatuses).not.toHaveBeenCalled();
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it('reconciles on the first server-idle poll when the final response streamed', async () => {
    const streamed = assistant('a1', 's1');
    streamed.parts = [textPart('t1', 's1', 'The full final answer.')];
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      getMessages: () => [streamed],
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    // First poll: server idle + streamed evidence -> reconcile at once, no grace wait.
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
    expect(timers.has('s1')).toBe(false);
  });

  it('still waits for the grace window when only a busy status is stuck (no streamed text)', async () => {
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      getMessages: () => [],
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.get('s1')).toBe(1000);
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000 + STUCK_SESSION_GRACE_MS);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
  });

  it('does not fast-path when the streamed assistant turn still has a running tool', async () => {
    const streamed = assistant('a1', 's1');
    streamed.parts = [textPart('t1', 's1', 'Working on it.'), toolPart('tool-1', 's1', 'running')];
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      getMessages: () => [streamed],
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).not.toHaveBeenCalled();
    expect(timers.get('s1')).toBe(1000);
  });

  it('fast-paths when text is buffered in streamingText but not yet committed', async () => {
    // The completion event was missed, so the text part is still empty — the
    // streamed text lives in the streaming buffer. This is strong evidence the
    // turn finished and should collapse the grace.
    const streamed = assistant('a1', 's1');
    streamed.parts = [textPart('t1', 's1', '')];
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      getMessages: () => [streamed],
      getStreamingText: () => ({ partId: 't1', text: 'The full final answer.' }),
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
    expect(timers.has('s1')).toBe(false);
  });

  it('fast-paths when the latest assistant message is already completed (missed idle)', async () => {
    // The ping case: message.updated completion arrived and settled the
    // assistant message, but the closing session.status idle was missed, so the
    // session is still locally busy. A settled latest assistant is the strongest
    // local "done" signal — recover on the first server-idle poll instead of
    // waiting out the no-evidence grace.
    const completed = assistant('a1', 's1', { time: { created: 1, completed: 2 } });
    completed.parts = [textPart('t1', 's1', 'Pong.')];
    const deps = baseReconcileDeps({
      getLocalSessionStatuses: () => ({ s1: { type: 'busy' } }) as Record<string, SessionStatus>,
      getMessages: () => [completed],
      loadSessionStatuses: async () => ({}) as Record<string, SessionStatus>,
    });
    const timers = new Map<string, number>();
    await reconcileStuckSessionsWithDependencies(deps, timers, 1000);
    expect(deps.forceReconcileIdleSession).toHaveBeenCalledWith('s1');
    expect(timers.has('s1')).toBe(false);
  });
});

function textPart(id: string, sessionID: string, text: string): Part {
  return { id, sessionID, messageID: 'a1', type: 'text', text } as Part;
}

function toolPart(id: string, sessionID: string, status: 'running' | 'pending'): Part {
  return {
    id,
    sessionID,
    messageID: 'a1',
    type: 'tool',
    callID: id,
    state: { status, input: {} },
  } as unknown as Part;
}

function baseForceDeps(overrides: Record<string, unknown> = {}) {
  return {
    setSessionStatusEntry: vi.fn(),
    clearPendingAbort: vi.fn(),
    updateUsageLimitState: vi.fn(),
    syncSessionMessages: vi.fn(async () => {}),
    settleLatestAssistantMessage: vi.fn(),
    isActiveSession: vi.fn(() => true),
    isTreeWorking: vi.fn(() => false),
    stopLoading: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

describe('forceReconcileIdleSessionWithDependencies', () => {
  it('flips to idle, resyncs, settles, and stops loading', async () => {
    const deps = baseForceDeps();
    await forceReconcileIdleSessionWithDependencies(deps, 's1');
    expect(deps.clearPendingAbort).toHaveBeenCalledWith('s1');
    expect(deps.setSessionStatusEntry).toHaveBeenCalledWith('s1', { type: 'idle' });
    expect(deps.syncSessionMessages).toHaveBeenCalledWith('s1');
    expect(deps.settleLatestAssistantMessage).toHaveBeenCalledWith('s1');
    expect(deps.stopLoading).toHaveBeenCalled();
  });

  it('still converges status when the resync fails', async () => {
    const deps = baseForceDeps({
      syncSessionMessages: async () => {
        throw new Error('boom');
      },
    });
    await forceReconcileIdleSessionWithDependencies(deps, 's1');
    expect(deps.setSessionStatusEntry).toHaveBeenCalledWith('s1', { type: 'idle' });
    expect(deps.settleLatestAssistantMessage).toHaveBeenCalledWith('s1');
    expect(deps.logError).toHaveBeenCalledWith('forceReconcileIdleSync', expect.any(Error));
    expect(deps.stopLoading).toHaveBeenCalled();
  });

  it('does not stop loading when another tree member is still working', async () => {
    const deps = baseForceDeps({ isTreeWorking: () => true });
    await forceReconcileIdleSessionWithDependencies(deps, 's1');
    expect(deps.stopLoading).not.toHaveBeenCalled();
  });

  it('does not stop loading for a non-active session', async () => {
    const deps = baseForceDeps({ isActiveSession: () => false });
    await forceReconcileIdleSessionWithDependencies(deps, 's1');
    expect(deps.stopLoading).not.toHaveBeenCalled();
  });
});

describe('selectUnsettledLatestAssistant', () => {
  it('returns the latest assistant message when it never completed', () => {
    const messages = [user('u1', 's1'), assistant('a1', 's1')];
    expect(selectUnsettledLatestAssistant(messages, 's1')?.id).toBe('a1');
  });

  it('returns null when the latest assistant already completed', () => {
    const messages = [assistant('a1', 's1', { time: { created: 1, completed: 2 } })];
    expect(selectUnsettledLatestAssistant(messages, 's1')).toBeNull();
  });

  it('returns null when the latest assistant errored', () => {
    const messages = [
      assistant('a1', 's1', { error: { name: 'x', data: {} } } as Partial<Message>),
    ];
    expect(selectUnsettledLatestAssistant(messages, 's1')).toBeNull();
  });

  it('returns null when the latest message for the session is a user message', () => {
    const messages = [assistant('a1', 's1'), user('u2', 's1')];
    expect(selectUnsettledLatestAssistant(messages, 's1')).toBeNull();
  });

  it('ignores messages from other sessions', () => {
    const messages = [assistant('a1', 's2'), assistant('a2', 's1')];
    expect(selectUnsettledLatestAssistant(messages, 's1')?.id).toBe('a2');
  });
});

describe('hasStreamedFinalResponse', () => {
  it('is true when the latest unsettled assistant has text and no running tools', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', 'Final answer.')];
    expect(hasStreamedFinalResponse([msg], 's1')).toBe(true);
  });

  it('is false when the latest assistant has completed', () => {
    const msg = assistant('a1', 's1', { time: { created: 1, completed: 2 } });
    msg.parts = [textPart('t1', 's1', 'Final answer.')];
    expect(hasStreamedFinalResponse([msg], 's1')).toBe(false);
  });

  it('is false when there is no finalized text part yet', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', '')];
    expect(hasStreamedFinalResponse([msg], 's1')).toBe(false);
  });

  it('is false when a tool part is still running', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', 'Partial'), toolPart('tool-1', 's1', 'running')];
    expect(hasStreamedFinalResponse([msg], 's1')).toBe(false);
  });

  it('is true when text is only in the streaming buffer (completion event missed)', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', '')];
    expect(hasStreamedFinalResponse([msg], 's1', { partId: 't1', text: 'Buffered answer.' })).toBe(
      true
    );
  });

  it('is false when buffered text belongs to a different part', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', '')];
    expect(
      hasStreamedFinalResponse([msg], 's1', { partId: 'other-part', text: 'Buffered answer.' })
    ).toBe(false);
  });

  it('is false when the latest message is a user turn', () => {
    const messages = [assistant('a1', 's1'), user('u2', 's1')];
    expect(hasStreamedFinalResponse(messages, 's1')).toBe(false);
  });
});

describe('hasLocalEvidenceTurnDone', () => {
  it('is true when the latest assistant is already completed', () => {
    const msg = assistant('a1', 's1', { time: { created: 1, completed: 2 } });
    msg.parts = [textPart('t1', 's1', 'Done.')];
    expect(hasLocalEvidenceTurnDone([msg], 's1')).toBe(true);
  });

  it('is true when the latest assistant errored', () => {
    const msg = assistant('a1', 's1', { error: { name: 'x', data: {} } } as Partial<Message>);
    expect(hasLocalEvidenceTurnDone([msg], 's1')).toBe(true);
  });

  it('is true when the latest assistant streamed final text but is not yet settled', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', 'Streaming done.')];
    expect(hasLocalEvidenceTurnDone([msg], 's1')).toBe(true);
  });

  it('is false when the latest assistant has a tool still running', () => {
    const msg = assistant('a1', 's1');
    msg.parts = [textPart('t1', 's1', 'Working'), toolPart('tool-1', 's1', 'running')];
    expect(hasLocalEvidenceTurnDone([msg], 's1')).toBe(false);
  });

  it('is false when there is no assistant message for the session', () => {
    expect(hasLocalEvidenceTurnDone([], 's1')).toBe(false);
  });
});

describe('registerStuckSessionWatchdogEffect', () => {
  it('polls on an interval only while a session is busy, server running, and visible', async () => {
    vi.useFakeTimers();
    const [busy, setBusy] = createSignal(false);
    const runReconcile = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerStuckSessionWatchdogEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        hasBusySession: busy,
        runReconcile,
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      vi.advanceTimersByTime(STUCK_SESSION_WATCHDOG_INTERVAL_MS);
      expect(runReconcile).not.toHaveBeenCalled();

      setBusy(true);
      await Promise.resolve();
      vi.advanceTimersByTime(STUCK_SESSION_WATCHDOG_INTERVAL_MS);
      expect(runReconcile).toHaveBeenCalledTimes(1);

      setBusy(false);
      await Promise.resolve();
      runReconcile.mockClear();
      vi.advanceTimersByTime(STUCK_SESSION_WATCHDOG_INTERVAL_MS * 3);
      expect(runReconcile).not.toHaveBeenCalled();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});
