import { createEffect, createMemo, on, onCleanup } from 'solid-js';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';
import type { SessionStatus } from '../../types';

type ProviderSelection = { providerID: string; modelID?: string | null };

const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_MS = DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS * 1000;
const ACTIVE_SESSION_PROVIDER_LIMIT_POLL_INTERVAL_MS = 30_000;
const DEGRADED_LOADING_STATUS_POLL_MS = 1_000;
const HEALTHY_LOADING_STATUS_POLL_INITIAL_MS = 4_000;
const HEALTHY_LOADING_STATUS_POLL_MAX_MS = 16_000;
const DEGRADED_RUNNING_SESSION_SYNC_INTERVAL_MS = 4_000;
const HEALTHY_RUNNING_SESSION_SYNC_INTERVAL_MS = 16_000;
const MESSAGE_SYNC_FRESHNESS_MS = 4_000;
const RUNNING_SESSION_SYNC_KEY_SEPARATOR = '\u0000';

type EventStreamState = 'healthy' | 'degraded' | undefined;

export function createSessionMessageSyncCoordinator(
  syncSessionMessages: (sessionId: string) => Promise<boolean | void>,
  freshnessMs = MESSAGE_SYNC_FRESHNESS_MS
) {
  type ForceWaiter = {
    generation: number;
    resolve(): void;
    reject(reason: unknown): void;
  };
  type SessionSyncState = {
    active: Promise<boolean | void> | null;
    requestedForceGeneration: number;
    lastCompletedAt?: number;
    forceWaiters: ForceWaiter[];
  };

  const states = new Map<string, SessionSyncState>();
  const getState = (sessionId: string) => {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        active: null,
        requestedForceGeneration: 0,
        forceWaiters: [],
      };
      states.set(sessionId, state);
    }
    return state;
  };

  const takeForceWaiters = (state: SessionSyncState, throughGeneration: number) => {
    const settled: ForceWaiter[] = [];
    const remaining: ForceWaiter[] = [];
    for (const waiter of state.forceWaiters) {
      (waiter.generation <= throughGeneration ? settled : remaining).push(waiter);
    }
    state.forceWaiters = remaining;
    return settled;
  };

  const startRequest = (
    sessionId: string,
    state: SessionSyncState,
    forceGeneration: number
  ): Promise<boolean | void> => {
    const request = Promise.resolve().then(() => syncSessionMessages(sessionId));
    state.active = request;

    const finish = () => {
      if (state.active !== request) return;
      state.active = null;
      if (state.requestedForceGeneration > forceGeneration) {
        void startRequest(sessionId, state, state.requestedForceGeneration);
      }
    };
    void request.then(
      (applied) => {
        if (applied !== false && forceGeneration >= state.requestedForceGeneration) {
          state.lastCompletedAt = Date.now();
        }
        for (const waiter of takeForceWaiters(state, forceGeneration)) waiter.resolve();
        finish();
      },
      (reason: unknown) => {
        for (const waiter of takeForceWaiters(state, forceGeneration)) waiter.reject(reason);
        finish();
      }
    );
    return request;
  };

  const sync = (sessionId: string): Promise<void> => {
    const state = getState(sessionId);
    state.lastCompletedAt = undefined;
    const generation = ++state.requestedForceGeneration;
    const result = new Promise<void>((resolve, reject) => {
      state.forceWaiters.push({ generation, resolve: () => resolve(), reject });
    });
    if (!state.active) void startRequest(sessionId, state, generation);
    return result;
  };

  const syncIfStale = (sessionId: string): Promise<void> => {
    const state = getState(sessionId);
    if (state.active) return state.active.then(() => undefined);
    const completedAt = state.lastCompletedAt;
    if (completedAt !== undefined && Date.now() - completedAt < freshnessMs) {
      return Promise.resolve();
    }
    return startRequest(sessionId, state, state.requestedForceGeneration).then(() => undefined);
  };

  return { sync, syncIfStale };
}

function resolveProviderLimitPollIntervalMs(
  baseIntervalMs: number,
  isActiveSessionWorking: boolean
) {
  if (!isActiveSessionWorking || baseIntervalMs !== DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_MS) {
    return baseIntervalMs;
  }

  return ACTIVE_SESSION_PROVIDER_LIMIT_POLL_INTERVAL_MS;
}

export function registerLoadingStatusPollEffect(deps: {
  isLoading(): boolean;
  getActiveSessionId(): string | null;
  isDocumentVisible(): boolean;
  getEventStreamState(): EventStreamState;
  recheckSessionStatus(sessionId: string): Promise<void>;
  logError?(context: string, err: unknown): void;
}) {
  const inFlight = new Map<string, Promise<void>>();
  const recheck = (sessionId: string): Promise<void> => {
    const existing = inFlight.get(sessionId);
    if (existing) return existing;

    const request = Promise.resolve().then(() => deps.recheckSessionStatus(sessionId));
    const tracked = request.finally(() => {
      inFlight.delete(sessionId);
    });
    inFlight.set(sessionId, tracked);
    return tracked;
  };

  createEffect(() => {
    const loading = deps.isLoading();
    const sessionId = deps.getActiveSessionId();
    const visible = deps.isDocumentVisible();
    const eventStreamState = deps.getEventStreamState();
    if (!loading || !sessionId || !visible) return;

    let cancelled = false;
    let timer: number | undefined;
    let nextDelay =
      eventStreamState === 'healthy'
        ? HEALTHY_LOADING_STATUS_POLL_INITIAL_MS
        : DEGRADED_LOADING_STATUS_POLL_MS;
    const schedule = () => {
      timer = window.setTimeout(() => {
        void poll();
      }, nextDelay);
    };
    const poll = async () => {
      const activeSessionId = deps.getActiveSessionId();
      if (cancelled || !deps.isLoading() || !activeSessionId || !deps.isDocumentVisible()) return;
      try {
        await recheck(activeSessionId);
      } catch (err) {
        deps.logError?.('loadingStatusPoll', err);
      }
      if (cancelled) return;
      if (eventStreamState === 'healthy') {
        nextDelay = Math.min(nextDelay * 2, HEALTHY_LOADING_STATUS_POLL_MAX_MS);
      }
      schedule();
    };
    schedule();

    onCleanup(() => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    });
  });
}

export function registerEventStreamRecoveryEffect(deps: {
  getEventStreamState(): EventStreamState;
  isLoading(): boolean;
  getActiveSessionId(): string | null;
  recheckSessionStatus(sessionId: string): Promise<void>;
  logError(context: string, err: unknown): void;
}) {
  createEffect(
    on(deps.getEventStreamState, (current, previous) => {
      if (previous !== 'degraded' || current !== 'healthy') return;
      const sessionId = deps.getActiveSessionId();
      if (!sessionId || !deps.isLoading()) return;
      void deps
        .recheckSessionStatus(sessionId)
        .catch((err) => deps.logError('eventStreamRecovery', err));
    })
  );
}

export function registerVisibleRunningSessionSyncEffect(deps: {
  getServerState(): string;
  isDocumentVisible(): boolean;
  getEventStreamState(): EventStreamState;
  getActiveSessionId(): string | null;
  getSessionStatuses(): Record<string, SessionStatus>;
  loadSessions(): Promise<void>;
  hydrateSessionStatuses(): Promise<void>;
  loadQuestions(): Promise<void>;
  loadPendingPermissions?(): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  logError(context: string, err: unknown): void;
}) {
  const syncTarget = createMemo(() => {
    if (deps.getServerState() !== 'running' || !deps.isDocumentVisible()) return null;
    const eventStreamState = deps.getEventStreamState();
    const statuses = deps.getSessionStatuses();
    const runningIds = Object.entries(statuses)
      .filter(([, status]) => status?.type === 'busy' || status?.type === 'retry')
      .map(([sessionId]) => sessionId)
      .toSorted();
    const activeSessionId = deps.getActiveSessionId();
    const activeRunningSessionId =
      activeSessionId && runningIds.includes(activeSessionId) ? activeSessionId : '';
    return `${runningIds.join('\n')}${RUNNING_SESSION_SYNC_KEY_SEPARATOR}${activeRunningSessionId}${RUNNING_SESSION_SYNC_KEY_SEPARATOR}${eventStreamState === 'healthy' ? 'healthy' : 'degraded'}`;
  });

  let refreshInFlight: Promise<void> | null = null;
  createEffect(
    on(syncTarget, (target) => {
      if (!target) return;
      const [runningSessionIdsText = '', activeRunningSessionId = '', eventStreamState] =
        target.split(RUNNING_SESSION_SYNC_KEY_SEPARATOR, 3);
      const runningSessionIds = runningSessionIdsText
        .split('\n')
        .filter((sessionId) => sessionId.length > 0);
      const messageSyncSessionIds = activeRunningSessionId
        ? [
            activeRunningSessionId,
            ...runningSessionIds.filter((sessionId) => sessionId !== activeRunningSessionId),
          ]
        : runningSessionIds;

      let cancelled = false;
      const refresh = (): Promise<void> => {
        if (cancelled || !deps.isDocumentVisible()) return Promise.resolve();
        if (refreshInFlight) return refreshInFlight;

        const tracked = (async () => {
          const results: PromiseSettledResult<void>[] = [];
          results.push(await settleVoid(deps.hydrateSessionStatuses()));
          results.push(await settleVoid(deps.loadSessions()));
          results.push(await settleVoid(deps.loadQuestions()));
          if (deps.loadPendingPermissions) {
            results.push(await settleVoid(deps.loadPendingPermissions()));
          }
          for (const sessionId of messageSyncSessionIds) {
            results.push(await settleVoid(deps.syncSessionMessages(sessionId)));
          }
          for (const result of results) {
            if (result.status === 'rejected') {
              deps.logError('runningSessionSync', result.reason);
            }
          }
        })().finally(() => {
          refreshInFlight = null;
        });
        refreshInFlight = tracked;
        return tracked;
      };

      const timer = window.setInterval(
        () => {
          void refresh().catch((err) => deps.logError('runningSessionSync', err));
        },
        eventStreamState === 'healthy'
          ? HEALTHY_RUNNING_SESSION_SYNC_INTERVAL_MS
          : DEGRADED_RUNNING_SESSION_SYNC_INTERVAL_MS
      );

      onCleanup(() => {
        cancelled = true;
        window.clearInterval(timer);
      });
    })
  );
}

async function settleVoid(promise: Promise<void>): Promise<PromiseSettledResult<void>> {
  try {
    await promise;
    return { status: 'fulfilled', value: undefined };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

export function registerProviderLimitRefreshEffect(deps: {
  getServerState(): string;
  areProvidersLoaded(): boolean;
  isDocumentVisible(): boolean;
  isActiveSessionWorking(): boolean;
  getActiveProviderSelection(): ProviderSelection | null;
  getProviderLimit(
    providerID: string,
    modelID?: string | null
  ): ProviderLimitStatus | null | undefined;
  loadProviderLimit(
    providerID: string,
    modelID?: string | null
  ): Promise<ProviderLimitStatus | null>;
  setProviderLimit(
    providerID: string,
    modelID: string | null | undefined,
    limit: ProviderLimitStatus | null
  ): void;
  getPollIntervalMs(): number;
  logError(context: string, err: unknown): void;
}) {
  createEffect(
    on(
      () => {
        const visible = deps.isDocumentVisible();
        if (deps.getServerState() !== 'running' || !deps.areProvidersLoaded() || !visible)
          return null;
        const pollIntervalMs = deps.getPollIntervalMs();
        if (pollIntervalMs < 0) return null;
        const active = deps.getActiveProviderSelection();
        if (!active) return null;

        return {
          providerID: active.providerID,
          modelID: active.modelID,
          pollIntervalMs: resolveProviderLimitPollIntervalMs(
            pollIntervalMs,
            deps.isActiveSessionWorking()
          ),
        };
      },
      (target) => {
        if (!target) return;

        let cancelled = false;
        let inFlight = false;
        const refresh = async () => {
          if (cancelled || inFlight || !deps.isDocumentVisible()) return;
          inFlight = true;
          try {
            const limit = await deps.loadProviderLimit(target.providerID, target.modelID);
            if (!cancelled) {
              deps.setProviderLimit(target.providerID, target.modelID, limit);
            }
          } catch (err) {
            deps.logError('loadProviderLimit', err);
          } finally {
            inFlight = false;
          }
        };

        void refresh();
        const timer = window.setInterval(() => {
          void refresh();
        }, target.pollIntervalMs);

        onCleanup(() => {
          cancelled = true;
          window.clearInterval(timer);
        });
      }
    )
  );
}
