import { createEffect, on, onCleanup } from 'solid-js';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';

type ProviderSelection = { providerID: string; modelID?: string | null };

const DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_MS = DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS * 1000;
const ACTIVE_SESSION_PROVIDER_LIMIT_POLL_INTERVAL_MS = 30_000;

function resolveProviderLimitPollIntervalMs(baseIntervalMs: number, hasActiveSessions: boolean) {
  if (!hasActiveSessions || baseIntervalMs !== DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_MS) {
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

    let delay = 8000;
    const schedulePoll = () => {
      return setTimeout(() => {
        const activeSessionId = deps.getActiveSessionId();
        if (!deps.isLoading() || !activeSessionId || !deps.isDocumentVisible()) return;
        deps.recheckSessionStatus(activeSessionId);
        delay = Math.min(delay * 2, 60_000);
        timer = schedulePoll();
      }, delay);
    };
    let timer = schedulePoll();

    onCleanup(() => clearTimeout(timer));
  });
}

export function registerProviderLimitRefreshEffect(deps: {
  getServerState(): string;
  areProvidersLoaded(): boolean;
  isDocumentVisible(): boolean;
  hasActiveSessions(): boolean;
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
            deps.hasActiveSessions()
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
