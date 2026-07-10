import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionMessageSyncCoordinator,
  registerEventStreamRecoveryEffect,
  registerLoadingStatusPollEffect,
  registerProviderLimitRefreshEffect,
  registerVisibleRunningSessionSyncEffect,
} from './session/session-effects';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('session effect helpers', () => {
  it('polls active session status while loading and visible', async () => {
    vi.useFakeTimers();
    const [loading] = createSignal(true);
    const [activeSessionId] = createSignal<string | null>('session-1');
    const [visible] = createSignal(true);
    const recheckSessionStatus = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: loading,
        getActiveSessionId: activeSessionId,
        isDocumentVisible: visible,
        getEventStreamState: () => 'degraded',
        recheckSessionStatus,
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
      expect(recheckSessionStatus).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('does not overlap loading status polls while a recheck is in flight', async () => {
    vi.useFakeTimers();
    const pendingRecheck = deferred<void>();
    const recheckSessionStatus = vi.fn(() => pendingRecheck.promise);

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: () => true,
        getActiveSessionId: () => 'session-1',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        recheckSessionStatus,
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(1);

      pendingRecheck.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('backs off loading status polls while the event stream is healthy', async () => {
    vi.useFakeTimers();
    const recheckSessionStatus = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: () => true,
        getActiveSessionId: () => 'session-1',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'healthy',
        recheckSessionStatus,
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(3_999);
      expect(recheckSessionStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('returns to frequent polling when the event stream degrades', async () => {
    vi.useFakeTimers();
    const [eventStreamState, setEventStreamState] = createSignal<'healthy' | 'degraded'>('healthy');
    const recheckSessionStatus = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: () => true,
        getActiveSessionId: () => 'session-1',
        isDocumentVisible: () => true,
        getEventStreamState: eventStreamState,
        recheckSessionStatus,
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(3_999);
      expect(recheckSessionStatus).not.toHaveBeenCalled();

      setEventStreamState('degraded');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(recheckSessionStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(recheckSessionStatus).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('reconciles visible running sessions and active messages', async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => {});
    const hydrateSessionStatuses = vi.fn(async () => {});
    const loadQuestions = vi.fn(async () => {});
    const loadPendingPermissions = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: () => ({ 'session-1': { type: 'busy' } }),
        loadSessions,
        hydrateSessionStatuses,
        loadQuestions,
        loadPendingPermissions,
        syncSessionMessages,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(4000);
      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(loadQuestions).toHaveBeenCalledTimes(1);
      expect(loadPendingPermissions).toHaveBeenCalledTimes(1);
      expect(syncSessionMessages).toHaveBeenCalledWith('session-1');

      await vi.advanceTimersByTimeAsync(4000);
      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(2);
      expect(loadSessions).toHaveBeenCalledTimes(2);
      expect(loadQuestions).toHaveBeenCalledTimes(2);
      expect(loadPendingPermissions).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('syncs inactive running session messages so stale spinners can settle', async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => {});
    const hydrateSessionStatuses = vi.fn(async () => {});
    const loadQuestions = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: () => ({
          'session-1': { type: 'busy' },
          'session-2': { type: 'busy' },
        }),
        loadSessions,
        hydrateSessionStatuses,
        loadQuestions,
        syncSessionMessages,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(4000);

      expect(syncSessionMessages).toHaveBeenNthCalledWith(1, 'session-1');
      expect(syncSessionMessages).toHaveBeenNthCalledWith(2, 'session-2');
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('does not restart running-session sync when running ids are unchanged', async () => {
    vi.useFakeTimers();
    const [statuses, setStatuses] = createSignal({ 'session-1': { type: 'busy' as const } });
    const loadSessions = vi.fn(async () => {});
    const hydrateSessionStatuses = vi.fn(async () => {});
    const loadQuestions = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: statuses,
        loadSessions,
        hydrateSessionStatuses,
        loadQuestions,
        syncSessionMessages,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(4000);
      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);

      setStatuses({ 'session-1': { type: 'busy' } });
      await Promise.resolve();
      await Promise.resolve();

      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(syncSessionMessages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4000);

      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(2);
      expect(loadSessions).toHaveBeenCalledTimes(2);
      expect(syncSessionMessages).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes visible session state even when no session is marked running', async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => {});
    const hydrateSessionStatuses = vi.fn(async () => {});
    const loadQuestions = vi.fn(async () => {});
    const syncSessionMessages = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: () => ({}),
        loadSessions,
        hydrateSessionStatuses,
        loadQuestions,
        syncSessionMessages,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(4000);
      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(loadQuestions).toHaveBeenCalledTimes(1);
      expect(syncSessionMessages).not.toHaveBeenCalled();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('uses the running-session sync as a low-frequency safety net for a healthy stream', async () => {
    vi.useFakeTimers();
    const hydrateSessionStatuses = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'healthy',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: () => ({ 'session-1': { type: 'busy' } }),
        loadSessions: vi.fn(async () => {}),
        hydrateSessionStatuses,
        loadQuestions: vi.fn(async () => {}),
        syncSessionMessages: vi.fn(async () => {}),
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(15_999);
      expect(hydrateSessionStatuses).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hydrateSessionStatuses).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('does not duplicate active message sync when loading and running polls share a cycle', async () => {
    vi.useFakeTimers();
    const loadMessages = vi.fn(async () => {});
    const messageSync = createSessionMessageSyncCoordinator(loadMessages);
    const recheckSessionStatus = vi.fn(async () => {
      if (Date.now() >= 4_000) await messageSync.syncIfStale('session-1');
    });

    const dispose = createRoot((cleanup) => {
      registerLoadingStatusPollEffect({
        isLoading: () => true,
        getActiveSessionId: () => 'session-1',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        recheckSessionStatus,
      });
      registerVisibleRunningSessionSyncEffect({
        getServerState: () => 'running',
        isDocumentVisible: () => true,
        getEventStreamState: () => 'degraded',
        getActiveSessionId: () => 'session-1',
        getSessionStatuses: () => ({ 'session-1': { type: 'busy' } }),
        loadSessions: vi.fn(async () => {}),
        hydrateSessionStatuses: vi.fn(async () => {}),
        loadQuestions: vi.fn(async () => {}),
        syncSessionMessages: messageSync.syncIfStale,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await vi.advanceTimersByTimeAsync(4_000);

      expect(recheckSessionStatus).toHaveBeenCalledTimes(4);
      expect(loadMessages).toHaveBeenCalledTimes(1);
      expect(loadMessages).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('does not mark an unapplied message response as fresh', async () => {
    vi.useFakeTimers();
    const loadMessages = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const messageSync = createSessionMessageSyncCoordinator(loadMessages);

    try {
      await messageSync.syncIfStale('session-1');
      await messageSync.syncIfStale('session-1');

      expect(loadMessages).toHaveBeenCalledTimes(2);

      await messageSync.syncIfStale('session-1');
      expect(loadMessages).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one trailing refresh before forced callers behind an active poll resolve', async () => {
    vi.useFakeTimers();
    const staleRequest = deferred<void>();
    const freshRequest = deferred<void>();
    const loadMessages = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(freshRequest.promise);
    const messageSync = createSessionMessageSyncCoordinator(loadMessages);

    try {
      const poll = messageSync.syncIfStale('session-1');
      await Promise.resolve();
      expect(loadMessages).toHaveBeenCalledTimes(1);

      let forcedCallersSettled = false;
      const forced = Promise.all([
        messageSync.sync('session-1'),
        messageSync.sync('session-1'),
      ]).then(() => {
        forcedCallersSettled = true;
      });

      staleRequest.resolve();
      await poll;
      await Promise.resolve();
      await Promise.resolve();

      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(forcedCallersSettled).toBe(false);

      freshRequest.resolve();
      await forced;

      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(forcedCallersSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one trailing refresh for forced callers arriving during an active forced sync', async () => {
    vi.useFakeTimers();
    const staleRequest = deferred<void>();
    const freshRequest = deferred<void>();
    const loadMessages = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(freshRequest.promise);
    const messageSync = createSessionMessageSyncCoordinator(loadMessages);

    try {
      const firstForced = messageSync.sync('session-1');
      await Promise.resolve();
      expect(loadMessages).toHaveBeenCalledTimes(1);

      let trailingCallersSettled = false;
      const trailingForced = Promise.all([
        messageSync.sync('session-1'),
        messageSync.sync('session-1'),
      ]).then(() => {
        trailingCallersSettled = true;
      });

      staleRequest.resolve();
      await firstForced;
      await Promise.resolve();
      await Promise.resolve();

      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(trailingCallersSettled).toBe(false);

      freshRequest.resolve();
      await trailingForced;

      expect(loadMessages).toHaveBeenCalledTimes(2);
      expect(trailingCallersSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks active session status when the event stream recovers from degraded while loading', async () => {
    const [eventStreamState, setEventStreamState] = createSignal<
      'healthy' | 'degraded' | undefined
    >('healthy');
    const recheckSessionStatus = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerEventStreamRecoveryEffect({
        getEventStreamState: eventStreamState,
        isLoading: () => true,
        getActiveSessionId: () => 'session-1',
        recheckSessionStatus,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      setEventStreamState('degraded');
      await Promise.resolve();
      expect(recheckSessionStatus).not.toHaveBeenCalled();

      setEventStreamState('healthy');
      await Promise.resolve();

      expect(recheckSessionStatus).toHaveBeenCalledWith('session-1');
    } finally {
      dispose();
    }
  });

  it('does not recheck when the event stream recovers but no session is loading', async () => {
    const [eventStreamState, setEventStreamState] = createSignal<
      'healthy' | 'degraded' | undefined
    >('degraded');
    const recheckSessionStatus = vi.fn(async () => {});

    const dispose = createRoot((cleanup) => {
      registerEventStreamRecoveryEffect({
        getEventStreamState: eventStreamState,
        isLoading: () => false,
        getActiveSessionId: () => 'session-1',
        recheckSessionStatus,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      setEventStreamState('healthy');
      await Promise.resolve();

      expect(recheckSessionStatus).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('refreshes provider limits immediately and skips unsupported models', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);
    const setProviderLimit = vi.fn();

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit,
        getPollIntervalMs: () => 120_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
      expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o', null);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('refreshes provider limits even when the current model was previously unsupported', async () => {
    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => ({
          providerID: 'openai',
          modelID: 'gpt-4o',
          status: 'unsupported',
          source: 'provider',
          checkedAt: 1,
          note: 'Unsupported',
        }),
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => 120_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
    }
  });

  it('keeps polling provider limits after an unsupported result', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => ({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      status: 'unsupported' as const,
      source: 'provider' as const,
      checkedAt: 1,
      note: 'Temporary unsupported state',
    }));
    let currentLimit: {
      providerID: string;
      modelID: string;
      status: 'unsupported';
      source: 'provider';
      checkedAt: number;
      note: string;
    } | null = null;
    const setProviderLimit = vi.fn((_, __, limit) => {
      currentLimit = limit;
    });

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'anthropic', modelID: 'claude-sonnet-4' }),
        getProviderLimit: () => currentLimit,
        loadProviderLimit,
        setProviderLimit,
        getPollIntervalMs: () => 30_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledTimes(2);
      expect(setProviderLimit).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('refreshes provider limits for the active Ralph model when it differs from the composer model', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);
    const setProviderLimit = vi.fn();

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-5' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit,
        getPollIntervalMs: () => 120_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5');
      expect(setProviderLimit).toHaveBeenCalledWith('openai', 'gpt-5', null);
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('uses the configured provider-limit refresh interval', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => 30_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      loadProviderLimit.mockClear();

      vi.advanceTimersByTime(29_999);
      expect(loadProviderLimit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('does not refresh provider limits when polling is disabled', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => false,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => -1,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(300_000);
      expect(loadProviderLimit).not.toHaveBeenCalled();
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('polls provider limits more often while sessions are active on the default interval', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => 120_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      loadProviderLimit.mockClear();

      vi.advanceTimersByTime(29_999);
      expect(loadProviderLimit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it('keeps a custom provider-limit refresh interval even while sessions are active', async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });

    const loadProviderLimit = vi.fn(async () => null);

    const dispose = createRoot((cleanup) => {
      registerProviderLimitRefreshEffect({
        getServerState: () => 'running',
        areProvidersLoaded: () => true,
        isDocumentVisible: () => true,
        isActiveSessionWorking: () => true,
        getActiveProviderSelection: () => ({ providerID: 'openai', modelID: 'gpt-4o' }),
        getProviderLimit: () => null,
        loadProviderLimit,
        setProviderLimit: vi.fn(),
        getPollIntervalMs: () => 45_000,
        logError: vi.fn(),
      });
      return cleanup;
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      loadProviderLimit.mockClear();

      vi.advanceTimersByTime(44_999);
      expect(loadProviderLimit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(loadProviderLimit).toHaveBeenCalledWith('openai', 'gpt-4o');
    } finally {
      dispose();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });
});
