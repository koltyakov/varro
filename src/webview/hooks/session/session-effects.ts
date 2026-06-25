import { createEffect, createMemo, on, onCleanup } from 'solid-js';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';
import type { SessionStatus } from '../../types';

type ProviderSelection = { providerID: string; modelID?: string | null };

const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_MS = DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS * 1000;
const ACTIVE_SESSION_PROVIDER_LIMIT_POLL_INTERVAL_MS = 30_000;
const LOADING_STATUS_POLL_MS = 1_000;
const RUNNING_SESSION_SYNC_INTERVAL_MS = 4_000;
const RUNNING_SESSION_SYNC_KEY_SEPARATOR = '\u0000';

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
  recheckSessionStatus(sessionId: string): void;
}) {
  createEffect(() => {
    const loading = deps.isLoading();
    const sessionId = deps.getActiveSessionId();
    const visible = deps.isDocumentVisible();
    if (!loading || !sessionId || !visible) return;

    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      const activeSessionId = deps.getActiveSessionId();
      if (!deps.isLoading() || !activeSessionId || !deps.isDocumentVisible()) return;
      inFlight = true;
      try {
        void Promise.resolve(deps.recheckSessionStatus(activeSessionId)).finally(() => {
          inFlight = false;
        });
      } catch (err) {
        inFlight = false;
        throw err;
      }
    };
    const timer = window.setInterval(poll, LOADING_STATUS_POLL_MS);

    onCleanup(() => window.clearInterval(timer));
  });
}

export function registerEventStreamRecoveryEffect(deps: {
  getEventStreamState(): 'healthy' | 'degraded' | undefined;
  isLoading(): boolean;
  getActiveSessionId(): string | null;
  recheckSessionStatus(sessionId: string): void;
  logError(context: string, err: unknown): void;
}) {
  createEffect(
    on(deps.getEventStreamState, (current, previous) => {
      if (previous !== 'degraded' || current !== 'healthy') return;
      const sessionId = deps.getActiveSessionId();
      if (!sessionId || !deps.isLoading()) return;
      deps.recheckSessionStatus(sessionId);
    })
  );
}

export function registerVisibleRunningSessionSyncEffect(deps: {
  getServerState(): string;
  isDocumentVisible(): boolean;
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
    const statuses = deps.getSessionStatuses();
    const runningIds = Object.entries(statuses)
      .filter(([, status]) => status?.type === 'busy' || status?.type === 'retry')
      .map(([sessionId]) => sessionId)
      .toSorted();
    const activeSessionId = deps.getActiveSessionId();
    const activeRunningSessionId =
      activeSessionId && runningIds.includes(activeSessionId) ? activeSessionId : '';
    return `${runningIds.join('\n')}${RUNNING_SESSION_SYNC_KEY_SEPARATOR}${activeRunningSessionId}`;
  });

  createEffect(
    on(syncTarget, (target) => {
      if (!target) return;
      const [runningSessionIdsText = '', activeRunningSessionId = ''] = target.split(
        RUNNING_SESSION_SYNC_KEY_SEPARATOR,
        2
      );
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
      let inFlight = false;
      const refresh = async () => {
        if (cancelled || inFlight || !deps.isDocumentVisible()) return;
        inFlight = true;
        try {
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
        } finally {
          inFlight = false;
        }
      };

      const timer = window.setInterval(() => {
        void refresh();
      }, RUNNING_SESSION_SYNC_INTERVAL_MS);

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
